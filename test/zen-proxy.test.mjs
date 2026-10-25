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
// The v2 gate's own tool list, in wire order — what merges ahead of any caller
// tools everywhere the manifest rides.
const manifestNames = () => zp.loadAgentTools().map((t) => t.function.name)
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
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value
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

  test("retired models (410 Gone / deprecated) are retryable", () => {
    // The chain must keep walking past a model upstream retired; surfacing its
    // "has been deprecated" error was a real user-visible failure.
    assert.equal(zp.retryableUpstream(410, { error: { type: "ModelDeprecated", message: "The model ll-alpha-free has been deprecated and is no longer available." } }), true)
    assert.equal(zp.retryableUpstream(400, { error: { message: "this model is no longer available" } }), true)
  })

  test("plain client errors are not retryable", () => {
    assert.equal(zp.retryableUpstream(400, { error: { message: "bad request" } }), false)
    assert.equal(zp.retryableUpstream(401, { error: { message: "invalid api key" } }), false)
    assert.equal(zp.retryableUpstream(400, { error: { type: "invalid_request_error" } }), false)
  })
})

describe("transientUpstream", () => {
  test("429, 5xx and provider hiccups are transient (same-model retry)", () => {
    assert.equal(zp.transientUpstream(429, {}), true)
    assert.equal(zp.transientUpstream(500, {}), true)
    assert.equal(zp.transientUpstream(502, {}), true)
    assert.equal(zp.transientUpstream(400, { error: { type: "server_error", message: "hiccup" } }), true)
    assert.equal(zp.transientUpstream(502, { error: { type: "upstream_error" } }), true)
  })

  test("deterministic model verdicts are not transient", () => {
    // Retrying these against the same model cannot help: the gate says no, the
    // geo block says no, the id is retired. They go straight to the next model.
    assert.equal(zp.transientUpstream(403, { error: { type: "FreeTierError", message: "free tier can only be used within OpenCode" } }), false)
    assert.equal(zp.transientUpstream(403, { error: { type: "RegionError", message: "not available in your country" } }), false)
    assert.equal(zp.transientUpstream(410, { error: { type: "ModelDeprecated", message: "deprecated" } }), false)
    assert.equal(zp.transientUpstream(400, { error: { type: "invalid_request_error", message: "bad body" } }), false)
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
    assert.equal(zp.config.ua, "opencode/latest/9.9.9/cli", "UA must track the latest opencode version in the v2 CLI format")
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

  test("410 Gone / deprecated model is pruned immediately", async () => {
    // ll-alpha-free case: upstream retires the id with 410 "has been deprecated".
    // It must leave the user's list on the first sync, not linger for three
    // consecutive failures while every request that reaches it breaks.
    zp.saveConfig({ fallbackModels: ["space-bunny-free", "ll-alpha-free"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", jsonResponse({ data: [{ id: "space-bunny-free" }] })],
      [
        "/chat/completions",
        (u, opts) =>
          JSON.parse(opts.body).model === "ll-alpha-free"
            ? jsonResponse({ error: { type: "ModelDeprecated", message: "The model ll-alpha-free has been deprecated and is no longer available." } }, 410)
            : jsonResponse({ model: "ok", choices: [] }),
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.dead.includes("ll-alpha-free"), "reported dead")
    assert.deepEqual(zp.config.fallbackModels, ["space-bunny-free"], "deprecated model removed from config")
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
      assert.ok(s.gated.includes("mimo-v2.5-free"), "reported as gate-blocked, not flaky")
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

  test("models the gate refuses even for agent-shaped probes are still added", async () => {
    zp.saveConfig({ fallbackModels: [], autoSyncIntervalMs: 0, cacheMs: 0 })
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [{ id: "gated-flash-free" }] })],
      ["/chat/completions", () => jsonResponse({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }, 403)],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.ok(s.gated.includes("gated-flash-free"), "reported as gate-blocked")
    assert.ok(zp.config.fallbackModels.includes("gated-flash-free"), "added, because the block can lift")
  })

  test("health probes are agent-shaped, so the gate accepts them", async () => {
    // The real gate refuses requests without opencode's tool manifest or
    // without streaming; this mock does the same. Bare pings used to land
    // every model in gated, which told the user nothing about whether it
    // actually works.
    const list = ["space-bunny-free", "mimo-v2.5-free"]
    zp.saveConfig({ fallbackModels: [...list], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
    const seen = []
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: list.map((id) => ({ id })) })],
      [
        "/chat/completions",
        (u, opts) => {
          const body = JSON.parse(opts.body)
          seen.push(body)
          const agentShaped = body.stream === true && Array.isArray(body.tools) && body.tools.length > 0
          return agentShaped
            ? jsonResponse({ model: "ok", choices: [] })
            : jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403)
        },
      ],
    ])
    const s = await zp.syncModels()
    assert.equal(s.ok, true)
    assert.deepEqual([...s.working].sort(), [...list].sort(), "both models probe as genuinely working")
    assert.equal(s.gated.length, 0, "nothing is written off as gate-blocked")
    assert.ok(seen.length >= 2 && seen.every((b) => b.stream === true), "every probe streams")
    assert.ok(seen.every((b) => b.tools?.length > 0), "every probe carries the tool manifest")
    assert.ok(
      seen.every((b) => typeof b.messages?.[0]?.content === "string" && b.messages[0].content.startsWith("You are an AI agent running in OpenCode")),
      "every probe rides the harness preamble — a generic system text is refused",
    )
    assert.ok(seen.every((b) => !("tool_choice" in b)), "probes force no tool_choice — the pinned ask keeps the answer text")
  })

  test("responses-format models get an agent-shaped probe on /responses", async () => {
    zp.saveConfig({
      fallbackModels: ["muse-spark-1.3-contributor-free"],
      responsesModels: ["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*"],
      defaultModel: "",
      autoSyncIntervalMs: 0,
      cacheMs: 0,
    })
    let sentBody
    globalThis.fetch = routeFetch([
      ["/models", () => jsonResponse({ data: [] })],
      [
        "/responses",
        (u, opts) => {
          sentBody = JSON.parse(opts.body)
          return jsonResponse({ model: "ok" })
        },
      ],
    ])
    const s = await zp.syncModels()
    assert.ok(s.working.includes("muse-spark-1.3-contributor-free"), "reported working")
    assert.equal(sentBody.stream, true, "responses probe streams too")
    assert.ok(sentBody.instructions?.startsWith("You are an AI agent running in OpenCode"), "the harness preamble rides as instructions")
    assert.ok(sentBody.tools?.length > 0, "responses probe carries converted tools")
    assert.deepEqual(
      sentBody.input,
      [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly OK1 and nothing else." }] }],
      "the input is a real ask, not a bare ping",
    )
    assert.ok(!("tool_choice" in sentBody), "responses payload stays in responses dialect")
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

describe("same-model retries (the chosen model is tried first)", () => {
  // The user's chosen model must serve the request. Transient failures get
  // retried against that same model; only when it really gives up does the
  // chain fall back — and the final error still describes the chosen model.
  const base = { defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 2, retryBackoffMs: 1 }

  test("transient failures retry the chosen model and never call another", async () => {
    zp.saveConfig({ ...base, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (calls.length < 3) return jsonResponse({ error: { type: "server_error", message: "temporary hiccup" } }, 502)
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "ok" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "big-pickle", "big-pickle"], "only the chosen model was called")
    assert.equal(res.state.headers["x-zen-served-by"], undefined, "no fallback happened")
  })

  test("retries exhausted → chain falls back once", async () => {
    zp.saveConfig({ ...base, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === "big-pickle") return jsonResponse({ error: { type: "server_error", message: "down" } }, 502)
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "ok" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "big-pickle", "big-pickle", "space-bunny-free"], "1 + 2 retries, then one fallback")
    assert.equal(res.state.headers["x-zen-served-by"], "space-bunny-free")
    assert.equal(res.state.headers["x-zen-fallback"], "true")
    assert.equal(JSON.parse(res.body).zen_served_by, "space-bunny-free")
  })

  test("deterministic gate failures skip same-model retries but still fall back", async () => {
    zp.saveConfig({ ...base, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === "big-pickle") {
            return jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used within OpenCode" } }, 403)
          }
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "ok" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "space-bunny-free"], "retrying a gate 403 would just waste time")
  })

  test("retriesPerModel: 0 disables same-model retries", async () => {
    zp.saveConfig({ ...base, retriesPerModel: 0, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === "big-pickle") return jsonResponse({ error: { type: "server_error", message: "down" } }, 502)
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "ok" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "space-bunny-free"])
  })

  test("when everything fails, the error is the chosen model's, not the chain tail's", async () => {
    zp.saveConfig({ ...base, retriesPerModel: 0, fallbackModels: ["big-pickle", "space-bunny-free"] })
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          if (sent.model === "big-pickle") {
            return jsonResponse({ error: { type: "free_usage_limit_error", message: "CHOSEN BUSY NOW" } }, 429)
          }
          return jsonResponse({ error: { type: "ModelDeprecated", message: "The model space-bunny-free has been deprecated" } }, 410)
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 429, "not the tail model's 410")
    assert.equal(JSON.parse(res.body).error.message, "CHOSEN BUSY NOW")
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

  test("/api/test sends an agent-shaped probe and an explicit zenKey override", async () => {
    const m = zp.config.fallbackModels[0]
    let sentAuth
    let sentBody
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sentAuth = opts.headers["authorization"]
          sentBody = JSON.parse(opts.body)
          return jsonResponse({ model: "ok", choices: [] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, zenKey: "sk-custom-zen-key" }) })
    const res = mockRes()
    await zp.handleTest(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(sentAuth, "Bearer sk-custom-zen-key")
    assert.equal(sentBody.stream, true, "probe streams like a real client")
    assert.ok(sentBody.tools?.length > 0, "probe carries opencode's tool manifest")
    assert.ok(
      typeof sentBody.messages?.[0]?.content === "string" && sentBody.messages[0].content.startsWith("You are an AI agent running in OpenCode"),
      "probe rides the harness preamble",
    )
    assert.ok(!("tool_choice" in sentBody), "the probe's ask is pinned in the text, not forced on the wire")
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
    // The chat-shaped body gets the harness preamble injected into its system
    // slot before the chat→responses conversion, so it travels as an item.
    assert.match(sentBody.input[0].content, /^You are an AI agent running in OpenCode/)
    assert.deepEqual(sentBody.input[1], { role: "user", content: "hi" })
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
    assert.ok(s.gated.includes("blocked-flash-free"), "reported as gate-blocked, not flaky")
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
  test("free-tier gate refusing even an agent-shaped probe is reported as gated, not as a failure", async () => {
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
    zp.saveConfig({ maxBodyBytes: 1024 * 1024 })
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

  // Body-size limits are configurable (`maxBodyBytes`); the tests pin a small
  // limit so multi-megabyte bodies stay fast, and one pin proves the shipped
  // default is big enough for real compaction payloads.
  const smallBodyLimit = 64 * 1024
  const jsonBodySize = JSON.stringify({ model: "m", messages: [{ role: "user", content: "" }] }).length

  test("default body limit accepts compaction-sized transcripts", () => {
    assert.equal(zp.maxBodyBytes(), zp.MAX_BODY, "unset maxBodyBytes keeps the shipped default")
    assert.ok(zp.MAX_BODY >= 16 * 1024 * 1024, `default ${zp.MAX_BODY} must fit multi-MB compactions`)
  })

  test("a 3MB body passes under the default limit", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok", choices: [] })]])
    const big = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] })
    const req = mockReq({ _body: big })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
  })

  test("oversized body → 413", async () => {
    zp.saveConfig({ maxBodyBytes: smallBodyLimit })
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const big = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(smallBodyLimit + 100) }] })
    const req = mockReq({ _body: big })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
  })

  test("mid-stream abort: oversized body is rejected before the stream is fully drained", async () => {
    zp.saveConfig({ maxBodyBytes: 1024 * 1024 })
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    // 20 chunks of 100KB = ~2MB total, well over the 1MB configured limit. Each
    // chunk is small relative to the limit so the overflow is detected partway
    // through, not on the first or last chunk.
    const chunk = "x".repeat(100 * 1024)
    const chunks = Array.from({ length: 20 }, () => chunk)
    const req = mockStreamingReq(chunks)
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
    assert.ok(req.pulled.count < chunks.length, `expected early abort, pulled ${req.pulled.count}/${chunks.length} chunks`)
    assert.equal(req.pulled.finished, false, "generator must not run to completion")
  })

  test("body exactly at the configured limit → not rejected for size", async () => {
    zp.saveConfig({ maxBodyBytes: smallBodyLimit })
    const limit = zp.maxBodyBytes()
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(limit - jsonBodySize)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, limit, "sanity: body is exactly the limit")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.notEqual(res.state.status, 413)
  })

  test("body one byte over the configured limit → 413", async () => {
    zp.saveConfig({ maxBodyBytes: smallBodyLimit })
    const limit = zp.maxBodyBytes()
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(limit - jsonBodySize + 1)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, limit + 1, "sanity: body is limit + 1")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 413)
  })

  test("body one byte under the configured limit → not 413", async () => {
    zp.saveConfig({ maxBodyBytes: smallBodyLimit })
    const limit = zp.maxBodyBytes()
    globalThis.fetch = routeFetch([["/chat/completions", jsonResponse({ model: "ok" })]])
    const pad = "x".repeat(limit - jsonBodySize - 1)
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: pad }] })
    assert.equal(body.length, limit - 1, "sanity: body is limit - 1")
    const req = mockReq({ _body: body })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.notEqual(res.state.status, 413)
  })

  test("maxBodyBytes: 0 falls back to the shipped default", async () => {
    zp.saveConfig({ maxBodyBytes: 0 })
    assert.equal(zp.maxBodyBytes(), zp.MAX_BODY)
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
    zp.saveConfig({ retriesPerModel: 0 }) // retry-then-fallback is covered in its own describe
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
    zp.saveConfig({ retriesPerModel: 0 })
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

describe("non-streaming requests are collected from upstream streams", () => {
  // The free-tier gate only serves streaming traffic: a non-streaming request
  // gets 403 FreeTierError from every model, which used to walk the whole chain
  // and mark every model failed. The proxy now streams upstream regardless and
  // reassembles the client's requested shape.
  test("a non-stream chat request streams upstream and reassembles JSON", async () => {
    const m = zp.config.fallbackModels[0]
    let sentStream = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          assert.equal(sent.model, m)
          sentStream = sent.stream
          return sseResponse(["Hel", "lo, ", "world"], "upstream-model")
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(sentStream, true, "the gate only serves streams, so upstream must see one")
    assert.equal(res.state.status, 200)
    assert.match(res.state.headers["content-type"], /application\/json/)
    const body = JSON.parse(res.body)
    assert.equal(body.object, "chat.completion")
    assert.equal(body.choices[0].message.role, "assistant")
    assert.equal(body.choices[0].message.content, "Hello, world")
    assert.equal(body.model, m, "the model is rewritten to the requested one")
  })

  test("bridge tool calls the caller never offered are stripped from the reassembled reply", async () => {
    const m = zp.config.fallbackModels[0]
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          assert.equal(JSON.parse(opts.body).stream, true)
          const toolStart = { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"pa' } }
          const toolMore = { index: 0, function: { arguments: 'th":"a"}' } }
          const blocks = [
            { model: "u", choices: [{ delta: { tool_calls: [toolStart] } }] },
            { model: "u", choices: [{ delta: { tool_calls: [toolMore] }, finish_reason: "tool_calls" }] },
          ]
          return new Response(blocks.map((b) => `data: ${JSON.stringify(b)}\n\n`).join("") + "data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    const body = JSON.parse(res.body)
    assert.equal(body.choices[0].message.tool_calls, undefined, "the caller offered no tools, so none may come back")
    assert.equal(body.choices[0].finish_reason, "stop")
  })

  test("/v1/messages non-stream reassembles an upstream stream into Anthropic shape", async () => {
    const m = zp.config.fallbackModels[0]
    let sentStream = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sentStream = JSON.parse(opts.body).stream
          return sseResponse(["hi ", "there"], "upstream-model")
        },
      ],
    ])
    const req = mockReq({
      url: "/v1/messages",
      _body: JSON.stringify({ model: m, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(sentStream, true)
    assert.equal(res.state.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.type, "message")
    assert.equal(body.role, "assistant")
    assert.equal(body.content[0].type, "text")
    assert.equal(body.content[0].text, "hi there")
    assert.equal(body.stop_reason, "end_turn")
  })

  test("a non-stream responses-format request takes the response.completed event", async () => {
    const m = "muse-spark-1.3-contributor-free"
    zp.saveConfig({ responsesModels: ["muse-spark-*"], fallbackModels: [m], defaultModel: m })
    let sentStream = null
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          assert.equal(sent.model, m)
          sentStream = sent.stream
          const completed = {
            type: "response.completed",
            response: {
              id: "resp_1",
              output: [{ type: "message", content: [{ type: "output_text", text: "muse says hi" }] }],
              usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
            },
          }
          return new Response(`data: ${JSON.stringify(completed)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(sentStream, true)
    const body = JSON.parse(res.body)
    assert.equal(body.object, "chat.completion")
    assert.equal(body.choices[0].message.content, "muse says hi")
    assert.equal(body.model, m)
    assert.equal(body.usage.total_tokens, 7)
  })

  test("when every model fails, the feed names the requested model and not the last one tried", async () => {
    zp.saveConfig({ defaultModel: "big-pickle", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0, retryBackoffMs: 1, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const gated = () => jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used within OpenCode" } }, 403)
    globalThis.fetch = routeFetch([
      ["/chat/completions", gated],
      ["/responses", gated],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 403)
    assert.match(res.body, /FreeTierError/, "the requested model's error is surfaced")
    const key = zp.requestStats.recent.at(-1)[0]
    assert.ok(key.endsWith("|big-pickle|403"), `feed row must name the requested model only, got ${key}`)
    assert.ok(!key.includes("→"), "no arrow: nothing served this request")
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
    zp.saveConfig({ maxBodyBytes: 1024 * 1024 })
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
    // The wall is explained, not blamed on a runtime abort gibberish (old
    // message was whatever the environment's default AbortError text is —
    // under bun that spawns the confusing "The operation was aborted.").
    assert.match(res.body, /upstream stalled past the relay wall/)
    assert.match(res.body, /data: \[DONE\]/)
    assert.doesNotMatch(res.body, /aborted|The operation was aborted/)
  })

  test("the headers wall aborts a stream whose upstream never answers, honestly", async () => {
    const m = zp.config.fallbackModels[0]
    // The old stream path passed `req.signal` (undefined on node and current
    // bun) — nothing could abort a pending upstream fetch, so a dead upstream
    // hung the caller's connection forever. The headers wall is the fix.
    // The stub mirrors undici: it rejects when its signal aborts.
    globalThis.fetch = (_url, opts) => {
      return new Promise((_, reject) => {
        opts.signal?.addEventListener("abort", () => reject(opts.signal.reason), { once: true })
      })
    }
    zp.saveConfig({ timeoutMs: 50 })
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [], stream: true }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await Promise.race([
      res.done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("stream did not close within 3s")), 3000)),
    ])
    assert.equal(res.state.status, 502)
    assert.match(res.body, /upstream never responded within 50ms/)
    assert.doesNotMatch(res.body, /The operation was aborted/)
  })

  test("the headers wall is released when upstream answers, so healthy streams are safe", async () => {
    const m = zp.config.fallbackModels[0]
    const good = new Response('data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' + 'data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    zp.saveConfig({ timeoutMs: 50 })
    globalThis.fetch = routeFetch([
      ["/chat/completions",
        async () => {
          // Answer slower than the wall would fire if it were left armed.
          await new Promise((r) => setTimeout(r, 200))
          return good
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [], stream: true }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await Promise.race([res.done, new Promise((_, rej) => setTimeout(() => rej(new Error("no reply within 5s")), 5000))])
    assert.equal(res.state.status, 200)
    assert.match(res.body, /"content":"ok"/)
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

  test("defaults to the served /inference/openai/v1 base", () => {
    assert.equal(loadWith(null), "https://opencode.ai/inference/openai/v1")
  })

  test("a legacy /zen/v1 config is migrated to /inference/openai/v1", () => {
    assert.equal(loadWith("https://opencode.ai/zen/v1"), "https://opencode.ai/inference/openai/v1")
  })

  test("a legacy /zen config is migrated too", () => {
    assert.equal(loadWith("https://opencode.ai/zen"), "https://opencode.ai/inference/openai/v1")
  })

  test("a legacy /inference/v1 base is migrated to the v2 endpoint too", () => {
    assert.equal(loadWith("https://opencode.ai/inference/v1"), "https://opencode.ai/inference/openai/v1")
  })

  test("a trailing slash does not defeat the migration", () => {
    assert.equal(loadWith("https://opencode.ai/zen/v1/"), "https://opencode.ai/inference/openai/v1")
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

describe("Anthropic Messages API layer", () => {
  // Claude Code speaks /v1/messages. Requests are reshaped for the chat endpoint,
  // replies reshaped back, and the caller's tools survive the round trip.
  const req = (body, headers = {}, url = "/v1/messages") =>
    mockReq({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, _body: typeof body === "string" ? body : JSON.stringify(body) })
  const callRoute = async (r) => {
    const res = mockRes()
    await zp.router(r, res)
    try {
      return { status: res.state.status, body: JSON.parse(res.body) }
    } catch {
      return { status: res.state.status, body: res.body }
    }
  }

  test("system blocks and message blocks flatten into chat messages", () => {
    const out = zp.anthropicToChatBody(
      {
        system: [{ type: "text", text: "sys one" }, { type: "text", text: "sys two" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }],
        max_tokens: 512,
      },
      "space-bunny-free",
    )
    const sys = out.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
    assert.match(sys, /sys one[\s\S]*sys two/)
    const user = out.messages.find((m) => m.role === "user")
    // Block objects must be unwrapped, never stringified into "[object Object]".
    assert.equal(user.content, "hello world")
    assert.equal(out.max_tokens, 512)
  })

  test("the caller's system prompt is kept verbatim and never replaced", () => {
    const body = { system: [{ type: "text", text: "CALLER PROMPT MARKER" }], messages: [{ role: "user", content: "hi" }] }
    const out = zp.anthropicToChatBody(body, "m")
    const sys = out.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")
    assert.match(sys, /CALLER PROMPT MARKER/)
  })

  test("tool_use and tool_result become chat tool_calls and role:tool", () => {
    const out = zp.anthropicToChatBody(
      {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }] },
        ],
      },
      "m",
    )
    const call = out.messages.find((m) => m.tool_calls?.length)
    assert.equal(call.tool_calls[0].id, "call_1")
    assert.equal(call.tool_calls[0].function.name, "Read")
    assert.deepEqual(JSON.parse(call.tool_calls[0].function.arguments), { file_path: "/a" })
    const tool = out.messages.find((m) => m.role === "tool")
    assert.equal(tool.tool_call_id, "call_1")
    assert.equal(tool.content, "contents")
  })

  test("anthropic tools convert to chat function tools", () => {
    const tools = zp.anthropicToolsToChat([
      { name: "Read", description: "read it", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ])
    assert.deepEqual(tools, [
      { type: "function", function: { name: "Read", description: "read it", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } } },
    ])
  })

  test("base64 image blocks become data URLs", () => {
    const out = zp.anthropicToChatBody(
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] },
      "m",
    )
    const user = out.messages.find((m) => m.role === "user")
    assert.equal(user.content[0].image_url.url, "data:image/png;base64,AAAA")
  })

  test("images inside a tool_result follow as a user turn (Claude Code Read)", () => {
    // Claude Code delivers every image it reads as an image block inside the
    // tool_result — it used to be dropped, so the model never saw the picture.
    const out = zp.anthropicToChatBody(
      {
        messages: [
          { role: "user", content: "read it" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p.png" } }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } },
                  { type: "text", text: "screenshot attached" },
                ],
              },
            ],
          },
        ],
      },
      "m",
    )
    const tool = out.messages.find((m) => m.role === "tool")
    assert.equal(tool.tool_call_id, "t1")
    assert.equal(tool.content, "screenshot attached", "text stays on the tool message")
    const imgTurn = out.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))
    assert.equal(imgTurn.content[0].image_url.url, "data:image/png;base64,IMG")
    assert.ok(out.messages.indexOf(tool) < out.messages.indexOf(imgTurn), "image follows the tool output")
  })

  test("image-only tool_result keeps the tool round-trip and attaches the picture", () => {
    const out = zp.anthropicToChatBody(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JPG" } }] }] },
        ],
      },
      "m",
    )
    const tool = out.messages.find((m) => m.role === "tool")
    assert.equal(tool.tool_call_id, "t2")
    const imgTurn = out.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))
    assert.equal(imgTurn.content[0].image_url.url, "data:image/jpeg;base64,JPG")
  })

  test("string tool_result content is untouched", () => {
    const out = zp.anthropicToChatBody(
      { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "plain text" }] }] },
      "m",
    )
    assert.equal(out.messages.find((m) => m.role === "tool").content, "plain text")
    assert.ok(!out.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url")))
  })

  test("the chosen model is retried before /v1/messages falls back", async () => {
    zp.saveConfig({ defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 2, retryBackoffMs: 1, fallbackModels: ["big-pickle", "space-bunny-free"] })
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (calls.length === 1) return jsonResponse({ error: { type: "server_error", message: "hiccup" } }, 502)
          return jsonResponse({ model: sent.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }] })
        },
      ],
    ])
    const { status, body } = await callRoute(req({ model: "big-pickle", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }))
    assert.equal(status, 200)
    assert.deepEqual(calls, ["big-pickle", "big-pickle"], "retried in place, no fallback")
    assert.equal(body.model, "big-pickle")
    assert.equal(body.zen_served_by, undefined)
  })

  test("streaming fallback exposes the serving model in headers", async () => {
    zp.saveConfig({ defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0, fallbackModels: ["big-pickle", "space-bunny-free"] })
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          if (sent.model === "big-pickle") {
            return jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used within OpenCode" } }, 403)
          }
          return sseResponse(["hel", "lo"], "upstream-model")
        },
      ],
    ])
    const r = req({ model: "big-pickle", stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    const res = mockRes()
    await zp.router(r, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.equal(res.state.headers["x-zen-served-by"], "space-bunny-free")
    assert.equal(res.state.headers["x-zen-fallback"], "true")
    assert.match(res.body, /event: message_start/)
    assert.match(res.body, /"model":"big-pickle"/, "client's model name preserved in the stream")
  })

  test("the manifest rides in full ahead of the caller's tools", () => {
    // The v2 gate takes opencode's whole manifest on every request. The
    // caller's tools still ride after it — only an exact-name collision with a
    // manifest name is deduped in favour of the gate's own schema.
    const has = zp.anthropicToChatBody({ tools: [{ name: "Read" }, { name: "Write" }], messages: [{ role: "user", content: "x" }] }, "m")
    assert.deepEqual(has.tools.map((t) => t.function.name), [...manifestNames(), "Read", "Write"])
    const none = zp.anthropicToChatBody({ tools: [{ name: "TotallyUniqueTool" }], messages: [{ role: "user", content: "x" }] }, "m")
    assert.deepEqual(none.tools.map((t) => t.function.name), [...manifestNames(), "TotallyUniqueTool"])
    // And it is opencode's real schema — no stub "never call this" helper.
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.ok(none.tools.includes(captured), "the manifest's read rides whole, not a stub")
  })

  test("the caller's own tools are still sent", () => {
    const out = zp.anthropicToChatBody({ tools: [{ name: "Read" }, { name: "Custom" }], messages: [{ role: "user", content: "x" }] }, "m")
    assert.ok(out.tools.some((t) => t.function.name === "Custom"))
    assert.ok(out.tools.some((t) => t.function.name === "read"))
  })

  test("a chat reply becomes an Anthropic message", () => {
    const msg = zp.chatToAnthropic(
      {
        id: "chatcmpl-1",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi there" } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      },
      "space-bunny-free",
    )
    assert.equal(msg.type, "message")
    assert.equal(msg.role, "assistant")
    assert.equal(msg.model, "space-bunny-free")
    assert.deepEqual(msg.content, [{ type: "text", text: "hi there" }])
    assert.equal(msg.stop_reason, "end_turn")
    assert.deepEqual(msg.usage, { input_tokens: 11, output_tokens: 3 })
  })

  test("stop_reason maps tool_calls to tool_use", () => {
    const msg = zp.chatToAnthropic({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"/x"}' } }] } }] }, "m")
    assert.equal(msg.stop_reason, "tool_use")
    assert.deepEqual(msg.content, [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/x" } }])
  })

  test("errors use the Anthropic error envelope", () => {
    assert.deepEqual(zp.anthropicError(403, { error: { type: "FreeTierError", message: "no" } }), {
      status: 403,
      body: { type: "error", error: { type: "permission_error", message: "no" } },
    })
    assert.equal(zp.anthropicError(429, {}).body.error.type, "rate_limit_error")
    assert.equal(zp.anthropicError(500, {}).body.error.type, "api_error")
  })

  test("/v1/messages is routed and rejects a non-object body in Anthropic shape", async () => {
    const { status, body } = await callRoute(req("[]"))
    assert.equal(status, 400)
    assert.equal(body.type, "error")
    assert.equal(body.error.type, "invalid_request_error")
  })

  test("/v1/messages/count_tokens returns a token estimate", async () => {
    const { status, body } = await callRoute(req({ system: "hello", messages: [{ role: "user", content: "world" }] }, {}, "/v1/messages/count_tokens"))
    assert.equal(status, 200)
    assert.equal(typeof body.input_tokens, "number")
    assert.ok(body.input_tokens > 0)
  })
})

describe("opencode tool bridge", () => {
  // The model prefers opencode's lowercase tool names, so calls are renamed on
  // the way back to whatever the caller actually offered.
  test("agent-tools.json is a valid manifest of mapped tools", () => {
    const parsed = JSON.parse(fs.readFileSync(new URL("../agent-tools.json", import.meta.url), "utf8"))
    // The loader accepts a bare array (the v2 capture shape) or {"tools":[…]}.
    const tools = Array.isArray(parsed) ? parsed : parsed.tools
    assert.ok(Array.isArray(tools) && tools.length >= 4, "has tools")
    for (const t of tools) {
      assert.equal(t.type, "function")
      assert.ok(t.function.name)
    }
  })

  test("a tool without type cannot be converted, so the manifest filter rejects it", () => {
    // The bridge spreads the conversion result into the payload. A tool without
    // type converts to undefined, and spreading that killed the process
    // mid-request — hence the type check in loadAgentTools().
    assert.equal(zp.chatToolsToResponses([{ function: { name: "read" } }]), undefined)
    assert.equal(zp.chatToolsToResponses([{ type: "function", function: { name: "read" } }])[0].name, "read")
    for (const t of zp.loadAgentTools()) {
      assert.ok(zp.chatToolsToResponses([t])?.length, `${t.function.name} is not convertible`)
    }
  })

  test("Read tool call is renamed and its argument keys are remapped", async () => {
    const { name, args } = zp.remapAgentTool("read", JSON.stringify({ filePath: "/tmp/a", limit: 10 }))
    assert.equal(name, "Read")
    assert.deepEqual(JSON.parse(args), { file_path: "/tmp/a", limit: 10 })
  })

  test("Edit tool call maps oldString/newString to snake_case", () => {
    const { name, args } = zp.remapAgentTool("edit", JSON.stringify({ filePath: "/f", oldString: "a", newString: "b", replaceAll: true }))
    assert.equal(name, "Edit")
    assert.deepEqual(JSON.parse(args), { file_path: "/f", old_string: "a", new_string: "b", replace_all: true })
  })

  test("an argument with no counterpart is dropped", () => {
    // opencode's bash takes a workdir; Claude Code's Bash has no such field.
    const { args } = zp.remapAgentTool("bash", JSON.stringify({ command: "ls", timeout: 5000, workdir: "/tmp" }))
    assert.deepEqual(JSON.parse(args), { command: "ls", timeout: 5000 })
  })

  test("a call to an unmapped tool is left to the caller", () => {
    assert.equal(zp.remapAgentTool("SomeOtherTool", "{}"), null)
  })

  test("a non-official tool call passes through unchanged", () => {
    const msg = zp.chatToAnthropic({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "t1", function: { name: "TodoWrite", arguments: '{"x":1}' } }] } }] }, "m")
    assert.equal(msg.content[0].name, "TodoWrite")
    assert.deepEqual(msg.content[0].input, { x: 1 })
  })
})

describe("bridge tools on the Anthropic path", () => {
  const bridgeCfg = (m) => zp.saveConfig({ defaultModel: m, fallbackModels: [m], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true })
  const carriesRead = (sent) => (sent.tools ?? []).some((t) => (t.function?.name ?? t.name) === "read")
  const toolCallSse = () =>
    new Response(
      [
        { model: "up", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/etc/hostname"}' } }] } }] },
        { model: "up", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )

  test("a tool-less /v1/messages request carries the whole manifest, pinned off", async () => {
    const m = "space-bunny-free"
    bridgeCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          if (!carriesRead(sent)) return jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier" } }, 403)
          return sseResponse(["ok"], "up")
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify({ model: m, max_tokens: 16, messages: [{ role: "user", content: "title this" }] }) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 200, "the gate takes the bridged manifest")
    assert.deepEqual(
      sent.tools.map((t) => t.function.name),
      zp.loadAgentTools().map((t) => t.function.name),
    )
    assert.equal(sent.tool_choice, "none", "the model must not call a tool the caller never offered")
    assert.equal(sent.stream, true)
  })

  test("a tool-less streaming reply must not leak a bridge tool call", async () => {
    const m = "space-bunny-free"
    bridgeCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => toolCallSse()]])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify({ model: m, max_tokens: 16, stream: true, messages: [{ role: "user", content: "summarize" }] }) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("tool_use"), `a bridge tool call reached the caller: ${res.body}`)
    assert.match(res.body, /"stop_reason":"end_turn"/)
  })

  test("a tool-less non-streaming reply loses its bridge tool call too", async () => {
    const m = "space-bunny-free"
    bridgeCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => toolCallSse()]])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify({ model: m, max_tokens: 16, messages: [{ role: "user", content: "summarize" }] }) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    const body = JSON.parse(res.body)
    assert.ok(!body.content.some((b) => b.type === "tool_use"), "the bridge call is gone")
    assert.equal(body.stop_reason, "end_turn")
  })

  test("an agent /v1/messages request keeps its tools and no pin", async () => {
    const m = "space-bunny-free"
    bridgeCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return sseResponse(["ok"], "up")
        },
      ],
    ])
    const req = mockReq({
      url: "/v1/messages",
      _body: JSON.stringify({
        model: m,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "Read", description: "r", input_schema: { type: "object", properties: {} } }],
      }),
    })
    const res = mockRes()
    await zp.handleMessages(req, res)
    const names = sent.tools.map((t) => t.function.name)
    assert.ok(names.includes("read") && names.includes("Read"), `the bridge plus the caller's tool, got ${names}`)
    assert.equal(sent.tool_choice, undefined, "an agent turn stays free to call tools")
  })
})

describe("free tier gate on the chat path", () => {
  // The gate accepts `read` and 403s bash, edit, write, grep and glob, measured
  // against the live gateway and independently re-checked on the PR. This mock
  // hardcodes that rule, so it cannot catch the gate itself changing — it only
  // catches the proxy sending the wrong tools.
  const carriesRead = (tools) => (tools ?? []).some((t) => (t.function?.name ?? t.name) === "read")

  // Records every outgoing body and 403s unless the manifest came through.
  function recorder(reply) {
    const seen = []
    const handler = (u, opts) => {
      const sent = JSON.parse(opts.body)
      seen.push({ url: String(u), sent })
      if (!carriesRead(sent.tools)) return jsonResponse({ error: { type: "FreeTierError", message: "free tier" } }, 403)
      return reply(sent)
    }
    return { seen, handler }
  }

  const chatReply = (sent) =>
    jsonResponse({ id: "c1", model: sent.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] })
  const responsesReply = (sent) =>
    jsonResponse({ id: "r1", model: sent.model, output: [{ type: "message", content: [{ type: "output_text", text: "yo" }] }] })

  async function post(body, reply = chatReply) {
    const { seen, handler } = recorder(reply)
    globalThis.fetch = routeFetch([["/", handler]])
    const res = mockRes()
    await zp.handleChat(mockReq({ _body: JSON.stringify(body) }), res)
    return { res, seen }
  }

  // Streaming variant: the upstream SSE is passed straight through.
  async function postSse(body, upstream) {
    globalThis.fetch = routeFetch([["/", () => upstream]])
    const res = mockRes()
    await zp.handleChat(mockReq({ _body: JSON.stringify(body) }), res)
    return { res, seen: res.body }
  }

  test("a tool-less chat request carries opencode's whole manifest, pinned off", async () => {
    const { res, seen } = await post({
      model: DEFAULT_MODEL,
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
    })
    assert.equal(res.state.status, 200, "the gate accepts a tool-less caller")
    // opencode sends its full registry on every call, filtering it by relevance
    // never, so the proxy sends the whole manifest too.
    assert.deepEqual(
      seen[0].sent.tools.map((t) => t.function.name),
      zp.loadAgentTools().map((t) => t.function.name),
    )
    assert.equal(seen[0].sent.tool_choice, "none", "the model must not call a tool the caller never offered")
  })

  test("a tool-less responses request is given the same bridge", async () => {
    zp.saveConfig({ responsesModels: ["gpt-5*"], fallbackModels: ["gpt-5.5"], defaultModel: "gpt-5.5" })
    const { res, seen } = await post(
      { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
      responsesReply,
    )
    assert.equal(res.state.status, 200)
    assert.match(seen[0].url, /\/responses$/)
    assert.deepEqual(
      seen[0].sent.tools.map((t) => t.name),
      zp.loadAgentTools().map((t) => t.function.name),
    )
    // The live gateway rejects tool_choice "none" on /responses ("only auto is
    // supported"), so this assertion pins the asymmetry rather than an oversight.
    assert.equal(seen[0].sent.tool_choice, undefined)
  })

  test("a tool-less responses request drops a tool_choice that route cannot take", async () => {
    zp.saveConfig({ responsesModels: ["gpt-5*"], fallbackModels: ["gpt-5.5"], defaultModel: "gpt-5.5" })
    const { res, seen } = await post(
      { model: "gpt-5.5", tool_choice: "none", messages: [{ role: "user", content: "hi" }] },
      responsesReply,
    )
    assert.equal(res.state.status, 200)
    assert.equal(seen[0].sent.tool_choice, undefined, "forwarding it would be a hard upstream error")
  })

  test("a tool-less request that the gateway answers with a tool call gets it stripped", async () => {
    // The gateway ignores tool_choice "none" and emits real tool calls anyway,
    // so pinning alone does not hold: a client like pi hard-fails on a tool call
    // during summarization. The call has to be dropped from the reply.
    const sse = new Response(
      `data: ${JSON.stringify({ model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/etc/hostname"}' } }] } }] })}\n\n` +
        `data: ${JSON.stringify({ model: "up", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const { seen, res } = await postSse({ model: DEFAULT_MODEL, stream: true, messages: [{ role: "user", content: "read /etc/hostname" }] }, sse)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!seen.includes("tool_calls"), `tool call reached the caller: ${seen}`)
    assert.ok(!seen.includes('"finish_reason":"tool_calls"'), "finish_reason still claims a tool call")
  })

  test("a tool-less non-streaming reply loses its tool call too", async () => {
    const body = { id: "c1", model: "up", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] } }] }
    const { res } = await post(
      { model: DEFAULT_MODEL, messages: [{ role: "user", content: "read it" }] },
      () => jsonResponse(body),
    )
    assert.equal(res.state.status, 200)
    assert.deepEqual(JSON.parse(res.body).choices[0].message.tool_calls, undefined)
  })

  test("an agent request keeps its tool calls", async () => {
    const body = { id: "c1", model: "up", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] } }] }
    const { res } = await post(
      {
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: "read it" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      },
      () => jsonResponse(body),
    )
    assert.equal(JSON.parse(res.body).choices[0].message.tool_calls[0].function.name, "read")
  })

  test("a caller's own tools are left runnable — no tool_choice pinning", async () => {
    const { seen } = await post({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    })
    // The manifest rides ahead of the caller's tools; the caller's `read`
    // carries the same name as the manifest's, so it dedupes into it.
    assert.deepEqual(seen[0].sent.tools.map((t) => t.function.name), manifestNames(), "manifest first, no duplicate caller read")
    assert.equal(seen[0].sent.tool_choice, undefined, "an agent turn must still be free to call tools")
  })

  test("agentTools:false keeps meaning never inject", async () => {
    zp.saveConfig({ agentTools: false })
    const { seen } = await post({ model: DEFAULT_MODEL, messages: [{ role: "user", content: "hi" }] })
    assert.equal(seen[0].sent.tools, undefined)
    assert.equal(seen[0].sent.tool_choice, undefined)
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

describe("pinned tool calls on the OpenAI-shaped routes", () => {
  const pinnedCfg = (m) =>
    zp.saveConfig({
      defaultModel: m,
      fallbackModels: [m],
      retriesPerModel: 0,
      retryBackoffMs: 1,
      autoSyncIntervalMs: 0,
      cacheMs: 0,
      agentTools: true,
    })
  const carriesRead = (sent) => (sent.tools ?? []).some((t) => (t.function?.name ?? t.name) === "read")
  const gated = () =>
    jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403)
  // A title helper: one tool, and `tool_choice` names the only call it accepts.
  const setName = {
    type: "function",
    function: {
      name: "set_title",
      description: "Set the conversation title",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
  }
  const readStub = { type: "function", function: { name: "read", description: "the caller's own read", parameters: { type: "object", properties: {} } } }
  const pinned = (model, extra = {}) => ({
    model,
    messages: [{ role: "user", content: "title this conversation" }],
    tools: [setName],
    tool_choice: { type: "function", function: { name: "set_title" } },
    ...extra,
  })

  test("a pinned caller gets the manifest ahead of its own tool", async () => {
    const m = "space-bunny-free"
    pinnedCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          if (!carriesRead(sent)) return gated()
          return sseResponse(["ok"], "up")
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m)) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200, "the gate takes a pinned request that carries the manifest")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"], "the manifest rides first, the caller's tool stays")
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.deepEqual(
      sent.tools.find((t) => t.function.name === "read"),
      captured,
      "the read on the list is opencode's captured schema, not a stub",
    )
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "set_title" } }, "the pin is forwarded untouched")
  })

  test("the manifest's read rides whole — never a stub", async () => {
    // A stub "never call this tool" helper used to be injected for the gate;
    // since the v2 manifest the real schema rides, and its call is renamed back
    // (or dropped) at the reply layer.
    const m = "space-bunny-free"
    pinnedCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m)) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.ok(captured, "the captured manifest still carries opencode's read")
    const sentRead = sent.tools.find((t) => t.function.name === "read")
    assert.deepEqual(sentRead, captured, "the sent read is opencode's schema verbatim")
  })

  test("a caller that offers its own read gets no duplicate", async () => {
    const m = "space-bunny-free"
    pinnedCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m, { tools: [readStub, setName] })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(sent.tools.filter((t) => t.function.name === "read").length, 1, "exactly one read on the list")
    // The caller's read and the manifest's share a name; the manifest's is the
    // one that survives the dedupe (and the reply layer handles its calls).
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.deepEqual(sent.tools.find((t) => t.function.name === "read"), captured, "the caller's stub loses to the manifest's real read")
    assert.ok(sent.tools.some((t) => t.function.name === "set_title"), "the caller's own tool stays")
  })

  test("an unpinned tool caller gets the manifest riding along", async () => {
    const m = "space-bunny-free"
    pinnedCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: m, messages: [{ role: "user", content: "title this" }], tools: [setName] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    // Measured against the live gateway 2026-10-21 (issue #20) — a bare caller
    // list was refused, and the v2 gate now wants the whole manifest.
    assert.equal(res.state.status, 200, "the manifest satisfies the gate")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"])
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.deepEqual(sent.tools.find((t) => t.function.name === "read"), captured, "no stub rides — it is opencode's read")
  })

  test("a string tool_choice is not a pin — the manifest rides instead", async () => {
    const m = "space-bunny-free"
    pinnedCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m, { tool_choice: "required" })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200, "the manifest satisfies the gate")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"])
    assert.equal(sent.tool_choice, "required")
  })

  test("agentTools: false never injects", async () => {
    const m = "space-bunny-free"
    pinnedCfg(m)
    zp.saveConfig({ agentTools: false })
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m)) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 403)
    assert.deepEqual(sent.tools.map((t) => t.function.name), ["set_title"])
  })

  test("a responses-family model gets read too, pin translated", async () => {
    // This is the Responses *upstream* format, reached through the chat route
    // because the model lives on /responses. The chat-shaped body still talks
    // chat; a real Responses body on the /responses route leg now travels as
    // Responses (see "the /v1/responses route speaks Responses").
    const m = "gpt-5.5"
    pinnedCfg(m)
    zp.saveConfig({ responsesModels: ["gpt-5*"] })
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          if (!carriesRead(sent)) return gated()
          return jsonResponse({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "Yo" }] }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinned(m, { stream: false })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(sent.tools.map((t) => t.name), [...manifestNames(), "set_title"], "the manifest rides ahead of the caller's tool")
    assert.deepEqual(sent.tool_choice, { type: "function", name: "set_title" }, "the pin survives the responses shape")
  })
})

describe("pinned tool calls on the Anthropic route", () => {
  const pinCfg = (m) =>
    zp.saveConfig({ defaultModel: m, fallbackModels: [m], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true })
  const carriesRead = (sent) => (sent.tools ?? []).some((t) => (t.function?.name ?? t.name) === "read")
  const gated = () =>
    jsonResponse({ type: "error", error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }, 403)
  const anthroBody = (model, extra = {}) => ({
    model,
    max_tokens: 32,
    tools: [
      {
        name: "set_title",
        description: "Set the conversation title",
        input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
    ],
    tool_choice: { type: "tool", name: "set_title" },
    messages: [{ role: "user", content: "title this conversation" }],
    ...extra,
  })
  // Name chunk first, argument chunks after it under the same `index` — that is
  // how a streamed tool call actually arrives.
  const callsSse = (calls) =>
    new Response(
      [
        ...calls.flatMap((c) => [
          {
            model: "up",
            choices: [{ delta: { tool_calls: [{ index: c.index, id: c.id ?? `call_${c.index}`, type: "function", function: { name: c.name, arguments: "" } }] } }],
          },
          ...c.args.map((a) => ({ model: "up", choices: [{ delta: { tool_calls: [{ index: c.index, function: { arguments: a } }] } }] })),
        ]),
        { model: "up", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  const strayAndPinned = () =>
    callsSse([
      // A call the caller never offered — exactly what a provider that ignores
      // the pin answers with (measured 3-6 of 12 against the live gateway).
      { index: 0, name: "read", args: ['{"filePath": ', '"/etc/hostname"}'] },
      { index: 1, name: "set_title", args: ['{"title": ', '"Hostname Check"}'] },
    ])

  test("a pinned /v1/messages request carries the manifest", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          if (!carriesRead(sent)) return gated()
          return sseResponse(["ok"], "up")
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m)) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 200, "the gate takes a pinned request that carries the manifest")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"], "the manifest rides first, the caller's tool stays")
    const captured = zp.loadAgentTools().find((t) => t.function.name === "read")
    assert.deepEqual(
      sent.tools.find((t) => t.function.name === "read"),
      captured,
      "the read on the list is opencode's captured schema, not a stub",
    )
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "set_title" } }, "the pin is forwarded in chat vocabulary")
  })

  test("the manifest's read does not double up with a caller's Read", async () => {
    // `Read` and `read` do not collide by case, so a caller with a Read keeps
    // it; the manifest supplies the lowercase read the gate needs, once.
    const m = "space-bunny-free"
    pinCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const body = anthroBody(m, {
      tools: [
        { name: "Read", description: "r", input_schema: { type: "object", properties: {} } },
        ...anthroBody(m).tools,
      ],
    })
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(body) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(sent.tools.filter((t) => t.function.name === "read").length, 1, "exactly one read on the list")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "Read", "set_title"])
  })

  test("an unpinned helper caller gets the manifest too (issue #20)", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m, { tool_choice: { type: "auto" } })) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 200, "tool_choice auto used to ride bare and eat a 403 per model")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"])
  })

  test("agentTools: false never injects on the Anthropic route", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    zp.saveConfig({ agentTools: false })
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return carriesRead(sent) ? sseResponse(["ok"], "up") : gated()
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m)) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 403)
    assert.deepEqual(sent.tools.map((t) => t.function.name), ["set_title"])
  })

  test("a pinned non-streaming reply keeps the pinned call and drops the rest", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => strayAndPinned()]])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m)) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    const body = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    const calls = body.content.filter((b) => b.type === "tool_use")
    assert.equal(calls.length, 1, "only the pinned call comes through")
    assert.equal(calls[0].name, "set_title")
    assert.deepEqual(calls[0].input, { title: "Hostname Check" })
    assert.equal(body.stop_reason, "tool_use")
    assert.ok(!body.content.some((b) => b.type === "tool_use" && b.name === "Read"), "the stray read never gets renamed in")
  })

  test("a pinned streaming reply drops a stray call and its argument chunks too", async () => {
    // The hard half of the fix: `read`'s name arrives in the first chunk and its
    // arguments in later chunks under the same index. A strip that only looked
    // at the named chunk would still leak `{"filePath": "/etc/hostname"}`.
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => strayAndPinned()]])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    const starts = [...res.body.matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]*)"/g)].map((x) => x[1])
    assert.deepEqual(starts, ["set_title"], "only the pinned block is opened")
    assert.ok(!res.body.includes("filePath"), `a stray call's arguments leaked: ${res.body}`)
    assert.ok(
      res.body.includes('"partial_json":"{\\"title\\": \\"Hostname Check\\"}"'),
      `the pinned call's arguments must arrive whole: ${res.body}`,
    )
    assert.match(res.body, /"stop_reason":"tool_use"/)
  })

  test("a pinned streaming reply that answers only with stray calls ends end_turn", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => callsSse([{ index: 0, name: "read", args: ['{"filePath": "/etc/hostname"}'] }])],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthroBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("tool_use"), `a stray call reached the caller: ${res.body}`)
    assert.match(res.body, /"stop_reason":"end_turn"/)
  })
})

describe("pinned replies on the OpenAI-shaped routes", () => {
  const pinCfg = (m) =>
    zp.saveConfig({ defaultModel: m, fallbackModels: [m], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true })
  // A pinned OpenAI caller as a forced-tool helper would write it.
  const pinnedBody = (model, extra = {}) => ({
    model,
    stream: false,
    messages: [{ role: "user", content: "You can read /etc/hostname first. Then title the thread." }],
    tools: [
      { type: "function", function: { name: "set_title", description: "d", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } },
    ],
    tool_choice: { type: "function", function: { name: "set_title" } },
    ...extra,
  })
  // name chunk first, argument chunks after it under the same index
  const callsSse = (calls) =>
    new Response(
      [
        ...calls.flatMap((c) => [
          {
            model: "up",
            choices: [{ delta: { tool_calls: [{ index: c.index, id: c.id ?? `call_${c.index}`, type: "function", function: { name: c.name, arguments: "" } }] } }],
          },
          ...c.args.map((a) => ({ model: "up", choices: [{ delta: { tool_calls: [{ index: c.index, function: { arguments: a } }] } }] })),
        ]),
        { model: "up", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  const strayFirst = () =>
    callsSse([
      { index: 0, name: "read", args: ['{"filePath": ', '"/etc/hostname"}'] },
      { index: 1, name: "set_title", args: ['{"title": ', '"Hostname Check"}'] },
    ])

  test("a collected pinned reply keeps the pinned call and drops a stray one", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => strayFirst()]])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m)) })
    const res = mockRes()
    await zp.handleChat(req, res)
    const body = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    assert.ok(!body.choices[0].message.tool_calls.some((t) => t.function.name === "read"), "no stray call survived")
    assert.deepEqual(body.choices[0].message.tool_calls, [
      { id: "call_1", type: "function", function: { name: "set_title", arguments: '{"title": "Hostname Check"}' } },
    ])
    assert.equal(body.choices[0].finish_reason, "tool_calls", "a kept call is still a tool call")
  })

  test("a collected pinned reply that got only stray calls ends stop", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => callsSse([{ index: 0, name: "read", args: ['{"filePath": "/etc/hostname"}'] }])],
    ])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m)) })
    const res = mockRes()
    await zp.handleChat(req, res)
    const body = JSON.parse(res.body)
    assert.equal(body.choices[0].message.tool_calls, undefined, "no call left to claim")
    assert.equal(body.choices[0].finish_reason, "stop", "an empty tool_calls claim would read like a bug")
  })

  test("a streamed pinned reply drops the stray call's argument chunks too", async () => {
    // The state test: `read`'s name arrives in chunk 1 and its arguments keep
    // arriving later under the same index. A block-local strip leaks them.
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => strayFirst()]])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("filePath"), `the stray call's arguments leaked: ${res.body}`)
    assert.ok(res.body.includes('"name":"set_title"'))
    // The kept call is renumbered to 0 — the stray call's gap is closed.
    assert.ok(res.body.includes('"tool_calls":[{"index":0,'), `kept call renumbered: ${res.body}`)
    assert.match(res.body, /"finish_reason":"tool_calls"/)
  })

  test("a streamed pinned reply with no kept call ends stop", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => callsSse([{ index: 0, name: "read", args: ['{"filePath": "/etc/hostname"}'] }])],
    ])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("filePath") && !res.body.includes('"name":"read"'))
    assert.match(res.body, /"finish_reason":"stop"/)
  })

  test("several kept calls keep their order and renumber into one run", async () => {
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        () =>
          callsSse([
            { index: 0, name: "read", args: ['{"filePath": "/etc/hostname"}'] },
            { index: 1, name: "set_title", args: ['{"title": "A"}'] },
            { index: 2, name: "set_title", args: ['{"title": "B"}'] },
          ]),
      ],
    ])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    const indices = [...new Set([...res.body.matchAll(/"tool_calls":\[\{"index":(\d+),/g)].map((x) => Number(x[1])))]
    assert.deepEqual(indices, [0, 1], "kept calls are renumbered into one run")
    assert.ok(!res.body.includes("filePath"))
    assert.ok(res.body.includes('\\"A\\"') && res.body.includes('\\"B\\"'), "both kept calls carry their full arguments")
  })

  test("an unpinned reply drops the gate stub's call", async () => {
    // The stub rides on every tool-carrying caller without a `read` (issue #20),
    // and a reply may still call it — the model picked the "never call this"
    // helper. That is a tool the caller never offered, so the stream loses the
    // call and the tool_calls claim does not survive with nothing behind it.
    const m = "space-bunny-free"
    pinCfg(m)
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => callsSse([{ index: 0, name: "read", args: ['{"filePath": "/etc/hostname"}'] }])],
    ])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m, { tool_choice: "auto" })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes('"name":"read"'), `the stub's call is dropped: ${res.body}`)
    assert.ok(!res.body.includes("filePath"), "the stub's arguments never leak either")
    assert.match(res.body, /"finish_reason":"stop"/, "no calls survive, so no tool_calls claim")
  })

  test("a responses-family pinned stream drops stray calls from its deltas", async () => {
    // The chat route reaches /responses upstream for responses-family models;
    // the pinned filter has to work in that relay too.
    const m = "gpt-5.5"
    pinCfg(m)
    zp.saveConfig({ responsesModels: ["gpt-5*"] })
    const sse =
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cr", id: "fc_r", name: "read" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "cr", delta: '{"filePath": "/e"}' })}\n\n` +
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cs", id: "fc_s", name: "set_title" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "cs", delta: '{"title": "hi"}' })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`
    globalThis.fetch = routeFetch([
      ["/responses", () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })],
    ])
    const req = mockReq({ _body: JSON.stringify(pinnedBody(m, { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("filePath"), `a stray responses-family call leaked: ${res.body}`)
    assert.ok(res.body.includes('"name":"set_title"') && res.body.includes('"id":"cs"'))
    assert.match(res.body, /"finish_reason":"tool_calls"/)
  })
})

describe("the /v1/responses route speaks Responses", () => {
  const cfg = (extra = {}) =>
    zp.saveConfig({ defaultModel: "big-pickle", fallbackModels: ["big-pickle"], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true, responsesModels: ["gpt-5*"], ...extra })
  const responsesBody = (model, input, extra = {}) => ({ model, input, ...extra })
  const chatSse = (text, usage) =>
    new Response(
      [
        { model: "up", choices: [{ delta: { content: text } }] },
        { model: "up", choices: [{ delta: {} }], usage },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )

  test("a real Responses body is accepted and answered in Responses shape", async () => {
    cfg()
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return chatSse("Hello there, friend!")
        },
      ],
    ])
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("big-pickle", "Say hello in three words.")) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    assert.equal(res.state.status, 200, `this exact body used to die with a bare 400: ${res.body}`)
    // The gate's harness preamble rides as a system message ahead of the input.
    assert.match(sent.messages[0].content, /^You are an AI agent running in OpenCode/)
    assert.deepEqual(sent.messages[1], { role: "user", content: "Say hello in three words." }, "the input became the message")
    const data = JSON.parse(res.body)
    assert.equal(data.object, "response")
    assert.equal(data.status, "completed")
    assert.equal(data.model, "big-pickle")
    assert.equal(data.output[0].type, "message")
    assert.equal(data.output[0].content[0].type, "output_text")
    assert.equal(data.output[0].content[0].text, "Hello there, friend!")
  })

  test("input item lists become chat messages, instructions become the system message", async () => {
    cfg()
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return chatSse("ok")
        },
      ],
    ])
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "check the file" }] },
      { type: "reasoning", summary: [{ text: "internal state nobody can replay" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"filePath":"/x"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("big-pickle", input, { instructions: "be brief" })) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    assert.equal(res.state.status, 200)
    // The harness preamble is prepended to the caller's instructions; the
    // caller's text follows it in the same system message.
    assert.match(sent.messages[0].content, /^You are an AI agent running in OpenCode/)
    assert.match(sent.messages[0].content, /be brief$/, "the caller's instructions follow the preamble")
    assert.deepEqual(sent.messages[1], { role: "user", content: [{ type: "text", text: "check the file" }] })
    assert.deepEqual(sent.messages[2].tool_calls, [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"/x"}' } }])
    assert.deepEqual(sent.messages[3], { role: "tool", tool_call_id: "call_1", content: "contents" })
  })

  test("Responses tools ride the pinned-caller rule on both families", async () => {
    cfg()
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return chatSse("ok")
        },
      ],
    ])
    const body = responsesBody("big-pickle", "title this", {
      tools: [{ type: "function", name: "set_title", description: "d", parameters: { type: "object", properties: { title: { type: "string" } } } }],
      tool_choice: { type: "function", name: "set_title" },
    })
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(body) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    assert.equal(res.state.status, 200)
    // The manifest rides ahead of the caller's tool; the pin is carried in
    // chat vocabulary for the chat-family endpoint.
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"])
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "set_title" } })
  })

  test("a native /responses model gets the input untranslated", async () => {
    // The translation must not round-trip a Responses client through chat and
    // lose the input before it leaves: on a responses-family model the items
    // go out as items.
    cfg({ defaultModel: "gpt-5.5", fallbackModels: ["gpt-5.5"] })
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return jsonResponse({
            id: "resp_up",
            object: "response",
            status: "completed",
            model: "upstream-model",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] }],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          })
        },
      ],
    ])
    const input = [{ type: "message", role: "user", content: [{ type: "input_image", url: "data:image/png;base64,xx" }, { type: "input_text", text: "what is this" }] }]
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("gpt-5.5", input)) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    assert.equal(res.state.status, 200)
    // The caller's items travel as items — the harness preamble lands in the
    // system slot the passthrough prepends, ahead of the caller's own.
    const preamble = fs.readFileSync(new URL("../agent-preamble.txt", import.meta.url), "utf8")
    assert.deepEqual(sent.input[0], { type: "message", role: "system", content: preamble }, "the preamble rides as the system item")
    assert.deepEqual(sent.input[1], input[0], "the caller's items follow untranslated")
    const data = JSON.parse(res.body)
    assert.equal(data.object, "response")
    assert.equal(data.model, "gpt-5.5", "the client asked for this model, not the one upstream names")
    assert.deepEqual(data.output, [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] }])
  })

  test("streaming a chat-family model emits a live Responses SSE", async () => {
    cfg()
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        () =>
          chatSse("Hel", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
      ],
    ])
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("big-pickle", "Say hi", { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    await res.done
    assert.equal(res.state.status, 200)
    const types = [...res.body.matchAll(/event: ([a-z_.]+)/g)].map((m) => m[1])
    assert.ok(types[0] === "response.created")
    assert.ok(types.includes("response.output_text.delta"))
    assert.ok(types.includes("response.output_text.done"))
    assert.ok(types.includes("response.completed"))
    assert.equal(types[types.length - 1], "response.completed", "Responses SSE ends on completed, not [DONE]")
    assert.ok(!res.body.includes("[DONE]"))
    const completed = JSON.parse(res.body.match(/event: response\.completed\ndata: (.*)\n/)[1])
    assert.equal(completed.response.status, "completed")
    assert.equal(completed.response.output[0].content[0].text, "Hel")
    assert.deepEqual(completed.response.usage, { input_tokens: 3, output_tokens: 1, total_tokens: 4 })
  })

  test("streaming a chat-family model that answers with the pinned call", async () => {
    cfg()
    const calleeSse = new Response(
      [
        { model: "up", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "set_title", arguments: "" } }] } }] },
        { model: "up", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"title": ' } }] } }] },
        { model: "up", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Hosted"}' } }] } }] },
        { model: "up", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    globalThis.fetch = routeFetch([["/chat/completions", () => calleeSse]])
    const body = responsesBody("big-pickle", "title this", {
      stream: true,
      tools: [{ type: "function", name: "set_title", description: "d", parameters: { type: "object", properties: { title: { type: "string" } } } }],
      tool_choice: { type: "function", name: "set_title" },
    })
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(body) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(res.body.includes('"type":"function_call"'))
    assert.match(res.body, /"name":"set_title"/)
    assert.match(res.body, /"arguments":"\{\\"title\\": \\"Hosted\\"\}"/, "the pinned call's arguments arrive whole")
  })

  test("streaming a native /responses model passes its SSE through, rewritten", async () => {
    cfg({ defaultModel: "gpt-5.5", fallbackModels: ["gpt-5.5"] })
    const sse =
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "he" })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_x", object: "response", model: "upstream-model", output: [] } })}\n\n`
    globalThis.fetch = routeFetch([
      ["/responses", () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })],
    ])
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("gpt-5.5", "hi", { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    await res.done
    assert.equal(res.state.status, 200)
    assert.match(res.body, /event: response\.output_text\.delta/)
    assert.match(res.body, /"delta":"he"/)
    assert.ok(!res.body.includes('"model":"upstream-model"'), "the served model id is rewritten")
    assert.ok(res.body.includes('"object":"response"'))
  })

  test("the bridged manifest never leaks into a Responses stream", async () => {
    // A tool-less client on /responses gets opencode's manifest for the gate;
    // whatever the model answers with a manifest tool call cannot reach the
    // caller, same as on the chat-shaped leg.
    cfg({ defaultModel: "gpt-5.5", fallbackModels: ["gpt-5.5"] })
    let sent = null
    const sse =
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { object: "response", model: "upstream-model" } })}\n\n` +
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_9", id: "fc_9", name: "read" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "call_9", delta: '{"filePath": "/e"}' })}\n\n` +
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_9", id: "fc_9", name: "read", arguments: '{"filePath": "/e"}' } })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { object: "response", model: "upstream-model", output: [{ type: "function_call", call_id: "call_9", name: "read", arguments: '{"filePath": "/e"}' }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] } })}\n\n`
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        },
      ],
    ])
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(responsesBody("gpt-5.5", "summarize", { stream: true })) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    await res.done
    assert.equal(res.state.status, 200)
    assert.equal(sent.tool_choice, undefined, "the bridge takes auto on /responses upstream")
    assert.ok(sent.tools.some((t) => t.name === "read"), "the gate took the manifest")
    assert.ok(!res.body.includes("filePath"), `a bridge call leaked into the stream: ${res.body}`)
    const completed = JSON.parse(res.body.match(/event: response\.completed\ndata: (.*)\n/)[1])
    assert.deepEqual(
      completed.response.output.filter((i) => i?.type === "function_call"),
      [],
      "the completed object carries no manifest call",
    )
  })

  test("a pinned Responses stream keeps only the pinned call", async () => {
    cfg({ defaultModel: "gpt-5.5", fallbackModels: ["gpt-5.5"] })
    const sse =
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_r", id: "fc_r", name: "read" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "call_r", delta: '{"filePath": "/e"}' })}\n\n` +
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_s", id: "fc_s", name: "set_title" } })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { object: "response", model: "upstream-model", output: [{ type: "function_call", call_id: "call_r", name: "read", arguments: '{"filePath": "/e"}' }, { type: "function_call", call_id: "call_s", name: "set_title", arguments: '{"title":"hi"}' }] } })}\n\n`
    globalThis.fetch = routeFetch([
      ["/responses", () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })],
    ])
    const body = responsesBody("gpt-5.5", "title this", {
      stream: true,
      tools: [{ type: "function", name: "set_title", description: "d", parameters: { type: "object", properties: { title: { type: "string" } } } }],
      tool_choice: { type: "function", name: "set_title" },
    })
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(body) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(!res.body.includes("filePath"), `a stray call leaked into a pinned Responses stream: ${res.body}`)
    assert.ok(res.body.includes('"call_id":"call_s"') || res.body.includes('call_s'))
    const completed = JSON.parse(res.body.match(/event: response\.completed\ndata: (.*)\n/)[1])
    assert.deepEqual(
      completed.response.output.map((i) => i?.name),
      ["set_title"],
    )
  })

  test("a chat-shaped body on /v1/responses keeps its chat reply", async () => {
    // Compatibility: everything that works today keeps working.
    cfg()
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return chatSse("Hello there, friend!")
        },
      ],
    ])
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "Say hello in three words." }] }) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    assert.equal(res.state.status, 200)
    assert.equal(JSON.parse(res.body).object, "chat.completion")
    // The chat-shaped body gets the preamble injected into a system message.
    assert.match(sent.messages[0].content, /^You are an AI agent running in OpenCode/)
    assert.deepEqual(sent.messages[1], { role: "user", content: "Say hello in three words." })
  })

  test("unit: responsesInputToMessages handles string, items and reasoning", () => {
    assert.deepEqual(zp.responsesInputToMessages("hello"), [{ role: "user", content: "hello" }])
    assert.deepEqual(zp.responsesInputToMessages(undefined), [])
    const out = zp.responsesInputToMessages([
      { type: "message", role: "assistant", content: "hi" },
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "c1", name: "ls", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
    ])
    assert.deepEqual(out, [
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ])
  })

  test("unit: chatToResponses shapes a completion back into a begin response", () => {
    const data = zp.chatToResponses(
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 123,
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "looking", tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: '{"p":1}' } }] } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
      "big-pickle",
    )
    assert.equal(data.id, "resp_chatcmpl_1")
    assert.equal(data.object, "response")
    assert.equal(data.status, "completed")
    assert.equal(data.model, "big-pickle")
    assert.deepEqual(data.output, [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "looking", annotations: [] }] },
      { type: "function_call", id: "call_9", call_id: "call_9", name: "read", arguments: '{"p":1}' },
    ])
    assert.deepEqual(data.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 })
  })
})

describe("upstream error bodies that cannot be parsed (measured: text/plain 4xx used to walk the whole chain)", () => {
  beforeEach(() => {
    zp.saveConfig({ fallbackModels: ["big-pickle", "space-bunny-free"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0 })
  })

  test("text 400 surfaces verbatim instead of walking the fallback chain", async () => {
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          return new Response("boom", { status: 400, headers: { "content-type": "text/plain" } })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 400)
    assert.deepEqual(calls, ["big-pickle"], "a deterministic 400 needs exactly one upstream call")
    const data = JSON.parse(res.body)
    assert.equal(data.error.message, "upstream returned 400")
  })

  test("text 400 on /v1/messages keeps the anthropic error shape", async () => {
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          return new Response("boom", { status: 400, headers: { "content-type": "text/plain" } })
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify({ model: "big-pickle", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 400)
    assert.deepEqual(calls, ["big-pickle"])
    assert.equal(JSON.parse(res.body).error.type, "invalid_request_error")
  })

  test("text 5xx keeps walking the chain (status alone is enough)", async () => {
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === "big-pickle") return new Response("down", { status: 500, headers: { "content-type": "text/plain" } })
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "ok" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "space-bunny-free"])
    assert.equal(res.state.headers["x-zen-served-by"], "space-bunny-free")
  })
})

describe("a reply that dies in flight (measured: collect failures used to 502 with the chain untried)", () => {
  // Upstream answers 200 + SSE but never finishes: a mid-stream error chunk
  // (d.error), a mid-body cut (RST), or a stream that simply stops. Nothing has
  // reached the client when the collect fails, so the chain still applies.
  beforeEach(() => {
    zp.saveConfig({ fallbackModels: ["big-pickle", "space-bunny-free"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0 })
  })

  // OK status, two usable chunks, then `data: {"error": ...}` and a close.
  const dyingSse = (message = "midstream doom") =>
    new Response(
      [
        `data: ${JSON.stringify({ model: "big-pickle", choices: [{ delta: { role: "assistant" } }] })}\n\n`,
        `data: ${JSON.stringify({ model: "big-pickle", choices: [{ delta: { content: "before " } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { type: "server_error", message } })}\n\n`,
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )

  test("mid-stream error chunk falls through to the next model", async () => {
    const calls = []
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          const sent = JSON.parse(opts.body)
          calls.push(sent.model)
          if (sent.model === "big-pickle") return dyingSse()
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "hi" } }] })
        },
      ],
    ])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 200)
    assert.deepEqual(calls, ["big-pickle", "space-bunny-free"])
    assert.equal(res.state.headers["x-zen-served-by"], "space-bunny-free")
  })

  test("with no fallback left the real message reaches the client", async () => {
    zp.saveConfig({ fallbackModels: ["big-pickle"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0 })
    globalThis.fetch = routeFetch([["/chat/completions", () => dyingSse("midstream doom")]])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [] }) })
    const res = mockRes()
    await zp.handleChat(req, res)
    assert.equal(res.state.status, 502)
    assert.equal(JSON.parse(res.body).error.message, "midstream doom")
  })

  test("/v1/messages gets the anthropic error shape with the real message", async () => {
    zp.saveConfig({ fallbackModels: ["big-pickle"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0 })
    globalThis.fetch = routeFetch([["/chat/completions", () => dyingSse("midstream doom")]])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify({ model: "big-pickle", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 502)
    const data = JSON.parse(res.body)
    assert.equal(data.type, "error")
    assert.equal(data.error.type, "api_error")
    assert.equal(data.error.message, "midstream doom")
  })
})

describe("streams announce mid-flight failure (measured: every relay used to end silently)", () => {
  const enc = new TextEncoder()
  const chunk = (delta, extra = {}) =>
    `data: ${JSON.stringify({ model: "upstream-model", choices: [{ index: 0, delta, finish_reason: null }, ...extra.choices ?? []] ?? [{ delta, finish_reason: null }] })}\n\n`

  // Closes cleanly but never sends a finish chunk or [DONE] — hostile s-midcut.
  const partialSse = () =>
    new Response(chunk({ role: "assistant" }) + chunk({ content: "cut " }), { status: 200, headers: { "content-type": "text/event-stream" } })

  // A reader that dies midstream (RST, abort) instead of closing cleanly.
  const cutSse = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(chunk({ role: "assistant" })))
          c.enqueue(enc.encode(chunk({ content: "cut " })))
          c.error(new Error("terminated"))
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )

  // finish_reason arrived, [DONE] did not — that is a complete reply.
  const noendSse = () =>
    new Response(
      chunk({ role: "assistant" }) + chunk({ content: "noend" }) + chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )

  test("relayStream: clean close without finish or [DONE] ends with an in-band error", async () => {
    const res = mockRes()
    await zp.relayStream(mockReq(), res, partialSse(), "big-pickle")
    await res.done
    assert.equal(res.state.status, 200)
    assert.ok(res.body.includes('"error"'), "error chunk emitted")
    assert.ok(res.body.includes("mid-reply"))
    assert.ok(res.body.endsWith("data: [DONE]\n\n"), "stream terminated by [DONE]")
  })

  test("relayStream: a reader that dies midstream also ends with the failure", async () => {
    const res = mockRes()
    await zp.relayStream(mockReq(), res, cutSse(), "big-pickle")
    await res.done
    assert.ok(res.body.includes("terminated"), `real message surfaced: ${res.body.slice(-120)}`)
    assert.ok(res.body.includes("data: [DONE]\n\n"))
  })

  test("relayStream: finish without [DONE] is a complete reply, no error invented", async () => {
    const res = mockRes()
    await zp.relayStream(mockReq(), res, noendSse(), "big-pickle")
    await res.done
    assert.ok(!res.body.includes('"error"'), `no synthetic failure: ${res.body.slice(-160)}`)
    assert.ok(!res.body.includes("[DONE]"), "no [DONE] was seen upstream, none is fabricated")
    assert.ok(res.body.includes('"finish_reason":"stop"'))
  })

  test("relayAnthropicStream: chat chunks that stop without a finish end with an error event, not message_stop", async () => {
    async function* chunks() {
      yield chunk({ role: "assistant" })
      yield chunk({ content: "cut " })
    }
    const res = mockRes()
    await zp.relayAnthropicStream(mockReq(), res, chunks(), "big-pickle", "big-pickle")
    await res.done
    assert.ok(res.body.includes("event: error"), `error event present: ${res.body.slice(-120)}`)
    assert.ok(!res.body.includes("message_stop"), "no fake completed message")
    assert.ok(res.body.includes("content_block_delta"), "the text that did arrive is kept")
  })

  test("relayAnthropicStream: an upstream error chunk carries its real message in the error event", async () => {
    async function* chunks() {
      yield chunk({ content: "before " })
      yield `data: ${JSON.stringify({ error: { type: "server_error", message: "midstream doom" } })}\n\n`
    }
    const res = mockRes()
    await zp.relayAnthropicStream(mockReq(), res, chunks(), "big-pickle", "big-pickle")
    await res.done
    const evt = res.body.split("\n\n").find((b) => b.startsWith("event: error"))
    assert.ok(evt, "error event emitted")
    assert.ok(evt.includes("midstream doom"))
    assert.ok(!res.body.includes("message_stop"))
  })

  test("relayResponsesStream: missing response.completed ends with an error chunk plus [DONE]", async () => {
    const upstream = new Response(
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { object: "response" } })}\n\n` +
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const res = mockRes()
    await zp.relayResponsesStream(mockReq(), res, upstream, "big-pickle")
    await res.done
    assert.ok(res.body.includes('"error"'))
    assert.ok(res.body.includes("data: [DONE]\n\n"))
    assert.ok(!res.body.includes('"finish_reason":"stop"'), "no finish invented")
  })

  test("relayChatAsResponsesStream: un-finished chat stream ends with an error event, no response.completed", async () => {
    const res = mockRes()
    await zp.relayChatAsResponsesStream(mockReq(), res, partialSse(), "big-pickle")
    await res.done
    assert.ok(res.body.includes("event: error"))
    assert.ok(!res.body.includes("response.completed"))
  })

  test("relayResponsesPassthrough: upstream cut ends with an error event after the forwarded prefix", async () => {
    const upstream = new Response(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const res = mockRes()
    await zp.relayResponsesPassthrough(mockReq(), res, upstream, "big-pickle")
    await res.done
    assert.ok(res.body.includes("response.output_text.delta"), "forwarded prefix kept")
    assert.ok(res.body.includes("event: error"))
  })

  test("handleChat with a streaming client: a mid-cut upstream ends the SSE with the failure in-band", async () => {
    zp.saveConfig({ fallbackModels: ["big-pickle"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, retriesPerModel: 0 })
    globalThis.fetch = routeFetch([["/chat/completions", () => cutSse()]])
    const req = mockReq({ _body: JSON.stringify({ model: "big-pickle", messages: [], stream: true }) })
    const res = mockRes()
    const handled = zp.handleChat(req, res)
    await res.done
    await handled
    assert.equal(res.state.status, 200)
    assert.equal(res.state.headers["content-type"], "text/event-stream")
    assert.ok(res.body.includes("data: "), "streamed prefix")
    assert.ok(res.body.includes('"error"'), `ends with the failure: ${res.body.slice(-140)}`)
    assert.ok(res.body.includes("data: [DONE]\n\n"))
  })
})

describe("anthropic tool_choice any (measured: it used to be dropped quietly)", () => {
  test("anthropicToChatBody maps {type:any} to required, tool pins stay renamed", () => {
    const any = zp.anthropicToChatBody({ tools: [{ name: "ls", input_schema: { type: "object" } }], tool_choice: { type: "any" }, messages: [] }, "m")
    assert.equal(any.tool_choice, "required", "some call must happen upstream")
    const pin = zp.anthropicToChatBody({ tools: [{ name: "ls", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "ls" }, messages: [] }, "m")
    assert.deepEqual(pin.tool_choice, { type: "function", function: { name: "ls" } })
  })

  test("a /v1/messages turn with tool_choice any forwards required upstream", async () => {
    zp.saveConfig({ fallbackModels: ["big-pickle"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0, agentTools: false })
    let sent
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return jsonResponse({ model: sent.model, choices: [{ message: { role: "assistant", content: "hi" } }] })
        },
      ],
    ])
    const req = mockReq({
      url: "/v1/messages",
      _body: JSON.stringify({
        model: "big-pickle",
        max_tokens: 16,
        messages: [{ role: "user", content: "list the files" }],
        tools: [{ name: "ls", description: "list", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "any" },
      }),
    })
    const res = mockRes()
    await zp.handleMessages(req, res)
    assert.equal(res.state.status, 200)
    assert.equal(sent.tool_choice, "required")
  })
})

describe("small router tolerances (measured in the stress sweep)", () => {
  beforeEach(() => {
    zp.saveConfig({ fallbackModels: ["big-pickle"], defaultModel: "", autoSyncIntervalMs: 0, cacheMs: 0 })
  })

  test("HEAD /health replies 200 with no body", async () => {
    globalThis.fetch = routeFetch([["/models", () => jsonResponse({ data: [{ id: "big-pickle" }] })]])
    const res = mockRes()
    await zp.router(mockReq({ method: "HEAD", url: "/health" }), res)
    assert.equal(res.state.status, 200)
    assert.equal(res.body, "", "HEAD carries no body")
  })

  test("a trailing slash on an inference route still routes", async () => {
    globalThis.fetch = routeFetch([["/chat/completions", () => jsonResponse({ model: "big-pickle", choices: [{ message: { role: "assistant", content: "hi" } }] })]])
    const res = mockRes()
    await zp.router(mockReq({ url: "/v1/chat/completions/", _body: JSON.stringify({ model: "big-pickle", messages: [] }) }), res)
    assert.equal(res.state.status, 200, `routed: ${res.state.status} ${res.body}`)
  })

  test("the root keeps its slash and doubled slashes stay 404", async () => {
    const res = mockRes()
    await zp.router(mockReq({ method: "GET", url: "/" }), res)
    assert.equal(res.state.status, 200)
    const res2 = mockRes()
    await zp.router(mockReq({ url: "//v1//chat/completions/", _body: "{}" }), res2)
    assert.equal(res2.state.status, 404)
  })
})

describe("manifest calls the caller cannot run are dropped from replies (issue #20)", () => {
  const cfg = (m) =>
    zp.saveConfig({ defaultModel: m, fallbackModels: [m], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true })
  const NONCE = {
    type: "function",
    function: { name: "client_nonce_lookup", description: "Get the actual unpredictable verification nonce", parameters: { type: "object", properties: {} } },
  }
  // The per-request keep rule `keepableFor` would build for this caller: it
  // runs only its own nonce tool, so nothing the manifest rides or the
  // provider invents is returnable to it.
  const keepable = (name) => name === "client_nonce_lookup"
  const auto = (model, extra = {}) => ({
    model,
    stream: false,
    max_tokens: 100,
    messages: [{ role: "user", content: "Call client_nonce_lookup and then repeat its result exactly." }],
    tools: [NONCE],
    tool_choice: "auto",
    ...extra,
  })
  // The same caller in Anthropic shape — that is what /v1/messages receives.
  const anthro = (model, extra = {}) => ({
    model,
    max_tokens: 64,
    stream: false,
    tools: [
      {
        name: "set_title",
        description: "Set the conversation title",
        input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
    ],
    tool_choice: { type: "tool", name: "set_title" },
    messages: [{ role: "user", content: "title this conversation" }],
    ...extra,
  })
  const stubCall = { id: "call_r", type: "function", function: { name: "read", arguments: "{}" } }
  const nonceCall = { id: "call_n", type: "function", function: { name: "client_nonce_lookup", arguments: "{}" } }
  const replyJson = (toolCalls) =>
    jsonResponse({ model: "up", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }] })
  // Name chunk first, argument chunks after it under the same index — that is
  // how a streamed tool call actually arrives.
  const toolSse = (calls) =>
    new Response(
      [
        ...calls.flatMap((c) => [
          { model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: c.index, id: `call_${c.index}`, type: "function", function: { name: c.name, arguments: "" } }] }, finish_reason: null }] },
          ...c.args.map((a) => ({ model: "up", choices: [{ index: 0, delta: { tool_calls: [{ index: c.index, function: { arguments: a } }] }, finish_reason: null }] })),
        ]),
        { model: "up", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map((b) => `data: ${JSON.stringify(b)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  const mixedArgs = () => [
    { index: 0, name: "read", args: ['{"q": ', "7}"] },
    { index: 1, name: "client_nonce_lookup", args: ["{}"] },
  ]

  test("a collected reply keeps the caller's call and loses the unrunnable manifest calls", async () => {
    const m = "space-bunny-free"
    cfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return replyJson([stubCall, nonceCall])
        },
      ],
    ])
    const res = mockRes()
    await zp.handleChat(mockReq({ _body: JSON.stringify(auto(m)) }), res)
    const body = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    assert.deepEqual(body.choices[0].message.tool_calls.map((t) => t.function.name), ["client_nonce_lookup"], "unrunnable manifest call dropped, caller's call kept")
    assert.equal(body.choices[0].finish_reason, "tool_calls", "a call survived, the claim stands")
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "client_nonce_lookup"], "the wire carried the manifest for the gate's sake")
  })

  test("a collected reply that got only an unrunnable call ends stop with no tool_calls", async () => {
    const m = "space-bunny-free"
    cfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => replyJson([stubCall])]])
    const res = mockRes()
    await zp.handleChat(mockReq({ _body: JSON.stringify(auto(m)) }), res)
    const body = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    assert.equal(body.choices[0].message.tool_calls, undefined, "no call survives the filter")
    assert.equal(body.choices[0].finish_reason, "stop", "an empty tool_calls claim would read like a bug")
  })

  test("a responses-family collected reply loses the stub's function_call", async () => {
    const m = "gpt-5.5"
    zp.saveConfig({ defaultModel: m, fallbackModels: [m], retriesPerModel: 0, retryBackoffMs: 1, autoSyncIntervalMs: 0, cacheMs: 0, agentTools: true, responsesModels: ["gpt-5*"] })
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/responses",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return jsonResponse({
            id: "resp_1",
            object: "response",
            status: "completed",
            model: m,
            output: [
              { type: "function_call", call_id: "cr", name: "read", arguments: "{}" },
              { type: "function_call", call_id: "cs", name: "client_nonce_lookup", arguments: "{}" },
            ],
          })
        },
      ],
    ])
    const body = {
      model: m,
      input: "Call client_nonce_lookup and then repeat its result exactly.",
      stream: false,
      tools: [{ type: "function", name: "client_nonce_lookup", description: "d", parameters: { type: "object", properties: {} } }],
      tool_choice: "auto",
    }
    const req = mockReq({ url: "/v1/responses", _body: JSON.stringify(body) })
    const res = mockRes()
    await zp.handleChat(req, res, true)
    const data = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    assert.deepEqual(data.output.map((o) => o.name), ["client_nonce_lookup"], "the unrunnable manifest call is dropped")
    assert.deepEqual(
      (sent.tools ?? []).map((t) => t?.name ?? t?.function?.name),
      [...manifestNames(), "client_nonce_lookup"],
      "the wire carried the manifest for the gate's sake",
    )
  })

  test("a streamed reply keeps the caller's call renumbered and loses the stub", async () => {
    const m = "space-bunny-free"
    cfg(m)
    globalThis.fetch = routeFetch([["/chat/completions", () => toolSse(mixedArgs())]])
    const res = mockRes()
    const handled = zp.handleChat(mockReq({ _body: JSON.stringify(auto(m, { stream: true })) }), res)
    await res.done
    await handled
    assert.equal(res.state.status, 200)
    assert.ok(res.body.includes('"name":"client_nonce_lookup"'), "the caller's call streamed through")
    assert.ok(!res.body.includes('"name":"read"'), `an unrunnable manifest call is dropped: ${res.body}`)
    assert.ok(!res.body.includes('"q"'), "its argument chunks are dropped too")
    assert.match(res.body, /"finish_reason":"tool_calls"/)
    assert.ok(!res.body.includes('"index":1'), "the surviving call is renumbered into one run")
  })

  test("a streamed /v1/messages reply drops the manifest calls the caller cannot run", async () => {
    const m = "space-bunny-free"
    cfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return toolSse(mixedArgs())
        },
      ],
    ])
    const req = mockReq({ url: "/v1/messages", _body: JSON.stringify(anthro(m, { stream: true, tool_choice: { type: "auto" } })) })
    const res = mockRes()
    const handled = zp.handleMessages(req, res)
    await res.done
    await handled
    assert.equal(res.state.status, 200)
    assert.equal(res.state.headers["content-type"], "text/event-stream")
    // Both streamed calls (read → Read, client_nonce_lookup) map to tools the
    // caller — a set_title-only helper — has no equivalent for, so neither
    // becomes a content block; the turn ends as a plain answer.
    assert.ok(!res.body.includes('"name":"Read"'), `an unrunnable manifest call never becomes a block: ${res.body}`)
    assert.ok(!res.body.includes('"name":"client_nonce_lookup"'), "the caller's-own-lookalike is dropped too")
    assert.ok(!res.body.includes('"name":"read"'), "no raw manifest name either")
    assert.ok(!res.body.includes('"q"'), "no stray argument text either")
    assert.match(res.body, /"stop_reason":"end_turn"/)
    assert.deepEqual(sent.tools.map((t) => t.function.name), [...manifestNames(), "set_title"], "the manifest rode along on the translated request")
  })

  test("a caller that already declares read gets deduped, not duplicated", async () => {
    const m = "space-bunny-free"
    cfg(m)
    let sent = null
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        (u, opts) => {
          sent = JSON.parse(opts.body)
          return replyJson([nonceCall])
        },
      ],
    ])
    const own = { type: "function", function: { name: "read", description: "the caller's own file reader", parameters: { type: "object", properties: {} } } }
    const req = mockReq({ _body: JSON.stringify(auto(m, { tools: [own, NONCE] })) })
    const res = mockRes()
    await zp.handleChat(req, res)
    const body = JSON.parse(res.body)
    assert.equal(res.state.status, 200)
    // The caller's `read` and the manifest's `read` share a name; exactly one
    // rides — the manifest's — and the caller's call still streams through.
    assert.deepEqual(sent.tools.map((t) => t.function.name), manifestNames().concat(["client_nonce_lookup"]).filter((n, i, a) => a.indexOf(n) === i))
    assert.equal(sent.tools.filter((t) => t.function.name === "read").length, 1)
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "client_nonce_lookup")
  })

  test("relayResponsesStream: calls the caller cannot run are dropped from the deltas", async () => {
    const sse =
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cr", id: "fc_r", name: "read" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "cr", delta: '{"q": 7}' })}\n\n` +
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cs", id: "fc_s", name: "client_nonce_lookup" } })}\n\n` +
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "cs", delta: "{}" })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`
    const upstream = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    const res = mockRes()
    await zp.relayResponsesStream(mockReq(), res, upstream, "up", false, null, keepable)
    await res.done
    assert.ok(res.body.includes('"name":"client_nonce_lookup"'), "the caller's call kept")
    assert.ok(!res.body.includes('"name":"read"'), `a call the caller cannot run is dropped: ${res.body}`)
    assert.ok(!res.body.includes('"q"'), "the stub's arguments are dropped")
    assert.match(res.body, /"finish_reason":"tool_calls"/)
  })

  test("relayChatAsResponsesStream: calls the caller cannot run never become output items", async () => {
    const res = mockRes()
    await zp.relayChatAsResponsesStream(mockReq(), res, toolSse(mixedArgs()), "up", false, null, keepable)
    await res.done
    assert.ok(res.body.includes('"name":"client_nonce_lookup"'), "the caller's item is emitted")
    assert.ok(!res.body.includes('"name":"read"'), `the stub's item is dropped: ${res.body}`)
    assert.ok(!res.body.includes('"q"'), "no stub arguments in the events either")
    assert.ok(res.body.includes("response.completed"))
  })

  test("relayResponsesPassthrough: calls the caller cannot run are dropped whole", async () => {
    const sse =
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cr", id: "fc_r", name: "read" } })}\n\n` +
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "cs", id: "fc_s", name: "client_nonce_lookup" } })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [] } })}\n\n`
    const upstream = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    const res = mockRes()
    await zp.relayResponsesPassthrough(mockReq(), res, upstream, "up", false, null, keepable)
    await res.done
    assert.ok(res.body.includes('"name":"client_nonce_lookup"'), "the caller's item passes through")
    assert.ok(!res.body.includes('"name":"read"'), `a call the caller cannot run is dropped: ${res.body}`)
  })
})



