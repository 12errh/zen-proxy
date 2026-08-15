import { test, describe, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

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
const DEFAULT_MODEL = zp.config.defaultModel
const REPO_ROOT = new URL("..", import.meta.url).pathname

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
})
beforeEach(() => {
  originalConfig = snapshotConfig()
})

// ---- helpers ----

describe("resolveModel", () => {
  test("maps an alias to its target", () => {
    zp.saveConfig({ modelAliases: { "gpt-4o": "deepseek-v4-flash-free" } })
    const { requested, candidates } = zp.resolveModel("gpt-4o")
    assert.equal(requested, "gpt-4o")
    assert.equal(candidates[0], "deepseek-v4-flash-free")
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
  })

  test("alias: upstream called with target, response rewritten to alias", async () => {
    zp.saveConfig({ modelAliases: { "gpt-4o": "deepseek-v4-flash-free" } })
    globalThis.fetch = routeFetch([
      ["/chat/completions", chatStub("deepseek-v4-flash-free", jsonResponse({ model: "upstream-model", choices: [] }))],
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
    globalThis.fetch = routeFetch([
      ["/chat/completions", () => jsonResponse({ error: { message: "FreeUsageLimitError" } }, 429)],
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
    globalThis.fetch = routeFetch([
      [
        "/chat/completions",
        () => {
          throw new Error("ECONNREFUSED")
        },
      ],
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
    assert.match(res.body, /"model":"deepseek-v4-flash-free"/)
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
          return jsonResponse({ data: [{ id: "deepseek-v4-flash-free" }, { id: "paid-model" }] })
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
      ["/models", jsonResponse({ data: [{ id: "deepseek-v4-flash-free" }] })],
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
    assert.deepEqual(bad.data.map((m) => m.id), ["deepseek-v4-flash-free"])
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
      ["/models", () => jsonResponse({ data: [{ id: "deepseek-v4-flash-free" }] })],
    ])
    await zp.fetchModels() // cold refresh so the cache holds the stub's data
    zp.saveConfig({ cacheMs: 60_000 })
    const req = mockReq({ headers: { authorization: "Bearer admin-1" } })
    const res = mockRes()
    await zp.handleModels(req, res)
    assert.equal(res.state.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.ok, true)
    assert.equal(data.data[0].id, "deepseek-v4-flash-free")
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
    const good = "deepseek-v4-flash-free"
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
    globalThis.fetch = routeFetch([["/models", jsonResponse({ data: [{ id: "deepseek-v4-flash-free" }] })]])
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

describe("install.sh config preservation", () => {
  function runInstall(tmp, destPort) {
    const env = {
      ...process.env,
      HOME: path.join(tmp, "home"),
      ZEN_PROXY_DIR: path.join(tmp, "install"),
      ZEN_PROXY_PORT: String(destPort),
    }
    fs.mkdirSync(env.HOME, { recursive: true })
    execFileSync("bash", ["install.sh", "--local", path.join(tmp, "src")], { env, cwd: REPO_ROOT })
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
    execFileSync("bash", ["install.sh", "--local", path.join(tmp, "src")], { env, cwd: REPO_ROOT })
    const cfg = JSON.parse(fs.readFileSync(path.join(env.ZEN_PROXY_DIR, "zen-proxy.json"), "utf8"))
    assert.deepEqual(cfg, { user: true, port: 7777 }, "user config must survive reinstall")
  })

  test("refuses to install into /", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zp-install-"))
    const src = path.join(tmp, "src")
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "zen-proxy.mjs"), "console.log('zen-proxy')\n")
    const env = { ...process.env, HOME: path.join(tmp, "home"), ZEN_PROXY_DIR: "/" }
    fs.mkdirSync(env.HOME, { recursive: true })
    assert.throws(() => execFileSync("bash", ["install.sh", "--local", src], { env, cwd: REPO_ROOT }), /Refusing/)
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
