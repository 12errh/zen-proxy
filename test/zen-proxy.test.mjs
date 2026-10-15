import { test, describe, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// Must be set before importing the module (CONFIG_PATH is computed at load).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-test-"))
process.env.ZEN_PROXY_CONFIG = path.join(tmpDir, "zen-proxy.json")
delete process.env.PORT
delete process.env.HOST
delete process.env.ZEN_URL
delete process.env.ZEN_UA
delete process.env.DEFAULT_MODEL
delete process.env.PROXY_KEY
delete process.env.ZEN_KEY
delete process.env.FALLBACK_MODELS
delete process.env.MODEL_ALIASES
delete process.env.TRUST_FORWARDED
delete process.env.TIMEOUT_MS
delete process.env.CACHE_MS
delete process.env.AUTO_SYNC
delete process.env.AUTO_SYNC_MS

const zp = await import("../zen-proxy.mjs")
const originalFetch = globalThis.fetch
after(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const MODEL_ID_RE = /^[A-Za-z0-9._:@+/%-]+$/
const DEFAULT_MODEL = zp.config.defaultModel || zp.config.fallbackModels[0] || ""
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
// Git Bash (Windows) mangles backslash paths; forward slashes work everywhere
const toPosix = (p) => p.replace(/\\/g, "/")

// ---- harness ----

function mockReq(over = {}) {
  const body = over._body ?? ""
  return {
    headers: over.headers ?? {},
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
    method: over.method ?? "POST",
    url: over.url ?? "/v1/chat/completions",
    signal: new AbortController().signal,
    on: () => {},
    destroy: () => {},
    [Symbol.asyncIterator]: async function* () {
      yield body
    },
    ...over,
  }
}

// Multi-chunk request mock that records how many chunks were actually pulled
// before the consumer (readBody) stops iterating. Used to prove early-abort
// (mid-stream rejection) rather than full-buffer-then-check.
function mockStreamingReq(chunks, over = {}) {
  const pulled = { count: 0, finished: false }
  return {
    headers: over.headers ?? {},
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
    method: over.method ?? "POST",
    url: over.url ?? "/v1/chat/completions",
    signal: new AbortController().signal,
    on: () => {},
    destroy: () => {},
    pulled,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        pulled.count++
        yield chunk
      }
      pulled.finished = true
    },
    ...over,
  }
}

function mockRes() {
  let finishCb = null
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })
  const state = { status: 200, headers: {}, chunks: [] }
  return {
    state,
    done,
    get body() {
      return state.chunks.join("")
    },
    writeHead(status, headers = {}) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    write(chunk) {
      state.chunks.push(String(chunk))
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) state.chunks.push(String(chunk))
      if (finishCb) finishCb()
      resolveDone()
    },
    on(ev, cb) {
      if (ev === "finish") finishCb = cb
      return this
    },
  }
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function sseResponse(contents, model = "upstream-model") {
  const body =
    contents.map((c) => `data: ${JSON.stringify({ model, choices: [{ delta: { content: c } }] })}\n\n`).join("") +
    "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function routeFetch(routes) {
  return async (url, opts = {}) => {
    const u = String(url)
    for (const [pattern, handler] of routes) {
      if (u.includes(pattern)) return typeof handler === "function" ? handler(u, opts) : handler
    }
    throw new Error(`no route for ${u}`)
  }
}

const chatStub = (model, response) => (u, opts) => {
  const sent = JSON.parse(opts.body)
  assert.equal(sent.model, model, "requested model sent upstream")
  return response
}

function snapshotConfig() {
  return {
    ...zp.config,
    fallbackModels: [...zp.config.fallbackModels],
    modelAliases: { ...zp.config.modelAliases },
  }
}
let originalConfig
beforeEach(() => {
  globalThis.fetch = originalFetch
  if (originalConfig) zp.saveConfig(originalConfig)
  Object.assign(zp.requestStats, { total: 0, errors: 0, recent: [], perMinute: new Map(), window60: [] })
  Object.assign(zp.syncState, { at: 0, ok: false, running: false, ms: 0, working: [], rateLimited: [], flaky: [], dead: [], error: "" })
})
beforeEach(() => {
  originalConfig = snapshotConfig()
})

// ---- helpers ----

describe("resolveModel", () => {
  test("maps an alias to its target", () => {
    zp.saveConfig({ modelAliases: { "gpt-4o": "space-bunny-free" } })
    const { requested, candidates } = zp.resolveModel("gpt-4o")
    assert.equal(requested, "gpt-4o")
    assert.equal(candidates[0], "space-bunny-free")
  })

  test("passes an allowed model through unchanged", () => {
    const m = zp.config.fallbackModels[0]
    const { requested, candidates } = zp.resolveModel(m)
    assert.equal(requested, m)
    assert.equal(candidates[0], m)
    assert.ok(candidates.length > 1)
  })

  test("maps an unknown model to defaultModel", () => {
    const { requested, candidates } = zp.resolveModel("no-such-model-xyz")
    assert.equal(requested, "no-such-model-xyz")
    assert.equal(candidates[0], DEFAULT_MODEL)
    assert.ok(candidates.length > 1, "fallback chain includes other models")
  })

  test("maps an empty model to defaultModel", () => {
    const { requested } = zp.resolveModel("")
    assert.equal(requested, DEFAULT_MODEL)
  })
})

describe("authForUpstream", () => {
  test("anonymous public when no proxyKey and bearer is public", () => {
    const req = mockReq({ headers: { authorization: "Bearer public" } })
    assert.equal(zp.authForUpstream(req), "Bearer public")
  })

  test("BYOK bearer forwarded when no proxyKey", () => {
    const req = mockReq({ headers: { authorization: "Bearer sk-abc" } })
    assert.equal(zp.authForUpstream(req), "Bearer sk-abc")
  })

  test("defaultZenKey used when no bearer", () => {
    zp.saveConfig({ defaultZenKey: "zen-123" })
    const req = mockReq({ headers: {} })
    assert.equal(zp.authForUpstream(req), "Bearer zen-123")
  })

  test("proxyKey set: wrong bearer rejected", () => {
    zp.saveConfig({ proxyKey: "admin-1" })
    const req = mockReq({ headers: { authorization: "Bearer wrong" } })
    assert.equal(zp.authForUpstream(req), null)
  })

  test("proxyKey set: x-zen-key wins", () => {
    zp.saveConfig({ proxyKey: "admin-1", defaultZenKey: "zen-default" })
    const req = mockReq({ headers: { authorization: "Bearer admin-1", "x-zen-key": "zen-custom" } })
    assert.equal(zp.authForUpstream(req), "Bearer zen-custom")
  })

  test("proxyKey set: defaultZenKey fallback", () => {
    zp.saveConfig({ proxyKey: "admin-1", defaultZenKey: "zen-default" })
    const req = mockReq({ headers: { authorization: "Bearer admin-1" } })
    assert.equal(zp.authForUpstream(req), "Bearer zen-default")
  })

  test("proxyKey set: no zen key uses anonymous public", () => {
    zp.saveConfig({ proxyKey: "admin-1" })
    const req = mockReq({ headers: { authorization: "Bearer admin-1" } })
    assert.equal(zp.authForUpstream(req), "Bearer public")
  })
})

describe("ip handling", () => {
  test("ipOmit flags loopback and private ranges", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255", "fe80::1", "fc00::1", ""]) {
      assert.equal(zp.ipOmit(ip), true, ip)
    }
    for (const ip of ["8.8.8.8", "1.2.3.4", "172.32.0.1"]) {
      assert.equal(zp.ipOmit(ip), false, ip)
    }
  })

  test("clientIp returns socket address unless trustForwarded", () => {
    const req = mockReq({ remoteAddress: "1.2.3.4", headers: { "x-forwarded-for": "9.9.9.9" } })
    assert.equal(zp.clientIp(req), "1.2.3.4")
  })

  test("clientIp honors x-forwarded-for when trustForwarded", () => {
    zp.saveConfig({ trustForwarded: true })
    const req = mockReq({ remoteAddress: "1.2.3.4", headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" } })
    assert.equal(zp.clientIp(req), "9.9.9.9")
  })

  test("zenHeaders sends x-real-ip for public IPs, omits for loopback", () => {
    const pub = zp.zenHeaders(mockReq({ remoteAddress: "8.8.8.8" }), "Bearer public")
    assert.equal(pub["x-real-ip"], "8.8.8.8")
    assert.equal(pub["user-agent"], zp.config.ua)
    const loop = zp.zenHeaders(mockReq({ remoteAddress: "127.0.0.1" }), "Bearer public")
    assert.equal(loop["x-real-ip"], undefined)
  })

  test("zenHeaders forwards x-opencode-* headers", () => {
    const h = zp.zenHeaders(mockReq({ headers: { "x-opencode-session": "sess-1" } }), "Bearer public")
    assert.equal(h["x-opencode-session"], "sess-1")
  })
})

describe("session injection", () => {
  test("zenHeaders injects a synthetic session when none is sent", () => {
    const h = zp.zenHeaders(mockReq({ remoteAddress: "8.8.8.8" }), "Bearer public")
    assert.ok(h["x-opencode-session"], "session header present")
    assert.ok(h["x-opencode-session"].startsWith("ses_"), `session looks like opencode: ${h["x-opencode-session"]}`)
  })

  test("client-provided session is passed through untouched", () => {
    const h = zp.zenHeaders(
      mockReq({ remoteAddress: "8.8.8.8", headers: { "x-opencode-session": "real-session-1" } }),
      "Bearer public",
    )
    assert.equal(h["x-opencode-session"], "real-session-1")
  })

  test("injectSession=false disables injection", () => {
    zp.saveConfig({ injectSession: false })
    const h = zp.zenHeaders(mockReq({ remoteAddress: "8.8.8.8" }), "Bearer public")
    assert.equal(h["x-opencode-session"], undefined)
  })

  test("sessionFor is stable per client and distinct across clients", () => {
    const a1 = zp.sessionFor(mockReq({ remoteAddress: "8.8.8.8" })).value
    const a2 = zp.sessionFor(mockReq({ remoteAddress: "8.8.8.8" })).value
    assert.equal(a1, a2, "same client → same session")
    const b = zp.sessionFor(mockReq({ remoteAddress: "9.9.9.9" })).value
    assert.notEqual(a1, b, "different client → different session")
    // opencode shape: ses_ + 12 hex digits + 14 random base62 characters.
    assert.match(a1, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.ok(zp.sessionFor(mockReq()).injected, "local client gets an injected id")
  })

  test("a minted session id carries a decodable recent timestamp", () => {
    // Upstream decodes the leading 12 hex digits as a creation time in opencode's
    // own format and refuses ids without a plausible one — the same 403 a missing
    // session header gets. So assert the prefix is the encoding of *some*
    // millisecond around now, which is the property upstream actually checks.
    const encode = (now, ctr) => {
      const a = ~((BigInt(now) << 12n) + BigInt(ctr))
      return Array.from({ length: 6 }, (_, i) => Number(a >> BigInt(40 - 8 * i) & 0xffn).toString(16).padStart(2, "0")).join("")
    }
    const before = Date.now()
    const id = zp.sessionFor(mockReq({ remoteAddress: "7.7.7.7" })).value
    const after = Date.now()
    const prefix = id.slice(4, 16)
    let ok = false
    for (let t = before - 1; t <= after + 1 && !ok; t++) {
      for (const ctr of [1, 2, 3, 4, 5]) if (encode(t, ctr) === prefix) ok = true
    }
    assert.ok(ok, `prefix ${prefix} does not encode a timestamp near now`)
  })

  test("both session headers are sent, with the same value", () => {
    const req = mockReq({ remoteAddress: "5.5.5.5" })
    const h = zp.zenHeaders(req, "Bearer public")
    assert.ok(h["x-opencode-session"], "x-opencode-session present")
    assert.ok(h["x-opencode-session-id"], "x-opencode-session-id present")
    assert.equal(h["x-opencode-session"], h["x-opencode-session-id"], "both headers carry one id")
  })

  test("a client-supplied session is mirrored into the second header", () => {
    const h = zp.zenHeaders(mockReq({ headers: { "x-opencode-session": "ses_fromclient01" } }), "Bearer public")
    assert.equal(h["x-opencode-session"], "ses_fromclient01")
    assert.equal(h["x-opencode-session-id"], "ses_fromclient01")
  })
})

describe("retryableUpstream", () => {
  test("429 and 5xx are always retryable", () => {
    assert.equal(zp.retryableUpstream(429, {}), true)
    assert.equal(zp.retryableUpstream(502, {}), true)
    assert.equal(zp.retryableUpstream(503, {}), true)
  })

  test("400 server_error / model unavailable is retryable", () => {
    const body = { error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." } }
    assert.equal(zp.retryableUpstream(400, body), true)
  })

  test("MissingSessionID and RegionError are retryable", () => {
    assert.equal(zp.retryableUpstream(400, { error: { type: "MissingSessionID", message: "OpenCode's free tier can only be used in OpenCode" } }), true)
    assert.equal(zp.retryableUpstream(403, { error: { type: "RegionError", message: "not available in your country" } }), true)
    assert.equal(zp.retryableUpstream(401, { error: { type: "ModelError", message: "Model hy3-free is not supported" } }), true)
  })

  test("plain client errors are not retryable", () => {
    assert.equal(zp.retryableUpstream(400, { error: { message: "bad request" } }), false)
    assert.equal(zp.retryableUpstream(401, { error: { message: "invalid api key" } }), false)
    assert.equal(zp.retryableUpstream(400, { error: { type: "invalid_request_error" } }), false)
  })
})

describe("effectiveDefault", () => {
  test("explicit defaultModel always wins", () => {
    zp.saveConfig({ defaultModel: "mimo-v2.5-free", fallbackModels: ["big-pickle", "mimo-v2.5-free"] })
    assert.equal(zp.effectiveDefault(), "mimo-v2.5-free")
  })

  test("empty default resolves to the first healthy model after a sync", async () => {
    zp.saveConfig({ defaultModel: "", fallbackModels: ["mimo-v2.5-free", "big-pickle"], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: "mimo-v2.5-free" }, { id: "big-pickle" }] })],
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          if (sent.model === "mimo-v2.5-free") {
            return jsonResponse({
              error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." },
            }, 400)
          }
          return jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.working.includes("big-pickle"), "big-pickle healthy")
    assert.ok(s.flaky.includes("mimo-v2.5-free"), "mimo currently down")
    assert.equal(zp.effectiveDefault(), "big-pickle", "auto default must skip the dead model")
  })

  test("no sync data falls back to the first list entry", () => {
    zp.saveConfig({ defaultModel: "", fallbackModels: ["mimo-v2.5-free", "big-pickle"] })
    assert.equal(zp.effectiveDefault(), "mimo-v2.5-free")
  })
})

describe("auto-UA tracking", () => {
  test("refreshUA adopts a newer opencode version and persists it", async () => {
    zp.saveConfig({ autoUA: true, ua: "opencode/1.18.30" })
    globalThis.fetch = routeFetch([
      ["registry.npmjs.org/opencode-ai/latest", jsonResponse({ version: "9.9.9" })],
    ])
    await zp.refreshUA(true)
    assert.equal(zp.config.ua, "opencode/9.9.9", "UA must track the latest opencode version")
  })

  test("refreshUA leaves custom User-Agents untouched", async () => {
    zp.saveConfig({ autoUA: true, ua: "my-agent/1.0" })
    globalThis.fetch = routeFetch([
      ["registry.npmjs.org/opencode-ai/latest", jsonResponse({ version: "9.9.9" })],
    ])
    await zp.refreshUA(true)
    assert.equal(zp.config.ua, "my-agent/1.0", "custom UA must not be overwritten")
  })

  test("refreshUA is a no-op when autoUA is disabled", async () => {
    zp.saveConfig({ autoUA: false, ua: "opencode/1.18.30" })
    let hit = false
    globalThis.fetch = async () => { hit = true; return jsonResponse({ version: "9.9.9" }) }
    await zp.refreshUA(true)
    assert.equal(hit, false, "must not fetch when disabled")
    assert.equal(zp.config.ua, "opencode/1.18.30")
  })
})

describe("sync prunes unsupported models", () => {
  test("model that upstream no longer supports is removed immediately", async () => {
    zp.saveConfig({ fallbackModels: ["hy3-free"], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: "hy3-free" }, { id: "mimo-v2.5-free" }] })],
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          return sent.model === "hy3-free"
            ? jsonResponse({ error: { type: "ModelError", message: "Model hy3-free is not supported" } }, 401)
            : jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.dead.includes("hy3-free"), "hy3-free reported dead")
    assert.ok(!zp.config.fallbackModels.includes("hy3-free"), "hy3-free removed from config")
    assert.ok(zp.config.fallbackModels.includes("mimo-v2.5-free"), "healthy model kept")
  })

  test("auth failures never punish healthy models", async () => {
    zp.saveConfig({ fallbackModels: ["mimo-v2.5-free"], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: "mimo-v2.5-free" }] })],
      ["/chat/completions", jsonResponse({ error: { type: "AuthError", message: "Invalid API key." } }, 401)],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.flaky.includes("mimo-v2.5-free"), "not counted as dead")
    assert.ok(zp.config.fallbackModels.includes("mimo-v2.5-free"), "still configured")
  })

  test("repeated 403 FreeTierError never deletes the model from config", async () => {
    // The free-tier block is temporary: the model must survive so it can come
    // back on its own, and so the user does not silently lose their list.
    const list = ["space-bunny-free", "mimo-v2.5-free", "big-pickle"]
    zp.saveConfig({ fallbackModels: [...list], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
    const blocked = () =>
      jsonResponse({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }, 403)
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: list.map((id) => ({ id })) })],
      ["/chat/completions", (u, opts) =>
        JSON.parse(opts.body).model === "space-bunny-free" ? jsonResponse({ model: "ok", choices: [] }) : blocked(),
      ],
    ])
    for (let i = 0; i < 3; i++) {
      const s = await zp.syncModels()
      assert.equal(s.ok, true)
      assert.deepEqual([...zp.config.fallbackModels].sort(), [...list].sort(), `config intact after sync #${i + 1}`)
      assert.ok(!s.dead.includes("mimo-v2.5-free"), "temporary block is not 'dead'")
      assert.ok(s.gated.includes("mimo-v2.5-free"), "reported as agent-only (gated), not flaky")
    }
  })

  test("a model that comes back is reported working again", async () => {
    const list = ["space-bunny-free", "mimo-v2.5-free"]
    zp.saveConfig({ fallbackModels: [...list], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
    let blocked = true
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: list.map((id) => ({ id })) })],
      [
        "/chat/completions",
        (u, opts) => {
          const m = JSON.parse(opts.body).model
          if (m === "space-bunny-free") return jsonResponse({ model: "ok", choices: [] })
          return blocked
            ? jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403)
            : jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    await zp.syncModels()
    assert.ok(zp.config.fallbackModels.includes("mimo-v2.5-free"))
    blocked = false
    const s = await zp.syncModels()
    assert.ok(s.working.includes("mimo-v2.5-free"), "recovered model is working")
    assert.equal(zp.effectiveDefault(), "space-bunny-free", "first healthy in list order still wins")
  })
  test("a retired model that is still listed upstream is not added", async () => {
    // deepseek-v4-flash-free case: present in /models, but every call 400s with
    // "Model is unavailable" and it is gone from opencode's own free-model list.
    zp.saveConfig({ fallbackModels: ["space-bunny-free"], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "space-bunny-free" }, { id: "deepseek-v4-flash-free" }] })],
      [
        "/chat/completions",
        (u, opts) =>
          JSON.parse(opts.body).model === "space-bunny-free"
            ? jsonResponse({ model: "ok", choices: [] })
            : jsonResponse({ error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." } }, 400),
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(!zp.config.fallbackModels.includes("deepseek-v4-flash-free"), "retired model not added to the list")
    assert.ok(zp.config.fallbackModels.includes("space-bunny-free"), "working model kept")
  })

  test("free-tier gated models are still added, since agents can use them", async () => {
    zp.saveConfig({ fallbackModels: [], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "gated-flash-free" }] })],
      ["/chat/completions", () => jsonResponse({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }, 403)],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.gated.includes("gated-flash-free"), "reported as agent-only")
    assert.ok(zp.config.fallbackModels.includes("gated-flash-free"), "added, because real agents can use it")
  })
})

describe("fallback transparency", () => {
  test("reply names the model that actually served it when it differs", async () => {
    zp.saveConfig({ fallbackModels: ["big-pickle", "space-bunny-free"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          if (sent.model === "big-pickle") {
            return jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403)
          }
          return jsonResponse({ model: "space-bunny-free", choices: [{ message: { role: "assistant", content: "hi" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.model, "big-pickle", "client still sees the model it asked for")
    assert.equal(data.zen_served_by, "space-bunny-free", "but knows who actually answered")
  })

  test("no served_by field when the requested model answered", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([["/chat/completions", () => jsonResponse({ model: m, choices: [] })]])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(JSON.parse(res.body).zen_served_by, undefined)
  })
})

describe("auth visibility & key test", () => {
  test("/api/status reports the effective auth mode", async () => {
    zp.saveConfig({ defaultZenKey: "", proxyKey: "" })
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [] })]])
    let res = mockRes()
    await zp.handleStatus(mockReq(), res)
    assert.equal(JSON.parse(res.body).auth.mode, "public")

    zp.saveConfig({ defaultZenKey: "zen-secret-key-123", proxyKey: "" })
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [] })]])
    res = mockRes()
    await zp.handleStatus(mockReq(), res)
    const st = JSON.parse(res.body)
    assert.equal(st.auth.mode, "byok")
    assert.ok(!JSON.parse(JSON.stringify(st.auth)).zenKey.includes("zen-secret"), "key masked")
  })

  test("/api/test sends an explicit zenKey override", async () => {
    const m = zp.config.fallbackModels[0]
    let sentAuth
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sentAuth = opts.headers["authorization"]
          return jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, zenKey: "sk-custom-zen-key" }) })
    const res = mockRes()
    await zp.handleTest(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(sentAuth, "Bearer sk-custom-zen-key")
  })
})

describe("responses API translation", () => {
  test("modelFormat resolves patterns, exact ids and defaults to chat", () => {
    zp.saveConfig({ responsesModels: ["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*", "exact-model"] })
    assert.equal(zp.modelFormat("gpt-5.5"), "responses")
    assert.equal(zp.modelFormat("gpt-6-astra"), "responses")
    assert.equal(zp.modelFormat("grok-4.6"), "responses")
    assert.equal(zp.modelFormat("muse-spark-1.3-contributor-free"), "responses")
    assert.equal(zp.modelFormat("exact-model"), "responses")
    assert.equal(zp.modelFormat("mimo-v2.5-free"), "chat")
    assert.equal(zp.modelFormat("big-pickle"), "chat")
  })

  test("a new model works by config alone, no code change", () => {
    zp.saveConfig({ responsesModels: ["brand-new-2*"] })
    assert.equal(zp.modelFormat("brand-new-2-flash"), "responses")
    assert.equal(zp.modelFormat("gpt-5.5"), "chat", "unknown patterns fall back to chat")
  })

  test("chat messages become Responses input items", () => {
    const input = zp.chatMessagesToInput([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file.txt" },
    ])
    assert.deepEqual(input[0], { role: "system", content: "be brief" })
    assert.deepEqual(input[1], { role: "user", content: "hi" })
    assert.deepEqual(input[2], { type: "function_call", call_id: "call_1", name: "ls", arguments: "{}" })
    assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "file.txt" })
  })

  test("tool_calls survive the round trip", () => {
    const out = zp.responsesToChat(
      {
        id: "resp_1",
        output: [
          { type: "reasoning", summary: [{ text: "thinking" }] },
          { type: "message", content: [{ type: "output_text", text: "let me look" }] },
          { type: "function_call", call_id: "call_9", name: "read", arguments: '{"p":"a"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
      "gpt-5.5",
    )
    assert.equal(out.object, "chat.completion")
    assert.equal(out.model, "gpt-5.5")
    assert.equal(out.choices[0].message.content, "let me look")
    assert.equal(out.choices[0].message.reasoning_content, "thinking")
    assert.deepEqual(out.choices[0].message.tool_calls, [
      { id: "call_9", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
    ])
    assert.equal(out.choices[0].finish_reason, "tool_calls")
    assert.equal(out.usage.total_tokens, 14)
  })

  test("responsesRequest maps tools, sampling and token budget", () => {
    const p = zp.responsesRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 4096,
        tools: [{ type: "function", function: { name: "read", description: "d", parameters: { type: "object" } } }],
        tool_choice: "auto",
      },
      "gpt-5.5",
      true,
    )
    assert.equal(p.model, "gpt-5.5")
    assert.equal(p.stream, true)
    assert.equal(p.max_output_tokens, 4096)
    assert.equal(p.temperature, 0.2)
    assert.deepEqual(p.tools, [{ type: "function", name: "read", description: "d", parameters: { type: "object" } }])
    assert.equal(p.tool_choice, "auto")
    assert.equal(p.messages, undefined, "chat-only fields are not forwarded")
  })

  test("SSE deltas translate to chat chunk deltas", () => {
    const state = { tools: [] }
    assert.deepEqual(zp.responsesEventToDeltas("", { type: "response.output_text.delta", delta: "he" }, state), [{ content: "he" }])
    assert.deepEqual(zp.responsesEventToDeltas("", { type: "response.reasoning_text.delta", delta: "hm" }, state), [
      { reasoning_content: "hm" },
    ])
    const added = zp.responsesEventToDeltas("", { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "ls" } }, state)
    assert.equal(added[0].tool_calls[0].id, "c1")
    const args = zp.responsesEventToDeltas("", { type: "response.function_call_arguments.delta", item_id: "c1", delta: "{}" }, state)
    assert.deepEqual(args[0].tool_calls[0].function.arguments, "{}")
  })

  test("handleChat routes a responses model to /responses and returns chat shape", async () => {
    zp.saveConfig({ responsesModels: ["gpt-5*"], fallbackModels: ["gpt-5.5"], defaultModel: "gpt-5.5" })
    let hitUrl = ""
    let sentBody = null
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          hitUrl = u
          sentBody = JSON.parse(opts.body)
          return jsonResponse({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "yo" }] }], usage: { input_tokens: 3, output_tokens: 1 } })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.match(hitUrl, /\/responses$/)
    assert.equal(sentBody.model, "gpt-5.5")
    assert.deepEqual(sentBody.input, [{ role: "user", content: "hi" }])
    const data = JSON.parse(res.body)
    assert.equal(data.object, "chat.completion")
    assert.equal(data.model, "gpt-5.5")
    assert.equal(data.choices[0].message.content, "yo")
  })

  test("streams a responses model back as chat.completion.chunk SSE", async () => {
    zp.saveConfig({ responsesModels: ["gpt-5*"], fallbackModels: ["gpt-5.5"], defaultModel: "gpt-5.5" })
    const sse =
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "he" })}\n\n` +
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "llo" })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`
    globalThis.fetch = routeFetch([
      ["/responses", () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "gpt-5.5", messages: [], stream: true }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.match(res.body, /"object":"chat\.completion\.chunk"/)
    assert.match(res.body, /"content":"he"/)
    assert.match(res.body, /"content":"llo"/)
    assert.match(res.body, /"finish_reason":"stop"/)
    assert.match(res.body, /"total_tokens":7/)
    assert.ok(res.body.includes("data: [DONE]"))
  })
})

describe("rate limiting", () => {
  test("disabled by default so the proxy never blocks itself", () => {
    zp.saveConfig({ rateLimitMax: 0 })
    for (let i = 0; i < 200; i++) assert.equal(zp.rateLimitFor(mockReq()).limited, false)
  })

  test("blocks the Nth+1 chat request and reports Retry-After", () => {
    zp.saveConfig({ rateLimitMax: 3, rateLimitWindowMs: 60_000 })
    const req = mockReq({ remoteAddress: "5.5.5.5" })
    assert.equal(zp.rateLimitFor(req).limited, false)
    assert.equal(zp.rateLimitFor(req).limited, false)
    assert.equal(zp.rateLimitFor(req).limited, false)
    const hit = zp.rateLimitFor(req)
    assert.equal(hit.limited, true)
    assert.ok(hit.retryAfter > 0 && hit.retryAfter <= 60, `retry-after sane: ${hit.retryAfter}`)
  })

  test("limits are per client, not global", () => {
    zp.saveConfig({ rateLimitMax: 2, rateLimitWindowMs: 60_000 })
    const a = mockReq({ remoteAddress: "5.5.5.5" })
    const b = mockReq({ remoteAddress: "6.6.6.6" })
    zp.rateLimitFor(a)
    zp.rateLimitFor(a)
    assert.equal(zp.rateLimitFor(a).limited, true)
    assert.equal(zp.rateLimitFor(b).limited, false, "second client is unaffected")
  })

  test("dashboard polling and /health are never throttled", async () => {
    zp.saveConfig({ rateLimitMax: 1, rateLimitWindowMs: 60_000, cacheMs: 0 })
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [] })]])
    const req = mockReq({ method: "GET", url: "/health", remoteAddress: "5.5.5.5" })
    for (let i = 0; i < 5; i++) {
      const res = mockRes()
      await zp.router(req, res)
      assert.equal(res.state.status, 200, `health check #${i} must stay open`)
    }
  })

  test("chat endpoint returns 429 with retry-after once over the limit", async () => {
    zp.saveConfig({ rateLimitMax: 1, rateLimitWindowMs: 60_000, fallbackModels: ["mimo-v2.5-free"], defaultModel: "mimo-v2.5-free" })
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => jsonResponse({ model: "ok", choices: [] })],
      ["/responses", () => jsonResponse({ output: [] })],
    ])
    const body = JSON.stringify({ model: "mimo-v2.5-free", messages: [] })
    const first = mockReq({ _body: body, remoteAddress: "7.7.7.7" })
    const r1 = mockRes()
    await zp.router(first, r1)
    assert.equal(r1.state.status, 200)
    const second = mockReq({ _body: body, remoteAddress: "7.7.7.7" })
    const r2 = mockRes()
    await zp.router(second, r2)
    assert.equal(r2.state.status, 429)
    assert.ok(Number(r2.state.headers["retry-after"]) > 0, "sets Retry-After")
  })
})

describe("FreeTierError handling", () => {
  test("403 free-tier block rotates to the next model", () => {
    assert.equal(zp.retryableUpstream(403, { error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }), true)
  })

  test("real auth 403 is not treated as retryable", () => {
    assert.equal(zp.retryableUpstream(403, { error: { type: "auth_error", message: "bad token" } }), false)
  })
})

describe("probe auth toggle", () => {
  test("auto uses the Zen key when configured", () => {
    zp.saveConfig({ probeAuth: "auto", defaultZenKey: "zen-abc" })
    assert.equal(zp.probeAuthHeader(), "Bearer zen-abc")
  })
  test("auto falls back to anonymous when no key", () => {
    zp.saveConfig({ probeAuth: "auto", defaultZenKey: "" })
    assert.equal(zp.probeAuthHeader(), "Bearer public")
  })
  test("anonymous ignores a configured key", () => {
    zp.saveConfig({ probeAuth: "anonymous", defaultZenKey: "zen-abc" })
    assert.equal(zp.probeAuthHeader(), "Bearer public", "probes the free tier, not the user's quota")
  })
  test("key with no key configured degrades to anonymous instead of failing", () => {
    zp.saveConfig({ probeAuth: "key", defaultZenKey: "" })
    assert.equal(zp.probeAuthHeader(), "Bearer public")
  })

  test("probes actually send the selected credentials", async () => {
    zp.saveConfig({ probeAuth: "anonymous", defaultZenKey: "zen-secret", fallbackModels: ["space-bunny-free"], autoSyncIntervalMs: 0, cacheMs: 0 })
    let sentAuth = null
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "space-bunny-free" }] })],
      [
        "/chat/completions",
        (u, opts) => {
          sentAuth = opts.headers["authorization"]
          return jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    await zp.syncModels()
    assert.equal(sentAuth, "Bearer public", "anonymous mode must not leak the user's key")
  })
})

describe("model list self-healing", () => {
  test("a list trimmed by an older build regains every upstream free model", async () => {
    // The bug that trapped users on a 5-model list: a previous build removed
    // temporarily-blocked models, and the shrunken list never recovered.
    const shipped = [...zp.config.fallbackModels]
    const trimmed = ["space-bunny-free", "big-pickle"]
    zp.saveConfig({ fallbackModels: [...trimmed], autoSyncIntervalMs: 0, cacheMs: 0 })
    const upstream = [...new Set([...shipped, "brand-new-flash-free"])]
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: upstream.map((id) => ({ id })) })],
      ["/chat/completions", () => jsonResponse({ model: "ok", choices: [] })],
      ["/responses", () => jsonResponse({ output: [] })],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    for (const id of shipped) {
      assert.ok(zp.config.fallbackModels.includes(id), `${id} was restored to the list`)
    }
    assert.ok(zp.config.fallbackModels.includes("brand-new-flash-free"), "brand-new upstream model appears")
    assert.ok(zp.config.fallbackModels.includes("space-bunny-free"))
    assert.ok(zp.config.fallbackModels.includes("big-pickle"), "user's own entries are kept")
  })

  test("models that are only temporarily blocked are still added back", async () => {
    zp.saveConfig({ fallbackModels: [], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "space-bunny-free" }, { id: "blocked-flash-free" }] })],
      [
        "/chat/completions",
        (u, opts) =>
          JSON.parse(opts.body).model === "space-bunny-free"
            ? jsonResponse({ model: "ok", choices: [] })
            : jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403),
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.gated.includes("blocked-flash-free"), "reported as agent-only, not flaky")
    assert.ok(zp.config.fallbackModels.includes("blocked-flash-free"), "but still added to the list so it can recover")
  })

  test("definitively gone models are still dropped", async () => {
    zp.saveConfig({ fallbackModels: ["space-bunny-free", "removed-flash-free"], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "space-bunny-free" }] })],
      [
        "/chat/completions",
        (u, opts) =>
          JSON.parse(opts.body).model === "space-bunny-free"
            ? jsonResponse({ model: "ok", choices: [] })
            : jsonResponse({ error: { type: "ModelError", message: "Model removed-flash-free is not supported" } }, 401),
      ],
    ])
    await zp.syncModels()
    assert.ok(!zp.config.fallbackModels.includes("removed-flash-free"), "unsupported model removed")
    assert.ok(zp.config.fallbackModels.includes("space-bunny-free"))
  })
})

describe("restore model list", () => {
  test("POST /api/config re-adds shipped models without touching keys", async () => {
    zp.saveConfig({ fallbackModels: ["space-bunny-free"], defaultZenKey: "zen-keep-me", proxyKey: "" })
    const res = mockRes()
    await zp.handleApiConfig(mockReq({ method: "POST", _body: JSON.stringify({ fallbackModels: true }) }), res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    for (const m of zp.config.fallbackModels) {
      if (m !== "space-bunny-free") assert.ok(data.config.fallbackModels.includes(m), `${m} restored`)
    }
    assert.equal(zp.config.defaultZenKey, "zen-keep-me", "zen key preserved")
  })

  test("unknown POST body is rejected", async () => {
    const res = mockRes()
    await zp.handleApiConfig(mockReq({ method: "POST", _body: JSON.stringify({ bogus: true }) }), res)
    assert.equal(res.state.status, 400)
  })
})

describe("test endpoint honest reporting", () => {
  test("free-tier gate is reported as agent-only, not as a failure", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        () =>
          jsonResponse(
            { type: "error", error: { type: "FreeTierError", message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" } },
            403,
          ),
      ],
      ["/responses", () => jsonResponse({ error: { type: "FreeTierError", message: "free tier can only" } }, 403)],
    ])
    const res = mockRes()
    await zp.handleTest(mockReq({ _body: JSON.stringify({ model: m }) }), res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.gated, true, "flagged as gated")
    assert.equal(data.ok, true, "not presented as a broken model")
    assert.equal(data.status, 403)
    assert.match(data.detail, /real agent/i)
  })

  test("a genuine failure is still reported as a failure", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => jsonResponse({ error: { type: "RegionError", message: "not available in your country" } }, 403)],
      ["/responses", () => jsonResponse({ error: { type: "RegionError", message: "nope" } }, 403)],
    ])
    const res = mockRes()
    await zp.handleTest(mockReq({ _body: JSON.stringify({ model: m }) }), res)
    const data = JSON.parse(res.body)
    assert.equal(data.gated, false)
    assert.equal(data.ok, false)
    assert.equal(data.status, 403)
  })
})

describe("handleTest body size", () => {
  test("mid-stream abort: oversized body rejected before stream fully drained", async () => {
    const chunk = "x".repeat(100 * 1024)
    const chunks = Array.from({ length: 20 }, () => chunk)
    const req = mockStreamingReq(chunks, { method: "POST" })
    const res = mockRes()
    await zp.handleTest(req, res)
    assert.equal(res.state.status, 413)
    assert.ok(req.pulled.count < chunks.length, `expected early abort, pulled ${req.pulled.count}/${chunks.length} chunks`)
    assert.equal(req.pulled.finished, false, "generator must not run to completion")
  })
})

describe("recordReq stats", () => {
  test("dedups consecutive identical records", () => {
    const req = mockReq()
    zp.recordReq(req, "model-a", 10, 200, 1000)
    zp.recordReq(req, "model-a", 20, 200, 1000)
    assert.equal(zp.requestStats.recent.length, 1)
    assert.equal(zp.requestStats.recent[0][1], 2)
  })

  test("separate records for different status", () => {
    const req = mockReq()
    zp.recordReq(req, "model-a", 10, 200, 1000)
    zp.recordReq(req, "model-a", 10, 429, 1000)
    assert.equal(zp.requestStats.recent.length, 2)
  })

  test("tracks totals and errors", () => {
    const req = mockReq()
    zp.recordReq(req, "m", 1, 200, 1000)
    zp.recordReq(req, "m", 1, 500, 1001)
    assert.equal(zp.requestStats.total, 2)
    assert.equal(zp.requestStats.errors, 1)
  })

  test("window60 keeps only the last 60 seconds", () => {
    const req = mockReq()
    zp.recordReq(req, "m", 1, 200, 1000)
    zp.recordReq(req, "m", 1, 200, 65_000)
    assert.deepEqual(zp.requestStats.window60, [65_000])
  })

  test("perMinute prunes buckets older than 60 minutes", () => {
    const req = mockReq()
    zp.recordReq(req, "m", 1, 200, 1000)
    zp.recordReq(req, "m", 1, 200, 1000 + 61 * 60_000)
    assert.equal(zp.requestStats.perMinute.size, 1)
  })

  test("handleStatus reports recent windows", async () => {
    const req = mockReq()
    zp.recordReq(req, "m", 1, 200, Date.now() - 30_000)
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [] })]])
    const res = mockRes()
    await zp.handleStatus(req, res)
    const data = JSON.parse(res.body)
    assert.equal(data.requests.lastMinute, 1)
    assert.equal(data.requests.last5m, 1)
    assert.equal(data.requests.total, 1)
  })

  test("recent entries carry the real latency, not NaN", async () => {
    const req = mockReq()
    zp.recordReq(req, "m", 42, 200, Date.now() - 30_000)
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [] })]])
    const res = mockRes()
    await zp.handleStatus(req, res)
    const data = JSON.parse(res.body)
    assert.equal(data.recent.length, 1)
    assert.equal(data.recent[0].ms, 42, "latency must be the recorded duration")
  })
})

describe("parseRetryAfter", () => {
  test("parses seconds", () => {
    assert.equal(zp.parseRetryAfter("5"), 5)
    assert.equal(zp.parseRetryAfter("0"), 0)
  })

  test("parses HTTP-date", () => {
    const secs = zp.parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())
    assert.ok(secs > 25 && secs < 35, `expected ~30s, got ${secs}`)
  })

  test("garbage yields 0", () => {
    assert.equal(zp.parseRetryAfter("soon"), 0)
    assert.equal(zp.parseRetryAfter(""), 0)
    assert.equal(zp.parseRetryAfter(null), 0)
  })
})

describe("toBool", () => {
  test('"0" and "false" are false', () => {
    assert.equal(zp.toBool("0", true), false)
    assert.equal(zp.toBool("false", true), false)
  })

  test('"1" and "true" are true', () => {
    assert.equal(zp.toBool("1", false), true)
    assert.equal(zp.toBool("true", false), true)
  })

  test("booleans pass through; undefined uses default", () => {
    assert.equal(zp.toBool(true, false), true)
    assert.equal(zp.toBool(false, true), false)
    assert.equal(zp.toBool(undefined, true), true)
  })
})

describe("handleChat", () => {
  test("invalid JSON body → 400", async () => {
    const req = mockReq({ _body: "{not json" })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 400)
  })

  test("non-object body → 400", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const req = mockReq({ _body: JSON.stringify([1, 2, 3]) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 400)
  })

  test("oversized body → 413", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const big = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 100) }] })
    const req = mockReq({ _body: big })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
  })

  test("mid-stream abort: oversized body is rejected before the stream is fully drained", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    // 20 chunks of 100KB = ~2MB total, well over MAX_BODY (1MB). Each chunk is
    // small relative to MAX_BODY so the overflow is detected partway through,
    // not on the first or last chunk.
    const chunk = "x".repeat(100 * 1024)
    const chunks = Array.from({ length: 20 }, () => chunk)
    const req = mockStreamingReq(chunks)
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
    assert.ok(req.pulled.count < chunks.length, `expected early abort, pulled ${req.pulled.count}/${chunks.length} chunks`)
    assert.equal(req.pulled.finished, false, "generator must not run to completion")
  })

  test("body exactly at MAX_BODY → not rejected for size", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(zp.MAX_BODY - JSON.stringify({ model: "m", messages: [{ role: "user", content: "" }] }).length)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, zp.MAX_BODY, "sanity: body is exactly MAX_BODY")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.notEqual(res.state.status, 413)
  })

  test("body one byte over MAX_BODY → 413", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(zp.MAX_BODY - JSON.stringify({ model: "m", messages: [{ role: "user", content: "" }] }).length + 1)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, zp.MAX_BODY + 1, "sanity: body is MAX_BODY + 1")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
  })

  test("body one byte under MAX_BODY → not 413", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(zp.MAX_BODY - JSON.stringify({ model: "m", messages: [{ role: "user", content: "" }] }).length - 1)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, zp.MAX_BODY - 1, "sanity: body is MAX_BODY - 1")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.notEqual(res.state.status, 413)
  })

  test("wrong proxy key → 401", async () => {
    zp.saveConfig({ proxyKey: "admin-1" })
    const req = mockReq({ _body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: "Bearer nope" } })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 401)
  })

  test("non-stream success rewrites model and records 200", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub(m, jsonResponse({ model: "upstream-model", choices: [] }))],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.model, m)
    assert.equal(zp.requestStats.recent.at(-1)[0].endsWith("|200"), true)
    assert.equal(Number.isFinite(zp.requestStats.recent.at(-1)[2]), true, "recorded latency must be a number")
  })

  test("chat requests always carry an x-opencode-session upstream", async () => {
    const m = zp.config.fallbackModels[0]
    let sentHdr
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sentHdr = opts.headers["x-opencode-session"]
          return jsonResponse({ model: "upstream-model", choices: [] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.ok(sentHdr, "upstream must receive the session header")
    assert.ok(sentHdr.startsWith("ses_"), `session header looks real: ${sentHdr}`)
  })

  test("alias: upstream called with target, response rewritten to alias", async () => {
    zp.saveConfig({ modelAliases: { "gpt-4o": "space-bunny-free" } })
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub("space-bunny-free", jsonResponse({ model: "upstream-model", choices: [] }))],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "gpt-4o", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(JSON.parse(res.body).model, "gpt-4o")
  })

  test("falls back to next candidate on 429", async () => {
    const [m1, m2] = zp.config.fallbackModels
    let calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          return sent.model === m1 ? jsonResponse({ error: { message: "rate limited" } }, 429) : jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m1, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, [m1, m2])
  })

  test("all candidates 429 → final 429 with last upstream error", async () => {
    const err429 = () => jsonResponse({ error: { message: "FreeUsageLimitError" } }, 429)
    globalThis.fetch = routeFetch([
      ["/chat/completions", err429],
      ["/responses", err429],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "whatever", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 429)
    assert.match(res.body, /FreeUsageLimitError/)
  })

  test("non-retryable 400 propagates its status, not 429", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub(m, jsonResponse({ error: { message: "bad request" } }, 400))],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 400)
    assert.match(res.body, /bad request/)
  })

  test("falls back to next candidate when a 400 says the model is unavailable", async () => {
    const [m1, m2] = zp.config.fallbackModels
    let calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === m1) {
            return jsonResponse({
              error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." },
            }, 400)
          }
          return jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m1, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, [m1, m2], "dead default model must roll to the next candidate")
  })

  test("401 from upstream propagates as 401", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub(m, jsonResponse({ error: { message: "invalid api key" } }, 401))],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 401)
  })

  test("upstream network failure → 502, no hang", async () => {
    const boom = () => {
      throw new Error("ECONNREFUSED")
    }
    globalThis.fetch = routeFetch([
      ["/chat/completions", boom],
      ["/responses", boom],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "whatever", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 502)
    assert.match(res.body, /ECONNREFUSED/)
  })

  test("stream relays SSE with model rewritten and [DONE] preserved", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub(m, sseResponse(["hello", " world"], "upstream-model"))],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [], stream: true }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.match(res.body, new RegExp(`"model":"${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))
    assert.ok(res.body.includes("data: [DONE]"))
  })
})

describe("rewriteSSE", () => {
  test("rewrites model in data payloads", () => {
    const out = zp.rewriteSSE('data: {"model":"a","choices":[]}', "target-model")
    assert.ok(out.includes('"model":"target-model"'))
  })

  test("passes [DONE] through", () => {
    assert.ok(zp.rewriteSSE("data: [DONE]", "m").includes("data: [DONE]"))
  })

  test("passes malformed payloads through untouched", () => {
    assert.ok(zp.rewriteSSE("data: not json", "m").includes("data: not json"))
  })

  test("ignores empty blocks", () => {
    assert.equal(zp.rewriteSSE("", "m"), null)
  })
})

describe("fetchModels", () => {
  test("caches within cacheMs", async () => {
    zp.saveConfig({ cacheMs: 0 })
    let calls = 0
    globalThis.fetch = routeFetch([
      [
        "/models",
        () => {
          calls++
          return jsonResponse({ data: [{ id: "space-bunny-free" }, { id: "paid-model" }] })
        },
      ],
    ])
    await zp.fetchModels() // cold refetch → 1 upstream call
    zp.saveConfig({ cacheMs: 60_000 })
    const r1 = await zp.fetchModels()
    const r2 = await zp.fetchModels()
    assert.equal(calls, 1)
    assert.equal(r1, r2)
    assert.equal(r1.ok, true)
  })

  test("refetches after cacheMs expires", async () => {
    zp.saveConfig({ cacheMs: 0 })
    let calls = 0
    globalThis.fetch = routeFetch([
      [
        "/models",
        () => {
          calls++
          return jsonResponse({ data: [] })
        },
      ],
    ])
    await zp.fetchModels()
    await zp.fetchModels()
    assert.equal(calls, 2)
  })

  test("returns ok:false on upstream failure and keeps prior data", async () => {
    zp.saveConfig({ cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: "space-bunny-free" }] })],
    ])
    const good = await zp.fetchModels()
    assert.equal(good.ok, true)
    globalThis.fetch = routeFetch([
      [
        "/models",
        () => {
          throw new Error("ECONNREFUSED")
        },
      ],
    ])
    const bad = await zp.fetchModels()
    assert.equal(bad.ok, false)
    assert.deepEqual(bad.data.map((m) => m.id), ["space-bunny-free"])
  })

  test("in-flight requests share a single fetch (no stampede)", async () => {
    zp.saveConfig({ cacheMs: 0 })
    let calls = 0
    let release
    const gate = new Promise((r) => {
      release = r
    })
    globalThis.fetch = routeFetch([
      [
        "/models",
        async () => {
          calls++
          await gate
          return jsonResponse({ data: [] })
        },
      ],
    ])
    const p1 = zp.fetchModels()
    const p2 = zp.fetchModels()
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(calls, 1)
    assert.equal(r1, r2)
  })
})

describe("handleModels", () => {
  test("requires proxyKey when set", async () => {
    zp.saveConfig({ proxyKey: "admin-1" })
    const req = mockReq({ headers: {} })
    const res = mockRes()
    await zp.handleModels(req, res)
    assert.equal(res.state.status, 401)
  })

  test("serves model list with valid key", async () => {
    zp.saveConfig({ proxyKey: "admin-1", cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "space-bunny-free" }] })],
    ])
    await zp.fetchModels() // cold refresh so the cache holds the stub's data
    zp.saveConfig({ cacheMs: 60_000 })
    const req = mockReq({ headers: { authorization: "Bearer admin-1" } })
    const res = mockRes()
    await zp.handleModels(req, res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.ok, true)
    assert.equal(data.data[0].id, "space-bunny-free")
  })
})

describe("handleApiConfig", () => {
  test("GET returns sanitized config (keys masked)", async () => {
    zp.saveConfig({ proxyKey: "secret-admin", defaultZenKey: "zen-abcdefghijklmnop" })
    const res = mockRes()
    await zp.handleApiConfig(mockReq({ method: "GET", headers: { authorization: "Bearer secret-admin" } }), res)
    const data = JSON.parse(res.body)
    assert.equal(data.config.proxyKey, "••••••••")
    assert.ok(!data.config.proxyKey.includes("secret"))
    assert.ok(data.config.defaultZenKey.includes("••••••"))
  })

  test("PUT ignores unknown keys", async () => {
    const before = zp.config.port
    const req = mockReq({ method: "PUT", _body: JSON.stringify({ notAKey: "x", port: before }) })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.notAKey, undefined)
    assert.equal(zp.config.port, before)
  })

  test("PUT rejects masked proxyKey (keeps existing)", async () => {
    zp.saveConfig({ proxyKey: "real-key-123" })
    const req = mockReq({
      method: "PUT",
      headers: { authorization: "Bearer real-key-123" },
      _body: JSON.stringify({ proxyKey: "••••••••", port: zp.config.port }),
    })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.proxyKey, "real-key-123")
  })

  test("PUT rejects masked defaultZenKey (keeps existing)", async () => {
    zp.saveConfig({ proxyKey: "admin-1", defaultZenKey: "zen-real-abcdef" })
    const req = mockReq({
      method: "PUT",
      headers: { authorization: "Bearer admin-1" },
      _body: JSON.stringify({
        defaultZenKey: zp.sanitize({ defaultZenKey: "zen-real-abcdef" }).defaultZenKey,
        port: zp.config.port,
      }),
    })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.defaultZenKey, "zen-real-abcdef")
  })

  test('PUT autoSync "0" → false', async () => {
    const req = mockReq({ method: "PUT", _body: JSON.stringify({ autoSync: "0", port: zp.config.port }) })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.autoSync, false)
  })

  test('PUT trustForwarded "true" → true', async () => {
    const req = mockReq({ method: "PUT", _body: JSON.stringify({ trustForwarded: "true", port: zp.config.port }) })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.trustForwarded, true)
  })

  test("PUT invalid port keeps existing port", async () => {
    const before = zp.config.port
    const req = mockReq({ method: "PUT", _body: JSON.stringify({ port: "abc" }) })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(zp.config.port, before)
  })

  test("PUT with non-object body → 400", async () => {
    const req = mockReq({ method: "PUT", _body: JSON.stringify([1]) })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(res.state.status, 400)
  })

  test("PUT mid-stream abort: oversized body rejected before stream fully drained", async () => {
    const chunk = "x".repeat(100 * 1024)
    const chunks = Array.from({ length: 20 }, () => chunk) // ~2MB, no proxyKey set so adminAuth passes
    const req = mockStreamingReq(chunks, { method: "PUT" })
    const res = mockRes()
    await zp.handleApiConfig(req, res)
    assert.equal(res.state.status, 413)
    assert.ok(req.pulled.count < chunks.length, `expected early abort, pulled ${req.pulled.count}/${chunks.length} chunks`)
    assert.equal(req.pulled.finished, false, "generator must not run to completion")
  })
})

describe("sanitize / maskKey", () => {
  test("maskKey masks short keys fully, long keys partially", () => {
    assert.equal(zp.maskKey("abc"), "••••••••")
    assert.equal(zp.maskKey(""), "")
    const long = zp.maskKey("abcdefghijklmnopqrstuvwxyz")
    assert.ok(long.startsWith("abcdef"))
    assert.ok(long.endsWith("wxyz"))
    assert.ok(long.includes("••••••"))
  })

  test("sanitize masks proxyKey and defaultZenKey", () => {
    const out = zp.sanitize({ proxyKey: "pk-1", defaultZenKey: "zen-2" })
    assert.equal(out.proxyKey, "••••••••")
    assert.equal(out.defaultZenKey, "••••••••")
  })
})

describe("syncModels model-ID validation", () => {
  test("upstream ids outside the safe charset are not stored", async () => {
    zp.saveConfig({ fallbackModels: [], cacheMs: 0, autoSyncIntervalMs: 0 })
    const evil = "x');alert(1)//-free"
    const good = "space-bunny-free"
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: evil }, { id: good }] })],
      ["/chat/completions", jsonResponse({ model: "ok", choices: [] })],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.equal(zp.config.fallbackModels.includes(evil), false)
    assert.equal(zp.config.fallbackModels.includes(good), true)
    assert.ok(zp.config.fallbackModels.every((m) => MODEL_ID_RE.test(m)), "all stored ids safe")
  })
})

describe("router / health", () => {
  test("/health reports ok:true when upstream responds", async () => {
    zp.saveConfig({ cacheMs: 0 })
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [{ id: "space-bunny-free" }] })]])
    const res = mockRes()
    await zp.router(mockReq({ method: "GET", url: "/health" }), res)
    assert.equal(res.state.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
  })

  test("/health reports ok:false when upstream is down", async () => {
    zp.saveConfig({ cacheMs: 0 })
    globalThis.fetch = routeFetch([["/models", () => { throw new Error("ECONNREFUSED") }]])
    const res = mockRes()
    await zp.router(mockReq({ method: "GET", url: "/health" }), res)
    assert.equal(res.state.status, 200)
    assert.equal(JSON.parse(res.body).ok, false)
  })

  test("unknown route → 404", async () => {
    const res = mockRes()
    await zp.router(mockReq({ method: "GET", url: "/nope" }), res)
    assert.equal(res.state.status, 404)
  })

  test("/api/reset clears stats but keeps the Zen key", async () => {
    zp.saveConfig({ proxyKey: "admin-1", defaultZenKey: "zen-keep-me" })
    zp.requestStats.total = 42
    const res = mockRes()
    await zp.router(
      mockReq({ method: "POST", url: "/api/reset", headers: { authorization: "Bearer admin-1" } }),
      res,
    )
    assert.equal(res.state.status, 200)
    assert.equal(zp.requestStats.total, 0, "reset clears request stats")
    assert.equal(zp.config.defaultZenKey, "zen-keep-me", "reset must not clear the Zen key")
    assert.equal(zp.config.proxyKey, "admin-1", "reset must not clear proxyKey")
  })
})

describe("stream timeout", () => {
  test("relayStream closes the response when the upstream stalls", async () => {
    const m = zp.config.fallbackModels[0]
    const stalled = new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    globalThis.fetch = routeFetch([["/chat/completions", chatStub(m, stalled)]])
    zp.saveConfig({ timeoutMs: 50 })
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [], stream: true }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await Promise.race([
      res.done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("stream did not close within 3s")), 3000)),
    ])
    assert.equal(res.state.status, 200)
  })
})

describe("dashboard XSS hardening (static)", () => {
  test("model ids in JS-string attributes are embedded via jsStr", () => {
    const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
    const lines = html
      .split("\n")
      .filter((l) => (l.includes("onchange=") || l.includes("onclick=")) && (l.includes("setDefault(") || l.includes("testModel(") || l.includes("removeModel(")))
    assert.ok(lines.length > 0, "model-row JS handlers exist")
    for (const l of lines) {
      assert.ok(l.includes("jsStr("), `JS-string handler uses jsStr: ${l.trim()}`)
      assert.ok(
        !l.includes("setDefault('") && !l.includes("testModel('") && !l.includes("removeModel('"),
        `no unescaped JS string arg: ${l.trim()}`,
      )
    }
  })
})

describe("shipped model catalog (models.json)", () => {
  // models.json is the source of truth for the free-model list; the model-sync
  // Action keeps it current and the proxy reads it at startup.
  const REPO_MODELS = new URL("../models.json", import.meta.url)

  test("models.json exists and is a well-formed catalog", () => {
    const parsed = JSON.parse(fs.readFileSync(REPO_MODELS, "utf8"))
    assert.ok(Array.isArray(parsed.models) && parsed.models.length > 0, "has a non-empty models array")
    assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(typeof parsed.upstream, "string")
  })

  test("every shipped id is routable and inside the safe charset", () => {
    const { models } = JSON.parse(fs.readFileSync(REPO_MODELS, "utf8"))
    for (const id of models) {
      assert.match(id, /^[A-Za-z0-9._:@+/%-]+$/)
      assert.ok(!/^jev-/.test(id), `jev-* is served on /systemone, not chat: ${id}`)
      assert.equal(new Set(models).size, models.length, "no duplicates")
    }
  })

  test("the proxy reads its list from models.json", () => {
    const { models } = JSON.parse(fs.readFileSync(REPO_MODELS, "utf8"))
    assert.deepEqual(zp.loadShippedModels(), models)
  })

  test("a missing or broken models.json falls back to a baked-in list", () => {
    const run = (contents) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-catalog-"))
      const file = path.join(dir, "models.json")
      if (contents !== null) fs.writeFileSync(file, contents)
      const script = `import { loadShippedModels } from ${JSON.stringify(new URL("../zen-proxy.mjs", import.meta.url).href)}
console.log(JSON.stringify(loadShippedModels()))`
      try {
        return JSON.parse(
          execFileSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            env: { ...process.env, ZEN_PROXY_MODELS: file },
          }).trim(),
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    assert.ok(run(null).length > 0, "missing file still yields a list")
    assert.ok(run("{ not json").length > 0, "unparseable file still yields a list")
    assert.ok(run(JSON.stringify({ models: [] })).length > 0, "empty catalog still yields a list")
    assert.deepEqual(run(JSON.stringify({ models: ["a-free", 7, "b/../free", ""] })), ["a-free", "b/../free"])
  })
})

describe("model list pinning", () => {
  // A config that carries its own list is pinned and stays pinned. One that only
  // ever held a list shipped by an older build is released so it starts tracking
  // models.json again — otherwise existing installs freeze on a stale list.
  const load = (cfg) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-pin-"))
    const file = path.join(dir, "zen-proxy.json")
    if (cfg !== null) fs.writeFileSync(file, JSON.stringify(cfg))
    const script = `import { config, isFallbackModelsPinned, loadShippedModels } from ${JSON.stringify(new URL("../zen-proxy.mjs", import.meta.url).href)}
console.log(JSON.stringify({ pinned: isFallbackModelsPinned(), n: config.fallbackModels.length, shipped: loadShippedModels().length }))`
    try {
      return {
        state: JSON.parse(
          execFileSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            env: { ...process.env, ZEN_PROXY_CONFIG: file },
          })
            .trim()
            .split("\n")
            .pop(),
        ),
        onDisk: cfg === null ? null : JSON.parse(fs.readFileSync(file, "utf8")),
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("no config file means the list follows models.json", () => {
    const { state } = load(null)
    assert.equal(state.pinned, false)
    assert.equal(state.n, state.shipped)
  })

  test("a config with no list follows models.json", () => {
    const { state } = load({ port: 8787 })
    assert.equal(state.pinned, false)
    assert.equal(state.n, state.shipped)
  })

  test("a genuinely custom list is pinned and kept", () => {
    const { state, onDisk } = load({ fallbackModels: ["space-bunny-free", "not-a-shipped-model"] })
    assert.equal(state.pinned, true)
    assert.equal(state.n, 2)
    assert.deepEqual(onDisk.fallbackModels, ["space-bunny-free", "not-a-shipped-model"])
  })

  test("a list left by an older build is released back to models.json", () => {
    // An older build persisted its default list into the user's config, and the
    // runtime sync pruned dead entries and saved the result — so the stored list
    // is a subset of what we shipped, never a deliberate edit.
    const baked = JSON.parse(fs.readFileSync(new URL("../models.json", import.meta.url), "utf8")).models
    const subset = [baked[0], baked[2]]
    const { state, onDisk } = load({ fallbackModels: subset })
    assert.equal(state.pinned, false, "released")
    assert.equal(state.n, state.shipped)
    assert.equal("fallbackModels" in onDisk, false, "stale key removed from disk")
  })

  test("an unrelated save never re-pins the list", () => {
    // Regression: saveConfig merges the whole in-memory config, so a save
    // triggered by something else (auto-UA refresh, key change) used to write
    // fallbackModels back to disk and freeze this install on today's catalog.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-nopin-"))
    const cfg = path.join(dir, "zen-proxy.json")
    const mod = new URL("../zen-proxy.mjs", import.meta.url).href
    fs.writeFileSync(cfg, JSON.stringify({ port: 8799 }))
    const script = `import { config, saveConfig, isFallbackModelsPinned } from ${JSON.stringify(mod)}
saveConfig({ ua: "opencode/9.9.9" })
console.log(JSON.stringify({ pinned: isFallbackModelsPinned(), n: config.fallbackModels.length }))`
    try {
      const out = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
          env: { ...process.env, ZEN_PROXY_CONFIG: cfg },
        })
          .trim()
          .split("\n")
          .pop(),
      )
      const onDisk = JSON.parse(fs.readFileSync(cfg, "utf8"))
      assert.equal(out.pinned, false)
      assert.equal("fallbackModels" in onDisk, false, "list must not be persisted while following models.json")
      assert.equal(onDisk.ua, "opencode/9.9.9", "the actual change was saved")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("upstream base URL", () => {
  // /zen/v1 still serves /models but answers every inference request with
  // 403 FreeTierError, so a config left pointing at it silently loses the
  // whole free tier. loadConfig has to upgrade it in place.
  const loadWith = (upstream) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-upstream-"))
    const file = path.join(dir, "zen-proxy.json")
    if (upstream === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, JSON.stringify({ upstream }))
    const script = `import { loadConfig } from ${JSON.stringify(new URL("../zen-proxy.mjs", import.meta.url).href)}
console.log(loadConfig().upstream)`
    try {
      return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        // CONFIG_PATH is computed at module load, so the override has to arrive
        // through the environment rather than an assignment inside the script.
        env: { ...process.env, ZEN_PROXY_CONFIG: file },
      })
        // loadConfig logs the migration; the value is the last line it prints.
        .trim()
        .split("\n")
        .pop()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("defaults to the served /inference/v1 base", () => {
    assert.equal(loadWith(null), "https://opencode.ai/inference/v1")
  })

  test("a legacy /zen/v1 config is migrated to /inference/v1", () => {
    assert.equal(loadWith("https://opencode.ai/zen/v1"), "https://opencode.ai/inference/v1")
  })

  test("a legacy /zen config is migrated too", () => {
    assert.equal(loadWith("https://opencode.ai/zen"), "https://opencode.ai/inference/v1")
  })

  test("a trailing slash does not defeat the migration", () => {
    assert.equal(loadWith("https://opencode.ai/zen/v1/"), "https://opencode.ai/inference/v1")
  })

  test("an explicit non-legacy upstream is left alone", () => {
    assert.equal(loadWith("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1")
  })
})

describe("model-sync bot (scripts/sync-models.mjs)", () => {
  // The bot's whole job is to keep models.json equal to the free subset of
  // opencode's public catalog, in a stable order. It must never wipe the file,
  // never re-add a model upstream dropped, and never list a non-chat model.
  //
  // These are async because the stub upstream lives in this process: execFile
  // has to yield so the event loop can answer the bot's request.
  const execFileP = promisify(execFile)
  const SCRIPT_REL = "scripts/sync-models.mjs"

  // Spins up a stub catalog endpoint, runs the bot in a throwaway git repo, and
  // reports what it changed.
  async function runBot({ start, startRaw, upstream, status = 200 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-proxy-bot-"))
    const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" })
    git("init", "-q")
    git("config", "user.email", "bot@test")
    git("config", "user.name", "bot")
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
    fs.copyFileSync(new URL("../scripts/sync-models.mjs", import.meta.url), path.join(dir, SCRIPT_REL))
    if (startRaw !== undefined) fs.writeFileSync(path.join(dir, "models.json"), startRaw)
    else if (start !== null && start !== undefined) fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(start, null, 2))
    git("add", "-A")
    git("commit", "-qm", "seed")
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()

    const server = http.createServer((req, res) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(status === 200 ? JSON.stringify({ object: "list", data: (upstream ?? []).map((id) => ({ id, object: "model" })) }) : "nope")
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    let ok = true
    let log = ""
    try {
      const out = await execFileP(process.execPath, [SCRIPT_REL], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ZEN_URL: `http://127.0.0.1:${server.address().port}/v1` },
      })
      log = out.stdout
    } catch (e) {
      ok = false
      log = `${e.stdout ?? ""}${e.stderr ?? ""}`
    } finally {
      server.close()
    }
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
    const result = { ok, log, committed: before !== after, catalog: JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")) }
    fs.rmSync(dir, { recursive: true, force: true })
    return result
  }

  test("adds newly offered free models, keeps order, drops vanished ones", async () => {
    const r = await runBot({
      start: { models: ["alpha-free", "beta-free", "ghost-free"] },
      upstream: ["alpha-free", "beta-free", "gamma-free", "paid-model", "delta-preview-free", "beta-free"],
    })
    assert.deepEqual(r.catalog.models, ["alpha-free", "beta-free", "delta-preview-free", "gamma-free"])
    assert.equal(r.committed, true)
    assert.match(r.log, /added=\[delta-preview-free, gamma-free\]/)
    assert.match(r.log, /removed=\[ghost-free\]/)
  })

  test("keeps stealth free models that lack the -free suffix", async () => {
    // big-pickle has no suffix upstream; a plain suffix filter would evict it.
    const r = await runBot({ start: null, upstream: ["big-pickle", "alpha-free", "gpt-5"] })
    assert.deepEqual(r.catalog.models, ["alpha-free", "big-pickle"])
  })

  test("never lists jev-* (served on /systemone, not chat)", async () => {
    const r = await runBot({ start: null, upstream: ["alpha-free", "jev-1.13-free", "jev-9-free"] })
    assert.deepEqual(r.catalog.models, ["alpha-free"])
  })

  test("keeps only ids inside the safe charset", async () => {
    // `/` and `.` are legal in provider-qualified ids such as
    // `alibaba/qwen3.7-plus`, so they stay. What must never survive is
    // whitespace, quotes, backslashes or shell metacharacters.
    const r = await runBot({
      start: null,
      upstream: ["alpha-free", "nvidia/nemotron-3-free", "bad id-free", "q\"uote-free", "semi;colon-free", "$(cmd)-free"],
    })
    assert.ok(r.catalog.models.includes("nvidia/nemotron-3-free"), "provider-qualified ids survive")
    assert.deepEqual(r.catalog.models, ["alpha-free", "nvidia/nemotron-3-free"])
  })

  test("is idempotent: an unchanged catalog produces no commit", async () => {
    const upstream = ["alpha-free", "beta-free"]
    const first = await runBot({ start: null, upstream })
    assert.equal(first.committed, true)
    const second = await runBot({ start: first.catalog, upstream })
    assert.equal(second.committed, false, "no commit when nothing changed")
    assert.match(second.log, /unchanged/)
    assert.deepEqual(second.catalog.models, first.catalog.models)
  })

  test("refuses to wipe the catalog when upstream offers no free models", async () => {
    const r = await runBot({ start: { models: ["alpha-free", "beta-free"] }, upstream: ["paid-model"] })
    assert.equal(r.ok, false, "exits non-zero rather than shipping an empty list")
    assert.deepEqual(r.catalog.models, ["alpha-free", "beta-free"], "catalog untouched")
  })

  test("leaves the catalog untouched when upstream errors", async () => {
    const r = await runBot({ start: { models: ["alpha-free"] }, upstream: [], status: 503 })
    assert.equal(r.ok, false)
    assert.deepEqual(r.catalog.models, ["alpha-free"])
  })

  test("bootstraps from a missing catalog", async () => {
    const r = await runBot({ start: null, upstream: ["alpha-free", "beta-free"] })
    assert.deepEqual(r.catalog.models, ["alpha-free", "beta-free"])
  })

  test("recovers from a corrupt catalog", async () => {
    const r = await runBot({ startRaw: "{ not json at all", upstream: ["alpha-free", "beta-free"] })
    assert.equal(r.ok, true)
    assert.deepEqual(r.catalog.models, ["alpha-free", "beta-free"])
  })
})

describe("install.sh config preservation", () => {
  function runInstall(tmp, destPort) {
    const env = {
      ...process.env,
      HOME: toPosix(path.join(tmp, "home")),
      ZEN_PROXY_DIR: toPosix(path.join(tmp, "install")),
      ZEN_PROXY_PORT: String(destPort),
    }
    fs.mkdirSync(env.HOME, { recursive: true })
    execFileSync("bash", ["install.sh", "--local", toPosix(path.join(tmp, "src"))], { env, cwd: REPO_ROOT })
    return env
  }

  test("fresh install creates a default config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zp-install-"))
    const src = path.join(tmp, "src")
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "zen-proxy.mjs"), "console.log('zen-proxy')\n")
    const env = runInstall(tmp, 8899)
    const cfg = JSON.parse(fs.readFileSync(path.join(env.ZEN_PROXY_DIR, "zen-proxy.json"), "utf8"))
    assert.equal(cfg.port, 8899)
    assert.ok(fs.existsSync(path.join(env.ZEN_PROXY_DIR, "zen-proxy.mjs")))
  })

  test("reinstall preserves an existing user config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zp-install-"))
    const src = path.join(tmp, "src")
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "zen-proxy.mjs"), "console.log('zen-proxy')\n")
    fs.writeFileSync(path.join(src, "zen-proxy.json"), JSON.stringify({ src: true, port: 1111 }))
    const env = runInstall(tmp, 8899)
    fs.writeFileSync(path.join(env.ZEN_PROXY_DIR, "zen-proxy.json"), JSON.stringify({ user: true, port: 7777 }))
    // second run = reinstall over an existing install
    execFileSync("bash", ["install.sh", "--local", toPosix(path.join(tmp, "src"))], { env, cwd: REPO_ROOT })
    const cfg = JSON.parse(fs.readFileSync(path.join(env.ZEN_PROXY_DIR, "zen-proxy.json"), "utf8"))
    assert.deepEqual(cfg, { user: true, port: 7777 }, "user config must survive reinstall")
  })

  test("refuses to install into /", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zp-install-"))
    const src = path.join(tmp, "src")
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "zen-proxy.mjs"), "console.log('zen-proxy')\n")
    const env = { ...process.env, HOME: toPosix(path.join(tmp, "home")), ZEN_PROXY_DIR: "/" }
    fs.mkdirSync(env.HOME, { recursive: true })
    assert.throws(() => execFileSync("bash", ["install.sh", "--local", toPosix(src)], { env, cwd: REPO_ROOT }), /Refusing/)
  })
})

describe("install.ps1 config preservation", () => {
  let hasPwsh = false
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "$true"], { stdio: "ignore" })
    hasPwsh = true
  } catch {
    hasPwsh = false
  }

  test(
    "reinstall preserves an existing user config",
    { skip: hasPwsh ? false : "pwsh not available on this host" },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zp-install-"))
      const src = path.join(tmp, "src")
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, "zen-proxy.mjs"), "console.log('zen-proxy')\n")
      fs.writeFileSync(path.join(src, "zen-proxy.json"), JSON.stringify({ src: true, port: 1111 }))
      const dest = path.join(tmp, "install")
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, "zen-proxy.json"), JSON.stringify({ user: true, port: 7777 }))
      const env = {
        ...process.env,
        HOME: path.join(tmp, "home"),
        TEMP: path.join(tmp, "temp"),
        ZEN_PROXY_DIR: dest,
      }
      fs.mkdirSync(env.HOME, { recursive: true })
      fs.mkdirSync(env.TEMP, { recursive: true })
      execFileSync("pwsh", ["-NoProfile", "-File", "install.ps1", "-LocalSrc", src], { env, cwd: REPO_ROOT })
      const cfg = JSON.parse(fs.readFileSync(path.join(dest, "zen-proxy.json"), "utf8"))
      assert.deepEqual(cfg, { user: true, port: 7777 }, "user config must survive reinstall")
    },
  )
})
