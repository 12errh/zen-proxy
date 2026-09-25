import { test, describe, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

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
    assert.match(a1, /^ses_[0-9a-f]{26}$/)
    assert.ok(zp.sessionFor(mockReq()).injected, "local client gets an injected id")
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
