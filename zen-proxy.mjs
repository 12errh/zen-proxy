#!/usr/bin/env node
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")
const UI_PATH = path.join(__dirname, "public", "index.html")
const ENV = process.env

const DEFAULT_CONFIG = {
  // NOTE: default host is 0.0.0.0 so PaaS hosts (Render/Railway/Fly/Koyeb)
  // that require binding to all interfaces pass their port scan.
  // Local access via http://127.0.0.1:<port> still works when bound to 0.0.0.0.
  // Set HOST=127.0.0.1 to restrict to loopback only.
  host: ENV.HOST ?? "0.0.0.0",
  port: Number(ENV.PORT ?? 8787),
  upstream: (ENV.ZEN_URL ?? "https://opencode.ai/zen/v1").replace(/\/+$/, ""),
  // opencode 2.x official client sends `opencode/<channel>/<version>/<client>`
  // e.g. `opencode/latest/2.0.9/cli`. The free tier checks this.
  ua: ENV.ZEN_UA ?? "opencode/latest/2.0.9/cli",
  autoUA: ENV.AUTO_UA !== "0",
  uaRefreshMs: Number(ENV.UA_REFRESH_MS ?? 6 * 3600_000),
  injectSession: ENV.INJECT_SESSION !== "0",
  // Which credentials the auto-sync health probe uses:
  //   "auto"      — use defaultZenKey when set, otherwise anonymous `public`
  //   "key"       — always use defaultZenKey (probe fails if none is set)
  //   "anonymous" — always anonymous `public`, even when a key is configured
  probeAuth: ENV.PROBE_AUTH ?? "auto",
  // "" = auto: at request time the first *healthy* free model becomes the default
  // (see effectiveDefault), so a model that disappears upstream never bricks new
  // installs. Set an explicit model here to pin it.
  defaultModel: ENV.DEFAULT_MODEL ?? "",
  fallbackModels: JSON.parse(
    ENV.FALLBACK_MODELS ??
      JSON.stringify([
        "space-bunny-free",
        "mimo-v2.6-flash-free",
        "big-pickle",
        "ling-3.0-flash-fin-free",
        "muse-spark-1.3-contributor-free",
        "muse-spark-1.2-contributor-free",
        "nemotron-3.5-lightning-free",
        "nemotron-3-ultra-free",
        "longcat-2.5-preview-free",
        "fledge-alpha-free",
        "ling-3.1-flash-free",
        "exo-free",
      ]),
  ),
  modelAliases: JSON.parse(ENV.MODEL_ALIASES ?? "{}"),
  // opencode Zen serves each model on a specific endpoint family
  // (chat/completions | responses | messages). Patterns may end in `*`.
  // Source of truth: https://opencode.ai/docs/zen
  responsesModels: JSON.parse(
    ENV.RESPONSES_MODELS ??
      JSON.stringify(["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*"]),
  ),
  rateLimitMax: Number(ENV.RATE_LIMIT_MAX ?? 0),
  rateLimitWindowMs: Number(ENV.RATE_LIMIT_WINDOW_MS ?? 60_000),
  proxyKey: ENV.PROXY_KEY ?? "",
  defaultZenKey: ENV.ZEN_KEY ?? "",
  trustForwarded: ENV.TRUST_FORWARDED === "1",
  timeoutMs: Number(ENV.TIMEOUT_MS ?? 120000),
  cacheMs: Number(ENV.CACHE_MS ?? 30000),
  autoSync: ENV.AUTO_SYNC !== "0",
  autoSyncIntervalMs: Number(ENV.AUTO_SYNC_MS ?? 3600000),
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    const merged = { ...DEFAULT_CONFIG, ...raw }
    // Env vars always win over the config file. This matters on Render etc:
    // the first boot writes zen-proxy.json with the default host, and on later
    // deploys the stale file would otherwise override the platform-injected
    // HOST/PORT env vars and break port detection again.
    if (ENV.HOST) merged.host = ENV.HOST
    if (ENV.PORT) merged.port = Number(ENV.PORT)
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

let config = loadConfig()
let uiHtml = ""
try {
  uiHtml = fs.readFileSync(UI_PATH, "utf8")
} catch {}

let reloading = false
if (isMain) {
  try {
    const CONFIG_NAME = path.basename(CONFIG_PATH)
    fs.watch(path.dirname(CONFIG_PATH), (_event, filename) => {
      if (reloading) return
      if (filename && filename !== CONFIG_NAME && filename !== CONFIG_NAME + ".tmp") return
      reloading = true
      setTimeout(() => {
        config = loadConfig()
        reloading = false
        scheduleSync()
        scheduleUA()
        log("config reloaded")
      }, 150)
    })
  } catch {}
}

function saveConfig(next) {
  const merged = { ...config, ...next }
  fs.writeFileSync(CONFIG_PATH + ".tmp", JSON.stringify(merged, null, 2))
  fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH)
  config = merged
  return merged
}

function maskKey(k) {
  if (!k) return ""
  if (k.length <= 12) return "••••••••"
  return k.slice(0, 6) + "••••••" + k.slice(-4)
}

function sanitize(cfg) {
  const out = { ...cfg }
  if (out.proxyKey) out.proxyKey = "••••••••"
  if (out.defaultZenKey) out.defaultZenKey = maskKey(out.defaultZenKey)
  return out
}

const ALLOWED = () => new Set([...config.fallbackModels, ...Object.values(config.modelAliases)])
const requestStats = { total: 0, errors: 0, recent: [], perMinute: new Map(), window60: [] }
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/
const MAX_BODY = 1024 * 1024
// jev-* free models are served on /v1/systemone (structured classification),
// not on a chat/responses endpoint, so they are never routable here.
const NOT_CHAT_SERVABLE = [/^jev-/]

// ---- opencode official client emulation (zen free tier, opencode 2.x) ----
// Upstream `Console` rejects free requests that don't look like opencode:
//   `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`
// Real requirements (verified by replaying the official binary):
//   - Authorization must be a real auto-provisioned `sk-...` (not `public`)
//   - User-Agent `opencode/<channel>/<version>/<client>` e.g. `opencode/latest/2.0.9/cli`
//   - x-opencode-session must be a valid descending ID (timestamp prefix), random hex fails
//   - x-opencode-client / x-opencode-project / x-session-affinity / x-session-id required
//   - body must have stream:true + >=6 real opencode tools (or full title prompt)
const OFFICIAL_TOOLS = ["edit", "glob", "grep", "question", "read", "shell",
  "skill", "subagent", "webfetch", "websearch", "write", "execute"]
const MIN_OFFICIAL_TOOLS = ["edit", "glob", "grep", "question", "read", "shell"]

function isFreeModel(id) {
  const m = String(id ?? "").split("/").pop()
  return m === "big-pickle" || m.endsWith("-free")
}

function mkOfficialTools(names) {
  const list = names ?? MIN_OFFICIAL_TOOLS
  return list.map((n) => ({
    type: "function",
    function: { name: n, description: `opencode tool ${n}`, parameters: { type: "object", properties: {} } },
  }))
}

function hasEnoughOfficialTools(tools) {
  if (!Array.isArray(tools)) return false
  const names = new Set(tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean))
  let hits = 0
  for (const n of OFFICIAL_TOOLS) if (names.has(n)) hits++
  return hits >= 6
}

// Replicates opencode/src/id/id.ts `create(prefix, descending)`.
// Session IDs are `ses_<12hex timestamp><14 base62>` where the hex part is the
// low 48 bits of `~(Date.now()*0x1000 + counter)`. Pure random `ses_` fails.
let _idLastTs = 0
let _idCounter = 0
function genOfficialId(prefix = "ses") {
  const cur = Date.now()
  if (cur !== _idLastTs) {
    _idLastTs = cur
    _idCounter = 0
  }
  _idCounter++
  let now = BigInt(cur) * BigInt(0x1000) + BigInt(_idCounter)
  now = ~now
  const mask = (1n << 48n) - 1n
  const low = now & mask
  const hexpart = low.toString(16).padStart(12, "0")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = randomBytes(14)
  let rand = ""
  for (let i = 0; i < 14; i++) rand += chars[bytes[i] % 62]
  return `${prefix}_${hexpart}${rand}`
}

function genProjectId() {
  return randomBytes(20).toString("hex")
}

// opencode's free tier requires every request to carry an `x-opencode-session`
// header (upstream returns 400 `MissingSessionID` otherwise). Generic agents
// never send one, so we mint stable per-client session IDs and inject them.
const sessionPool = new Map()
function genSessionId() {
  return genOfficialId("ses")
}
function isValidOfficialSession(v) {
  return typeof v === "string" && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(v.trim())
}
function sessionFor(req) {
  const incoming = req?.headers?.["x-opencode-session"]
  if (isValidOfficialSession(incoming)) return { value: incoming.trim(), injected: false }
  // Invalid/random incoming would 403 as non-official; replace with a valid one.
  // If injectSession is disabled and incoming is invalid, still return incoming
  // so behavior is explicit (will fail upstream, as requested).
  if (typeof incoming === "string" && incoming.trim() && !config.injectSession) {
    return { value: incoming.trim(), injected: false }
  }
  const key = req ? (ipOmit(clientIp(req)) ? "local" : clientIp(req)) : "server"
  let id = sessionPool.get(key)
  if (!id || !isValidOfficialSession(id)) {
    id = genSessionId()
    sessionPool.set(key, id)
  }
  return { value: id, injected: true }
}
function sessionHeader(req) {
  if (!config.injectSession) return undefined
  return sessionFor(req).value
}

function parseRetryAfter(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(v)
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000)
  return 0
}

const RETRYABLE_ERROR_TYPES = new Set([
  "server_error",
  "api_error",
  "upstream_error",
  "ProviderError",
  "ModelError",
  "MissingSessionID",
  "RegionError",
  "FreeTierError",
  "model_not_found",
])
// Free-tier backends fail with 4xx errors that are really per-model / per-provider
// conditions (console says "Model is unavailable", "not supported", geo blocks…).
// Those are not client bugs — the proxy should roll to the next candidate instead
// of surfacing a hard 4xx. Real request errors (bad JSON, auth, context length…)
// still break out immediately.
function retryableUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  if (status < 400 || status > 499) return false
  const t = body?.error?.type ?? body?.type ?? ""
  const msg = String(body?.error?.message ?? body?.message ?? "")
  if (RETRYABLE_ERROR_TYPES.has(t)) return true
  return /model is unavailable|not supported|only be used in opencode|free tier can only|no such model|does not exist|overloaded|temporarily.*limit|upstream request failed/i.test(msg)
}

// ---- endpoint family resolution -------------------------------------------
// Zen serves each model on one endpoint family. We translate to/from the
// Responses API ourselves instead of pattern-matching a single vendor in code,
// so new models work by adding a pattern to `responsesModels` in config.
function modelFormat(id) {
  const s = String(id ?? "")
  for (const p of config.responsesModels ?? []) {
    if (typeof p !== "string" || !p) continue
    if (p.endsWith("*") ? s.startsWith(p.slice(0, -1)) : s === p) return "responses"
  }
  return "chat"
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? p?.content ?? p?.input_text ?? "")))
      .filter(Boolean)
      .join("")
  }
  return content == null ? "" : String(content)
}

// chat.completions messages -> Responses API `input` items.
// Keeps tool calls and tool results as first-class items so agent tool loops
// survive the translation (the naive "join everything into one string" approach
// silently destroys them).
function chatMessagesToInput(messages) {
  if (!Array.isArray(messages)) return String(messages ?? "")
  const items = []
  for (const m of messages) {
    const role = m?.role ?? "user"
    if (role === "tool" || role === "function") {
      const callId = m?.tool_call_id ?? m?.call_id ?? m?.id ?? "call_0"
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: textOf(m?.content) || " ",
      })
      // Images inside tool results survive as a follow-up user input_image item.
      if (Array.isArray(m?.content)) {
        const imgs = m.content.filter((p) => p?.type === "image_url" && p?.image_url?.url)
        if (imgs.length) {
          items.push({ role: "user", content: imgs.map((p) => ({ type: "input_image", image_url: p.image_url.url })) })
        }
      }
      continue
    }
    // Preserve image_url parts as Responses input_image content blocks.
    if (Array.isArray(m?.content)) {
      const parts = []
      let hasImage = false
      for (const p of m.content) {
        if (typeof p === "string") { if (p) parts.push({ type: "input_text", text: p }) }
        else if (p?.type === "text" && p.text) parts.push({ type: "input_text", text: p.text })
        else if (p?.type === "image_url" && p?.image_url?.url) {
          parts.push({ type: "input_image", image_url: p.image_url.url })
          hasImage = true
        }
      }
      if (hasImage && parts.length) {
        items.push({ role: role === "assistant" ? "assistant" : role, content: parts })
        for (const tc of m?.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc?.id ?? "call_0",
            name: tc?.function?.name ?? tc?.name ?? "unknown",
            arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
          })
        }
        continue
      }
    }
    const text = textOf(m?.content)
    if (text) items.push({ role: role === "assistant" ? "assistant" : role, content: text })
    for (const tc of m?.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: tc?.id ?? "call_0",
        name: tc?.function?.name ?? tc?.name ?? "unknown",
        arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
      })
    }
  }
  return items.length ? items : [{ role: "user", content: "" }]
}

function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.type === "function" ? (t.function ?? t) : null
    if (!fn?.name) continue
    out.push({
      type: "function",
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters ? { parameters: fn.parameters } : {}),
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    })
  }
  return out.length ? out : undefined
}

// Responses API result -> chat.completion, preserving tool calls + reasoning.
function responsesToChat(data, requested, servedBy) {
  const output = Array.isArray(data?.output) ? data.output : []
  let text = typeof data?.output_text === "string" ? data.output_text : ""
  if (!text) {
    const parts = []
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) if (c?.type === "output_text" && c.text) parts.push(c.text)
      }
    }
    text = parts.join("")
  }
  const toolCalls = output
    .filter((i) => i?.type === "function_call")
    .map((i, n) => ({
      id: i.call_id ?? i.id ?? `call_${n}`,
      type: "function",
      function: { name: i.name ?? "unknown", arguments: typeof i.arguments === "string" ? i.arguments : JSON.stringify(i.arguments ?? {}) },
    }))
  const reasoning = output
    .filter((i) => i?.type === "reasoning")
    .flatMap((i) => (Array.isArray(i.summary) ? i.summary.map((s) => s?.text ?? "") : []))
    .filter(Boolean)
    .join("\n")
  const u = data?.usage ?? {}
  const message = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: data?.id ?? `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requested,
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : data?.status === "incomplete" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  }
}

// Responses SSE event -> chat.completion.chunk deltas.
function responsesEventToDeltas(event, data, state) {
  const type = event || data?.type || ""
  const out = []
  if (type === "response.output_text.delta" && data?.delta) out.push({ content: data.delta })
  else if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && data?.delta)
    out.push({ reasoning_content: data.delta })
  else if (type === "response.output_item.added" && data?.item?.type === "function_call") {
    const item = data.item
    const index = state.tools.length
    state.tools.push({ id: item.call_id ?? item.id ?? `call_${index}` })
    out.push({ tool_calls: [{ index, id: item.call_id ?? item.id ?? `call_${index}`, type: "function", function: { name: item.name ?? "unknown", arguments: "" } }] })
  } else if (type === "response.function_call_arguments.delta" && data?.delta) {
    let index = state.tools.findIndex((t) => t.id === (data.item_id ?? data.call_id ?? data.call_id))
    if (index < 0) index = 0
    if (!state.tools[index]) state.tools[index] = { id: data.call_id ?? `call_${index}` }
    out.push({ tool_calls: [{ index, function: { arguments: data.delta } }] })
  }
  return out
}

function usageToChat(u = {}) {
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  }
}

function toBool(v, dflt) {
  if (v === undefined || v === null) return dflt
  if (v === false || v === 0 || v === "0" || v === "false") return false
  return true
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
const syncState = { at: 0, ok: false, running: false, working: [], rateLimited: [], flaky: [], gated: [], dead: [], error: "", ms: 0 }
// Health learned from real client traffic. The free tier rejects our synthetic
// health probe (it only accepts genuine agent-shaped requests), so real traffic
// is the only trustworthy signal that a model is actually serving.
const observed = new Map()
function recordObserved(model, ok) {
  if (!model) return
  const cur = observed.get(model) ?? { ok: 0, fail: 0, last: 0 }
  if (ok) cur.ok++
  else cur.fail++
  cur.last = Date.now()
  observed.set(model, cur)
}
const modelHealth = new Map()
const MAX_LOG = 500
const logLines = []
function log(message) {
  const line = { at: new Date().toISOString(), msg: message }
  logLines.push(line)
  if (logLines.length > MAX_LOG) logLines.shift()
  console.log(line.msg)
}

function recordReq(req, model, ms, status, at = Date.now()) {
  const entry = { at, ip: clientIp(req), model, status, ms }
  const key = `${entry.at}|${entry.model}|${entry.status}`
  if (!requestStats.recent.length || requestStats.recent[requestStats.recent.length - 1][0] !== key) {
    requestStats.recent.push([key, 1, ms])
    if (requestStats.recent.length > 200) requestStats.recent.shift()
  } else {
    requestStats.recent[requestStats.recent.length - 1][1]++
    requestStats.recent[requestStats.recent.length - 1][2] = ms
  }
  requestStats.total++
  if (status >= 400) requestStats.errors++
  const minute = Math.floor(entry.at / 60000)
  requestStats.perMinute.set(minute, (requestStats.perMinute.get(minute) ?? 0) + 1)
  const cutoff = entry.at - 60_000
  while (requestStats.window60.length && requestStats.window60[0] < cutoff) requestStats.window60.shift()
  requestStats.window60.push(entry.at)
  const minCutoff = minute - 60
  for (const m of [...requestStats.perMinute.keys()]) {
    if (m < minCutoff) requestStats.perMinute.delete(m)
  }
}

// Effective default model: an explicit config.defaultModel always wins; when it's
// empty (auto), prefer the first fallback model the last auto-sync saw as healthy
// so a dead hardcoded default never stalls requests.
function effectiveDefault() {
  if (config.defaultModel) return config.defaultModel
  const synced = new Set([...(syncState.working ?? []), ...(syncState.rateLimited ?? [])])
  for (const m of config.fallbackModels) if (synced.has(m)) return m
  return config.fallbackModels[0] ?? ""
}

function resolveModel(requested) {
  const dflt = effectiveDefault()
  const id = String(requested ?? "").split("/").pop()
  const target = config.modelAliases[id] || (ALLOWED().has(id) ? id : "") || dflt
  const rest = config.fallbackModels.filter((m) => m !== target)
  return { requested: id || dflt, candidates: [target, ...rest] }
}

function clientIp(req) {
  if (config.trustForwarded) {
    const xff = req.headers["x-forwarded-for"]
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim()
    const xri = req.headers["x-real-ip"]
    if (typeof xri === "string" && xri.trim()) return xri.trim()
  }
  return req.socket.remoteAddress ?? ""
}

function ipOmit(ip) {
  if (!ip) return true
  const v = ip.replace(/^::ffff:/, "").toLowerCase()
  if (v === "::1" || v === "localhost" || v === "127.0.0.1" || /^127\./.test(v)) return true
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v)) return true
  if (/^fe80:/.test(v) || /^fc/.test(v) || /^fd/.test(v)) return true
  return false
}

function zenHeaders(req, auth, opts = {}) {
  // Official 2.x headers: UA + session + client + project + affinity.
  // Missing/invalid ones are minted so generic agents look like opencode.
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
  }
  if (config.injectSession === false) {
    // Explicit opt-out: forward whatever the client sent, mint nothing.
    for (const h of ["x-opencode-session", "x-opencode-client", "x-opencode-project", "x-session-affinity", "x-session-id", "x-opencode-request"]) {
      const v = req.headers[h]
      if (typeof v === "string" && v) headers[h] = v
    }
    const ip = clientIp(req)
    if (!ipOmit(ip)) headers["x-real-ip"] = ip
    return { headers, session: headers["x-opencode-session"] }
  }
  const sess = sessionFor(req)
  const session = sess.value
  headers["x-opencode-session"] = session
  headers["x-session-affinity"] = session
  headers["x-session-id"] = session
  const incomingClient = req.headers["x-opencode-client"]
  headers["x-opencode-client"] =
    typeof incomingClient === "string" && incomingClient ? incomingClient : "cli"
  const incomingProject = req.headers["x-opencode-project"]
  headers["x-opencode-project"] =
    typeof incomingProject === "string" && incomingProject ? incomingProject : (opts.project ?? genProjectId())
  // legacy passthrough (harmless)
  const legacy = req.headers["x-opencode-request"]
  if (typeof legacy === "string" && legacy) headers["x-opencode-request"] = legacy
  const ip = clientIp(req)
  if (!ipOmit(ip)) headers["x-real-ip"] = ip
  return { headers, session }
}

function bearer(req) {
  const v = req.headers["authorization"]
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : ""
}

// Auto-load the anonymous `sk-...` that official opencode provisions on first
// run (`~/.local/share/opencode/opencode.db` credential integration `opencode`).
// `Bearer public` only works for GET /models; inference needs the real key.
let _localZenKey = null
let _localZenKeyAt = 0
function loadLocalZenKey() {
  const now = Date.now()
  if (_localZenKey && now - _localZenKeyAt < 60_000) return _localZenKey
  try {
    // If OPENCODE_DB is explicitly set (e.g. tests), only use that path
    // so tests can isolate from the developer's real key.
    const explicit = process.env.OPENCODE_DB
    const candidates = explicit
      ? [explicit]
      : (() => {
          const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || ""
          return home ? [`${home}/.local/share/opencode/opencode.db`] : []
        })()
    for (const dbPath of candidates) {
      try {
        if (!dbPath || !fs.existsSync(dbPath)) continue
        const out = tryReadCredentialViaCli(dbPath)
        if (out) {
          _localZenKey = out
          _localZenKeyAt = now
          return out
        }
      } catch {}
    }
  } catch {}
  return _localZenKey
}

function tryReadCredentialViaCli(dbPath) {
  try {
    const sql = "SELECT value FROM credential WHERE integration_id='opencode' LIMIT 1"
    const raw = execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8", timeout: 3000 })
    const txt = String(raw ?? "").trim()
    if (!txt) return null
    try {
      const j = JSON.parse(txt)
      if (j?.key) return j.key
    } catch {}
    // sqlite3 may output the JSON string directly
    const m = txt.match(/"key"\s*:\s*"([^"]+)"/)
    if (m) return m[1]
    return null
  } catch {
    return null
  }
}

function resolveZenKey() {
  if (config.defaultZenKey) return config.defaultZenKey
  const local = loadLocalZenKey()
  if (local) return local
  return ""
}

function authForUpstream(req) {
  const incoming = bearer(req)
  if (config.proxyKey) {
    if (incoming !== config.proxyKey) return null
    const zen = req.headers["x-zen-key"]
    if (typeof zen === "string" && zen && zen !== "public") return `Bearer ${zen}`
    const resolved = resolveZenKey()
    if (resolved) return `Bearer ${resolved}`
    return "Bearer public"
  }
  if (incoming && incoming !== "public") return `Bearer ${incoming}`
  const zenHeader = req.headers["x-zen-key"]
  if (typeof zenHeader === "string" && zenHeader && zenHeader !== "public") return `Bearer ${zenHeader}`
  const resolved = resolveZenKey()
  if (resolved) return `Bearer ${resolved}`
  if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
  return "Bearer public"
}

async function readBody(req) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}

// ---- Anthropic Messages API translation -----------------------------------
// Normalizes an Anthropic `/v1/messages` body to an OpenAI chat.completions
// body so it can run through the same upstream candidate/fallback loop as
// handleChat (shapes ported from the cand1 reference server).
function anthropicSystemText(system) {
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : (b?.text ?? "")))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function anthropicToChat(body, requested) {
  const messages = []
  const sysText = anthropicSystemText(body.system)
  if (sysText) messages.push({ role: "system", content: sysText })
  for (const m of body.messages ?? []) {
    const role = m?.role === "assistant" ? "assistant" : "user"
    const c = m?.content
    if (typeof c === "string") {
      messages.push({ role, content: c })
      continue
    }
    if (!Array.isArray(c)) {
      messages.push({ role, content: String(c ?? "") })
      continue
    }
    const texts = []
    const images = []
    const toolCalls = []
    const toolResults = []
    for (const b of c) {
      if (!b || typeof b !== "object") continue
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text)
      else if (b.type === "image") {
        const src = b.source ?? {}
        if (src.type === "base64" && src.data) {
          images.push({ type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } })
        } else if ((src.type === "url" || src.type === "image_url") && (src.url ?? b.url)) {
          images.push({ type: "image_url", image_url: { url: src.url ?? b.url } })
        }
      } else if (b.type === "image_url" && b.image_url?.url) {
        images.push({ type: "image_url", image_url: { url: b.image_url.url } })
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id ?? `call_${toolCalls.length}`,
          type: "function",
          function: { name: b.name ?? "unknown", arguments: JSON.stringify(b.input ?? {}) },
        })
      } else if (b.type === "tool_result") {
        const rc = b.content
        const rt =
          typeof rc === "string"
            ? rc
            : Array.isArray(rc)
              ? rc.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).filter(Boolean).join("\n")
              : String(rc ?? "")
        toolResults.push(rt)
      }
    }
    if (toolResults.length) {
      // tool_result → plain user text (best effort; keeps tool loops readable).
      messages.push({ role: "user", content: [texts.join("\n"), ...toolResults].filter(Boolean).join("\n") })
    } else if (toolCalls.length) {
      messages.push({ role: "assistant", content: texts.join("\n") || null, tool_calls: toolCalls })
    } else if (images.length) {
      messages.push({ role, content: [...texts.map((t) => ({ type: "text", text: t })), ...images] })
    } else {
      messages.push({ role, content: texts.join("\n") })
    }
  }
  const out = { model: requested, messages }
  // Anthropic requires max_tokens; keep the reference default (1024) and clamp
  // to a sane range. Forwarded as max_tokens (chat) / max_output_tokens
  // (responses, via responsesRequest).
  const mt = Number(body.max_tokens)
  out.max_tokens = Math.min(32000, Math.max(1, Math.floor(Number.isFinite(mt) && mt > 0 ? mt : 1024)))
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.input_schema ? { parameters: t.input_schema } : {}),
        },
      }))
    if (tools.length) out.tools = tools
    const tc = body.tool_choice
    if (tc?.type === "any") out.tool_choice = "required"
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } }
    else if (tc?.type === "auto") out.tool_choice = "auto"
  }
  return out
}

// OpenAI finish_reason -> Anthropic stop_reason.
function anthropicStopReason(fr) {
  if (fr === "tool_calls") return "tool_use"
  if (fr === "length") return "max_tokens"
  if (fr === "stop_sequence") return "stop_sequence"
  if (fr === "content_filter" || fr === "refusal") return "refusal"
  return "end_turn"
}

// Normalized chat.completion -> Anthropic message envelope. Callers pass a
// chat-shaped object (responsesToChat already normalizes responses-family
// results), so both upstream families are covered. Reasoning is intentionally
// NOT emitted as a thinking block (a thinking block without a signature is
// rejected by strict SDKs) — text only, plus tool_use blocks.
function chatToAnthropic(chat, requested, fallbackInputTokens = 0) {
  const choice = chat?.choices?.[0] ?? {}
  const msg = choice?.message ?? {}
  const content = []
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content })
  for (const tc of msg.tool_calls ?? []) {
    let input = {}
    try {
      input = JSON.parse(tc?.function?.arguments ?? "{}")
    } catch {}
    content.push({
      type: "tool_use",
      id: tc?.id ?? `toolu_${randomBytes(8).toString("hex")}`,
      name: tc?.function?.name ?? "unknown",
      input,
    })
  }
  if (!content.length) content.push({ type: "text", text: "" })
  const u = chat?.usage ?? {}
  const usage = {
    input_tokens: u.prompt_tokens ?? fallbackInputTokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
  }
  if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = u.cache_creation_input_tokens
  if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = u.cache_read_input_tokens
  return {
    id: `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: requested,
    content,
    stop_reason: anthropicStopReason(choice?.finish_reason),
    usage,
  }
}

// Parse one SSE block into its event name and data payload.
function parseSSEBlock(block) {
  let event = ""
  const datas = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) datas.push(line.slice(5).trimStart())
  }
  return { event, raw: datas.join("\n") }
}

function anthropicStreamHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

// Write headers + message_start (with usage, so strict SDKs don't hang) and
// open the first text block. Returns the `send` writer.
function anthropicStreamStart(res, requested, inputTokens = 0) {
  anthropicStreamHead(res)
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: requested,
      content: [],
      usage: { input_tokens: inputTokens ?? 0 },
    },
  })
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  return { send }
}

// Wire client abort + proxy timeout to an upstream SSE reader (mirrors
// relayStream). Returns a cleanup function.
function streamAbort(req, reader) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  return () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
}

// Translate a chat-family upstream SSE stream to Anthropic events
// incrementally: every upstream chunk is converted and flushed immediately,
// never accumulated.
function relayMessagesChatStream(req, res, upstreamRes, requested, inputFallback = 0) {
  const { send } = anthropicStreamStart(res, requested, inputFallback)
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const cleanup = streamAbort(req, reader)
  const toolBlocks = new Map() // upstream tool_calls[].index -> anthropic block index
  const openBlocks = new Set([0])
  let nextIndex = 1
  let stopReason = "end_turn"
  const msgUsage = { output_tokens: 0 }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          const { raw } = parseSSEBlock(block)
          if (!raw || raw === "[DONE]") continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          const choice = data?.choices?.[0] ?? {}
          const delta = choice?.delta ?? {}
          if (typeof delta?.content === "string" && delta.content) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content },
            })
          }
          // Reasoning has no Anthropic signature here — emit it as plain text,
          // never as a thinking block.
          if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.reasoning_content },
            })
          }
          for (const tc of delta?.tool_calls ?? []) {
            const upIdx = tc?.index ?? 0
            let bIdx = toolBlocks.get(upIdx)
            if (bIdx == null && (tc?.id || tc?.function?.name)) {
              bIdx = nextIndex++
              toolBlocks.set(upIdx, bIdx)
              openBlocks.add(bIdx)
              send("content_block_start", {
                type: "content_block_start",
                index: bIdx,
                content_block: {
                  type: "tool_use",
                  id: tc.id ?? `toolu_${randomBytes(8).toString("hex")}`,
                  name: tc?.function?.name ?? "unknown",
                  input: {},
                },
              })
            }
            const args = tc?.function?.arguments
            if (args && bIdx != null) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: bIdx,
                delta: { type: "input_json_delta", partial_json: args },
              })
            }
          }
          if (choice?.finish_reason) stopReason = anthropicStopReason(choice.finish_reason)
          const u = data?.usage
          if (u && Number.isFinite(u?.completion_tokens)) msgUsage.output_tokens = u.completion_tokens
          if (u?.cache_creation_input_tokens != null) msgUsage.cache_creation_input_tokens = u.cache_creation_input_tokens
          if (u?.cache_read_input_tokens != null) msgUsage.cache_read_input_tokens = u.cache_read_input_tokens
        }
      }
      if (toolBlocks.size > 0 && stopReason === "end_turn") stopReason = "tool_use"
      for (const b of [...openBlocks].sort((a, b) => a - b)) {
        send("content_block_stop", { type: "content_block_stop", index: b })
      }
      send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: msgUsage })
      send("message_stop", { type: "message_stop" })
      res.end()
    } catch (err) {
      try {
        for (const b of [...openBlocks].sort((a, b) => a - b)) {
          send("content_block_stop", { type: "content_block_stop", index: b })
        }
        send("error", { type: "error", error: { type: "api_error", message: err?.message ?? "upstream stream failed" } })
        send("message_stop", { type: "message_stop" })
      } catch {}
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

// Translate a responses-family upstream SSE stream to Anthropic events
// incrementally (output_text.delta, reasoning deltas, function_call
// item/delta, completed, usage). Chat-shaped conversion reuses
// responsesEventToDeltas; reasoning is emitted as text, never thinking.
function relayMessagesResponsesStream(req, res, upstreamRes, requested, inputFallback = 0) {
  const { send } = anthropicStreamStart(res, requested, inputFallback)
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const cleanup = streamAbort(req, reader)
  const state = { tools: [], usage: null, finish: "stop" }
  const toolBlocks = [] // chat tool ordinal -> anthropic block index
  const openBlocks = new Set([0])
  let nextIndex = 1
  let failed = null
  const pump = async () => {
    const abort = (message) => {
      failed = message
      for (const b of [...openBlocks].sort((a, b) => a - b)) {
        send("content_block_stop", { type: "content_block_stop", index: b })
      }
      send("error", { type: "error", error: { type: "api_error", message } })
      send("message_stop", { type: "message_stop" })
      res.end()
    }
    try {
      for (;;) {
        if (failed) return
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          const { event, raw } = parseSSEBlock(block)
          if (!raw || raw === "[DONE]") continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          const ru = data?.response?.usage ?? data?.usage
          if (ru && typeof ru === "object") state.usage = ru
          if (data?.type === "response.completed" || data?.type === "response.incomplete") {
            state.finish = data.type === "response.incomplete" ? "length" : state.tools.length ? "tool_calls" : "stop"
            continue
          }
          if (data?.type === "error" || data?.error) {
            const message = data?.error?.message ?? data?.message ?? "upstream stream failed"
            abort(String(message))
            return
          }
          for (const d of responsesEventToDeltas(event, data, state)) {
            if (typeof d?.content === "string" && d.content) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: d.content },
              })
            } else if (typeof d?.reasoning_content === "string" && d.reasoning_content) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: d.reasoning_content },
              })
            } else if (Array.isArray(d?.tool_calls)) {
              for (const tc of d.tool_calls) {
                const upIdx = tc?.index ?? 0
                let bIdx = toolBlocks[upIdx]
                if (bIdx == null && (tc?.id || tc?.function?.name)) {
                  bIdx = nextIndex++
                  toolBlocks[upIdx] = bIdx
                  openBlocks.add(bIdx)
                  send("content_block_start", {
                    type: "content_block_start",
                    index: bIdx,
                    content_block: {
                      type: "tool_use",
                      id: tc.id ?? `toolu_${randomBytes(8).toString("hex")}`,
                      name: tc?.function?.name ?? "unknown",
                      input: {},
                    },
                  })
                }
                const args = tc?.function?.arguments
                if (args && bIdx != null) {
                  send("content_block_delta", {
                    type: "content_block_delta",
                    index: bIdx,
                    delta: { type: "input_json_delta", partial_json: args },
                  })
                }
              }
            }
          }
        }
      }
      if (failed) return
      let stopReason = anthropicStopReason(state.finish)
      if (toolBlocks.length > 0 && stopReason === "end_turn") stopReason = "tool_use"
      const msgUsage = { output_tokens: state.usage?.output_tokens ?? 0 }
      if (state.usage?.cache_creation_input_tokens != null)
        msgUsage.cache_creation_input_tokens = state.usage.cache_creation_input_tokens
      if (state.usage?.cache_read_input_tokens != null)
        msgUsage.cache_read_input_tokens = state.usage.cache_read_input_tokens
      for (const b of [...openBlocks].sort((a, b) => a - b)) {
        send("content_block_stop", { type: "content_block_stop", index: b })
      }
      send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: msgUsage })
      send("message_stop", { type: "message_stop" })
      res.end()
    } catch (err) {
      if (!failed) {
        try {
          abort(err?.message ?? "upstream stream failed")
          return
        } catch {}
        res.end()
      }
    } finally {
      cleanup()
    }
  }
  return pump()
}

function ensureChatFreeTier(body) {
  // Returns { payload, clientStream } where payload is upstream-ready.
  // Free tier needs stream:true + >=6 real tools; non-stream clients are
  // served by upstream-streaming + destreaming (see collectChatSSE).
  const clientStream = !!body.stream
  const payload = { ...body }
  if (!hasEnoughOfficialTools(payload.tools)) {
    payload.tools = mkOfficialTools()
  }
  payload.stream = true
  if (payload.stream_options == null) payload.stream_options = { include_usage: true }
  return { payload, clientStream }
}

function ensureResponsesFreeTier(body, session) {
  const clientStream = body.stream !== false
  const payload = { ...body }
  // responses tools are flat: {type:"function", name, ...}
  const names = new Set(
    (Array.isArray(payload.tools) ? payload.tools : [])
      .map((t) => t?.name ?? t?.function?.name)
      .filter(Boolean),
  )
  let hits = 0
  for (const n of OFFICIAL_TOOLS) if (names.has(n)) hits++
  if (hits < 6) {
    payload.tools = MIN_OFFICIAL_TOOLS.map((n) => ({
      type: "function",
      name: n,
      description: `opencode tool ${n}`,
      parameters: { type: "object", properties: {} },
    }))
  }
  if (payload.store == null) payload.store = false
  if (payload.prompt_cache_key == null) payload.prompt_cache_key = session
  if (payload.include == null) payload.include = ["reasoning.encrypted_content"]
  payload.stream = true
  return { payload, clientStream }
}

async function collectChatSSE(upstreamRes) {
  const text = await upstreamRes.text()
  // Robustness: if upstream answered plain JSON (not SSE), extract content
  // directly instead of failing the destream.
  try {
    const j = JSON.parse(text)
    if (j && typeof j === "object" && Array.isArray(j.choices)) {
      const msg = j.choices[0]?.message ?? j.choices[0]?.delta ?? {}
      const content = typeof msg.content === "string" ? msg.content : ""
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined
      const finish = typeof j.choices[0]?.finish_reason === "string" ? j.choices[0].finish_reason : "stop"
      return {
        content,
        tool_calls: toolCalls,
        finish,
        model: typeof j.model === "string" ? j.model : "",
        id: typeof j.id === "string" ? j.id : `chatcmpl-${Date.now().toString(36)}`,
        usage: j.usage,
      }
    }
  } catch {}
  let content = ""
  let finish = "stop"
  let model = ""
  let id = `chatcmpl-${Date.now().toString(36)}`
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const j = JSON.parse(payload)
      if (typeof j.id === "string") id = j.id
      if (typeof j.model === "string") model = j.model
      const fr = j.choices?.[0]?.finish_reason
      if (typeof fr === "string" && fr) finish = fr
      const delta = j.choices?.[0]?.delta
      if (delta && typeof delta.content === "string") content += delta.content
      // some providers put final content in message instead of delta
      const msg = j.choices?.[0]?.message
      if (msg && typeof msg.content === "string" && !content) content = msg.content
    } catch {}
  }
  return { content, model, id, finish, tool_calls: undefined, usage: undefined }
}

async function collectResponsesSSE(upstreamRes) {
  const text = await upstreamRes.text()
  // Robustness: plain-JSON Responses bodies (not SSE) extract directly.
  try {
    const j = JSON.parse(text)
    if (j && typeof j === "object") {
      if (typeof j.output_text === "string" && j.output_text) return j.output_text
      const out = Array.isArray(j.output) ? j.output : []
      const parts = []
      for (const item of out) {
        for (const p of item.content ?? []) {
          if (p?.type === "output_text" && typeof p.text === "string") parts.push(p.text)
        }
      }
      if (parts.length) return parts.sort((a, b) => b.length - a.length)[0]
    }
  } catch {}
  const deltas = []
  const completed = []
  for (const chunk of text.split("\n\n")) {
    const c = chunk.trim()
    if (!c || !c.includes("data:")) continue
    for (const line of c.split("\n")) {
      const t = line.trim()
      if (!t.startsWith("data:")) continue
      try {
        const j = JSON.parse(t.slice(5).trim())
        if (typeof j.delta === "string") deltas.push(j.delta)
        else if (j.delta && typeof j.delta.text === "string") deltas.push(j.delta.text)
        const out = j.response?.output
        if (Array.isArray(out)) {
          for (const item of out) {
            for (const p of item.content ?? []) {
              if (p?.type === "output_text" && typeof p.text === "string") completed.push(p.text)
            }
          }
        }
      } catch {}
    }
  }
  const full = completed.length ? completed.sort((a, b) => b.length - a.length)[0] : deltas.join("")
  return full
}

async function handleChat(req, res) {
  const start = Date.now()
  let body
  try {
    const raw = await readBody(req)
    if (raw.length > MAX_BODY) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
    }
  } catch {
    return json(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
  }

  const { requested, candidates } = resolveModel(body.model)
  const isStream = !!body.stream
  const auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    return json(res, 401, { error: { type: "invalid_request_error", message: "invalid proxy key" } })
  }

  return runChatLoop(req, res, {
    body,
    requested,
    candidates,
    auth,
    start,
    isStream,
    onJson(content, model, format) {
      if (format === "responses") {
        recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
        recordObserved(model, true)
        return json(res, 200, responsesToChat(content, requested, model))
      }
      if (model !== requested) {
        // Make the fallback visible to any client, not just JSON readers.
        res.setHeader?.("x-zen-served-by", model)
        res.setHeader?.("x-zen-fallback", "true")
      }
      if (content && typeof content === "object") {
        content.model = requested
        if (model !== requested) content.zen_served_by = model
      }
      recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
      recordObserved(model, true)
      return json(res, 200, content)
    },
    onStream(upstreamRes, model, format) {
      if (format === "responses") {
        relayResponsesStream(req, res, upstreamRes, requested)
      } else {
        relayStream(req, res, upstreamRes, requested)
      }
    },
    onError(status, errBody, retryAfter) {
      const headers = retryAfter > 0 ? { "retry-after": String(retryAfter) } : {}
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(
        JSON.stringify(errBody ?? { error: { type: "free_usage_limit_error", message: "all free models are rate-limited" } }),
      )
    },
  })
}

// Shared upstream candidate/fallback loop for the chat and messages routes.
// Callers supply success/error renderers; retry, fallback, stats and health
// signaling stay identical for both. `onJson` handles a parsed non-stream
// upstream body, `onStream` a live upstream SSE body, `onError` any failure.
async function runChatLoop(req, res, { body, requested, candidates, auth, start, isStream, onJson, onStream, onError }) {
  let lastErr = null
  let lastStatus = 502
  let lastRetryAfter = 0
  let used = requested
  for (const model of candidates) {
    used = model
    const format = modelFormat(model)
    const free = isFreeModel(model)
    // Free-tier body hardening: inject official tools + force upstream stream.
    // Non-stream clients are served via destreaming below.
    let payload =
      format === "responses" ? responsesRequest(body, model, isStream) : { ...body, model }
    let wantStream = isStream
    let forcedStream = false
    const { headers: upHeaders, session: upSession } = zenHeaders(req, auth)
    if (free) {
      forcedStream = !isStream
      if (format === "responses") {
        const fixed = ensureResponsesFreeTier(payload, upSession)
        payload = fixed.payload
      } else {
        const fixed = ensureChatFreeTier(payload)
        payload = fixed.payload
      }
      // upstream always streams for free; client non-stream gets converted
      wantStream = true
    }
    let upstreamRes
    try {
      upstreamRes = await fetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
        method: "POST",
        headers: upHeaders,
        body: JSON.stringify(payload),
        // Newer Node aborts IncomingMessage.signal as soon as the request
        // body is consumed, so it can never gate a long-lived upstream
        // fetch — reuse it only while still armed, else use a timeout.
        signal: wantStream && req.signal && !req.signal.aborted ? req.signal : AbortSignal.timeout(config.timeoutMs),
      })
    } catch (err) {
      lastErr = { error: { type: "upstream_error", message: err.message } }
      lastStatus = 502
      continue
    }

    if (upstreamRes.ok) {
      if (isStream) {
        // Return the pump promise so callers await it (no unhandled
        // rejections); finish/error accounting stays centralized here.
        const streamed = onStream(upstreamRes, model, format)
        res.on("finish", () => { recordReq(req, `${requested}→${model}`, Date.now() - start, 200); recordObserved(model, true) })
        return streamed
      }
      if (forcedStream) {
        // Client asked non-stream but upstream streamed (free-tier requirement):
        // collect SSE and synthesize a non-stream body for onJson.
        try {
          if (format === "responses") {
            const full = await collectResponsesSSE(upstreamRes)
            const out = {
              id: `resp_${Date.now().toString(36)}`,
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: full }],
              }],
            }
            return onJson(out, model, format)
          }
          const { content, tool_calls: tcalls, finish, model: upModel, id, usage } = await collectChatSSE(upstreamRes)
          const out = {
            id: id || `chatcmpl-${Date.now().toString(36)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upModel || model,
            choices: [{
              index: 0,
              message: { role: "assistant", content, ...(tcalls?.length ? { tool_calls: tcalls } : {}) },
              finish_reason: finish ?? "stop",
            }],
            ...(usage ? { usage } : {}),
          }
          return onJson(out, model, format)
        } catch {
          recordReq(req, requested, Date.now() - start, 502)
          return onError(502, { error: { type: "upstream_error", message: "bad upstream response" } })
        }
      }
      try {
        const content = await upstreamRes.json()
        return onJson(content, model, format)
      } catch {
        recordReq(req, requested, Date.now() - start, 502)
        return onError(502, { error: { type: "upstream_error", message: "bad upstream response" } })
      }
    }

    try {
      lastErr = await upstreamRes.json()
    } catch {
      // Upstream SSE error (stream:true always) may not be JSON; read text.
      try {
        const t = await upstreamRes.text()
        lastErr = { error: { type: "upstream_error", message: t.slice(0, 500) } }
      } catch {
        lastErr = { error: { type: "upstream_error", message: `upstream returned ${upstreamRes.status}` } }
      }
    }
    lastStatus = upstreamRes.status
    lastRetryAfter = parseRetryAfter(upstreamRes.headers.get("retry-after"))
    // Try the next candidate not only on 429/5xx but also when the upstream
    // reports a model/environment-level failure (e.g. a provider that is
    // temporarily "unavailable", a geo-blocked free model, or a stale model id)
    // so one dead model doesn't brick the whole request.
    if (retryableUpstream(upstreamRes.status, lastErr)) {
      recordObserved(model, false)
      const wait = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      continue
    }
    recordObserved(model, false)
    break
  }

  recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
  return onError(lastStatus, lastErr, lastRetryAfter)
}

async function handleResponses(req, res) {
  // Direct Responses API passthrough (POST /v1/responses, /responses).
  // Unlike handleChat (which translates chat bodies for responses-family
  // models), this preserves the Responses shape end to end.
  const start = Date.now()
  let body
  try {
    const raw = await readBody(req)
    if (raw.length > MAX_BODY) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
    }
  } catch {
    return json(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
  }

  const { requested, candidates } = resolveModel(body.model)
  const clientStream = body.stream !== false
  const auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    return json(res, 401, { error: { type: "invalid_request_error", message: "invalid proxy key" } })
  }

  let lastErr = null
  let lastStatus = 502
  let used = requested
  for (const model of candidates) {
    used = model
    let payload = { ...body, model }
    if (isFreeModel(model)) {
      // Responses free also needs tools + stream; reuse session for cache key.
      const { session: sess } = zenHeaders(req, auth)
      const fixed = ensureResponsesFreeTier(payload, sess)
      payload = fixed.payload
    }
    const { headers: upHeaders } = zenHeaders(req, auth)
    let upstreamRes
    try {
      upstreamRes = await fetch(`${config.upstream}/responses`, {
        method: "POST",
        headers: upHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (err) {
      lastErr = { error: { type: "upstream_error", message: err.message } }
      lastStatus = 502
      continue
    }

    if (upstreamRes.ok) {
      if (clientStream) {
        relayResponsesPassthrough(req, res, upstreamRes, requested)
        res.on("finish", () => recordReq(req, `${requested}→${model}`, Date.now() - start, 200))
        return
      }
      try {
        const full = await collectResponsesSSE(upstreamRes)
        const out = {
          id: `resp_${Date.now().toString(36)}`,
          object: "response",
          model: requested,
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: full }],
          }],
        }
        recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
        return json(res, 200, out)
      } catch {
        recordReq(req, requested, Date.now() - start, 502)
        return json(res, 502, { error: { type: "upstream_error", message: "bad upstream response" } })
      }
    }

    try {
      lastErr = await upstreamRes.json()
    } catch {
      try {
        const t = await upstreamRes.text()
        lastErr = { error: { type: "upstream_error", message: t.slice(0, 500) } }
      } catch {
        lastErr = { error: { type: "upstream_error", message: `upstream returned ${upstreamRes.status}` } }
      }
    }
    lastStatus = upstreamRes.status
    if (retryableUpstream(upstreamRes.status, lastErr)) {
      const wait = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      continue
    }
    break
  }

  recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
  res.writeHead(lastStatus, { "content-type": "application/json" })
  res.end(
    JSON.stringify(lastErr ?? { error: { type: "free_usage_limit_error", message: "all free models are rate-limited" } }),
  )
}

function relayResponsesPassthrough(req, res, upstreamRes, requested) {
  // Responses SSE is `event: ...\ndata: {...}\n\n`; rewrite embedded model fields.
  res.writeHead(200, {
    "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) res.write(buffer)
          res.end()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          // rewrite model inside data payloads
          const lines = block.split("\n")
          const out = []
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6)
              try {
                const j = JSON.parse(payload)
                if (j?.response?.model) j.response.model = requested
                if (j?.model) j.model = requested
                out.push(`data: ${JSON.stringify(j)}`)
              } catch {
                out.push(line)
              }
            } else {
              out.push(line)
            }
          }
          res.write(out.join("\n") + "\n\n")
        }
      }
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

async function handleMessages(req, res) {
  const start = Date.now()
  let body
  try {
    const raw = await readBody(req)
    if (raw.length > MAX_BODY) {
      return json(res, 413, { type: "error", error: { type: "invalid_request_error", message: "request body too large" } })
    }
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "body must be a JSON object" } })
    }
  } catch {
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } })
  }

  const auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, String(body?.model ?? ""), Date.now() - start, 401)
    return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid proxy key" } })
  }
  if (!Array.isArray(body.messages)) {
    recordReq(req, String(body?.model ?? ""), Date.now() - start, 400)
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages must be an array" } })
  }

  // Unknown models resolve through the same default + fallback chain as
  // handleChat — never a hard 400 here.
  const { requested, candidates } = resolveModel(body.model)
  const clientStream = !!body.stream
  const chatBody = anthropicToChat(body, requested)
  if (clientStream) {
    // True streaming: fetch upstream with stream:true (chat and responses
    // families alike) and translate each SSE block incrementally.
    chatBody.stream = true
    chatBody.stream_options = { include_usage: true }
  }
  const inputFallback = JSON.stringify(chatBody.messages).length >> 2
  return runChatLoop(req, res, {
    body: chatBody,
    requested,
    candidates,
    auth,
    start,
    isStream: clientStream,
    onJson(content, model, format) {
      const chat =
        format === "responses"
          ? responsesToChat(content, requested, model)
          : { ...(content ?? {}), model: requested, ...(model !== requested ? { zen_served_by: model } : {}) }
      const ant = chatToAnthropic(chat, requested, inputFallback)
      if (model !== requested) {
        // Same fallback visibility as handleChat.
        res.setHeader?.("x-zen-served-by", model)
        res.setHeader?.("x-zen-fallback", "true")
      }
      recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
      recordObserved(model, true)
      return json(res, 200, ant)
    },
    onStream(upstreamRes, model, format) {
      if (model !== requested) {
        res.setHeader?.("x-zen-served-by", model)
        res.setHeader?.("x-zen-fallback", "true")
      }
      if (format === "responses") {
        return relayMessagesResponsesStream(req, res, upstreamRes, requested, inputFallback)
      }
      return relayMessagesChatStream(req, res, upstreamRes, requested, inputFallback)
    },
    onError(status, errBody, retryAfter) {
      const message = errBody?.error?.message ?? errBody?.message ?? "upstream error"
      const type =
        status === 429
          ? "rate_limit_error"
          : status === 401 || status === 403
            ? "authentication_error"
            : status === 400
              ? "invalid_request_error"
              : "upstream_error"
      const headers = retryAfter > 0 ? { "retry-after": String(retryAfter) } : {}
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(JSON.stringify({ type: "error", error: { type, message } }))
    },
  })
}

function relayStream(req, res, upstreamRes, requested) {
  res.writeHead(200, {
    "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) res.write(buffer)
          res.end()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const out = rewriteSSE(block, requested)
          if (out) res.write(out)
        }
      }
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

// Build a Responses API request from a chat.completions body.
function responsesRequest(body, model, isStream) {
  const payload = { model, input: chatMessagesToInput(body.messages), stream: !!isStream }
  if (body.temperature != null) payload.temperature = body.temperature
  if (body.top_p != null) payload.top_p = body.top_p
  if (body.parallel_tool_calls != null) payload.parallel_tool_calls = body.parallel_tool_calls
  const tools = chatToolsToResponses(body.tools)
  if (tools) payload.tools = tools
  if (body.tool_choice != null) {
    const tc = body.tool_choice
    payload.tool_choice = typeof tc === "string" ? tc : { type: "function", name: tc?.function?.name ?? tc?.name }
  }
  // Reasoning-first models (muse-spark, gpt-5/6) burn hundreds of tokens on
  // reasoning before emitting text, so a tiny cap yields an empty completion.
  // Only forward a budget the caller actually asked for.
  const mt = body.max_completion_tokens ?? body.max_tokens
  if (mt != null && Number.isFinite(Number(mt)) && Number(mt) > 0) payload.max_output_tokens = Number(mt)
  return payload
}

// Credentials used by the auto-sync health probe. Lets a user probe the
// anonymous free tier (public) even while BYOK is configured, or require the
// key so probes reflect their own quota.
function probeAuthHeader() {
  const mode = String(config.probeAuth ?? "auto").toLowerCase()
  if (mode === "anonymous") return "Bearer public"
  const resolved = resolveZenKey()
  if (resolved) return `Bearer ${resolved}`
  if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
  if (mode === "key") return "Bearer public" // no key configured; anonymous is all we can do
  return "Bearer public"
}

// One-shot liveness probe for a model, using the endpoint family that model
// actually lives on. Returns the raw Response so sync can classify it.
// Free-tier probes must look like opencode: valid session + UA + tools +
// stream. Minimal ping bodies without tools always 403 FreeTierError.
async function probeModel(id, auth, session) {
  const format = modelFormat(id)
  const sess = session && isValidOfficialSession(session) ? session : genOfficialId("ses")
  const proj = genProjectId()
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
    "x-opencode-session": sess,
    "x-opencode-client": "cli",
    "x-opencode-project": proj,
    "x-session-affinity": sess,
    "x-session-id": sess,
  }
  const payload =
    format === "responses"
      ? {
          model: id,
          input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          tools: MIN_OFFICIAL_TOOLS.map((n) => ({
            type: "function", name: n,
            description: `opencode tool ${n}`,
            parameters: { type: "object", properties: {} },
          })),
          store: false,
          prompt_cache_key: sess,
          include: ["reasoning.encrypted_content"],
          stream: true,
        }
      : {
          model: id,
          messages: [{ role: "user", content: "ping" }],
          tools: mkOfficialTools(),
          stream: true,
          stream_options: { include_usage: true },
        }
  return fetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  })
}

// Stream a Responses SSE body back as chat.completion.chunk SSE.
function relayResponsesStream(req, res, upstreamRes, requested) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `chatcmpl-${randomBytes(12).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: "chat.completion.chunk", created, model: requested }
  const state = { tools: [], usage: null, finish: "stop" }
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
  const send = (choices, extra) =>
    res.write(`data: ${JSON.stringify({ ...base, choices, ...(extra ?? {}) })}\n\n`)

  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          let event = ""
          let raw = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim()
            else if (line.startsWith("data:")) raw = line.slice(5).trim()
          }
          if (!raw || raw === "[DONE]") continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          if (data?.response?.usage) state.usage = data.response.usage
          if (data?.type === "response.completed" || data?.type === "response.incomplete") {
            state.finish = data.type === "response.incomplete" ? "length" : state.tools.length ? "tool_calls" : "stop"
            continue
          }
          if (data?.type === "error" || data?.error) continue
          for (const delta of responsesEventToDeltas(event, data, state)) send([{ index: 0, delta, finish_reason: null }])
        }
      }
      send([{ index: 0, delta: {}, finish_reason: state.finish }], state.usage ? { usage: usageToChat(state.usage) } : {})
      res.write("data: [DONE]\n\n")
      res.end()
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

function rewriteSSE(block, requested) {
  if (!block.trim()) return null
  const lines = block.split("\n")
  const out = []
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6)
      if (payload === "[DONE]") {
        out.push(line)
        continue
      }
      try {
        const parsed = JSON.parse(payload)
        if (parsed && typeof parsed === "object" && "model" in parsed) parsed.model = requested
        out.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  return out.join("\n") + "\n\n"
}

let modelsCache = { at: 0, data: [], ok: false }
let modelsFetching = null
async function fetchModels() {
  if (modelsCache.at && Date.now() - modelsCache.at < config.cacheMs) return modelsCache
  if (modelsFetching) return modelsFetching
  modelsFetching = (async () => {
    try {
      const res = await fetch(`${config.upstream}/models`, {
        headers: { "user-agent": config.ua },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const parsed = await res.json()
        const upstreamModels = parsed.data ?? []
        const allowed = ALLOWED()
        const dead = new Set(syncState.dead)
        let free
        if (syncState.ok && syncState.at) {
          const live = new Set([...syncState.working, ...syncState.rateLimited])
          free = upstreamModels.filter((m) => (live.has(m.id) || allowed.has(m.id)) && !dead.has(m.id))
        } else {
          free = upstreamModels.filter((m) => (m.id.endsWith("-free") || m.id === "big-pickle" || allowed.has(m.id)) && !dead.has(m.id))
        }
        modelsCache = { at: Date.now(), data: free, ok: true }
      } else {
        modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
      }
    } catch {
      modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
    }
    return modelsCache
  })()
  try {
    return await modelsFetching
  } finally {
    modelsFetching = null
  }
}

async function syncModels() {
  if (syncState.running) return syncState
  syncState.running = true
  syncState.at = Date.now()
  const start = Date.now()
  try {
    const res = await fetch(`${config.upstream}/models`, {
      headers: { "user-agent": config.ua },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`upstream /models → ${res.status}`)
    const parsed = await res.json()
    const upstreamIds = new Set((parsed.data ?? []).map((m) => m.id))
    const isFree = (id) => VALID_MODEL_ID.test(id) && !NOT_CHAT_SERVABLE.some((re) => re.test(id))
    const current = [...config.fallbackModels].filter(isFree)
    // Everything the upstream currently offers for free. The user's list is
    // merged with this, so a model that exists but is temporarily blocked still
    // gets (re)added — the list self-heals instead of staying shrunken.
    const discovered = [...upstreamIds].filter((id) => (id.endsWith("-free") || id === "big-pickle") && isFree(id))
    const candidates = [...new Set([...current, ...discovered])]
    const working = []
    const rateLimited = []
    const dead = []
    const flaky = []
    const gated = []
    // Only definitively-gone models are dropped from the user's list; `flaky`
    // ones stay configured so they recover on their own.
    const removeFromCurrent = new Set()
    const auth = probeAuthHeader()
    let idx = 0
    const probe = async () => {
      while (idx < candidates.length) {
        const id = candidates[idx++]
        try {
          const r = await probeModel(id, auth, sessionHeader())
          let bodyErr = ""
          try {
            // stream:true probes answer 200 SSE (not JSON) on success; errors
            // may be JSON or SSE text, so read text once and try to parse.
            const t = await r.text()
            try {
              const j = JSON.parse(t)
              if (j && (j.error || j.type === "error")) {
                const e = j.error ?? j
                bodyErr = (e.type || "") + " " + (e.message || "")
              } else if (!r.ok) {
                bodyErr = t.slice(0, 300)
              }
            } catch {
              if (!r.ok) bodyErr = t.slice(0, 300)
            }
          } catch {}
          if (r.ok && !bodyErr) { working.push(id); modelHealth.set(id, 0) }
          else if (r.status === 429 && !bodyErr) { rateLimited.push(id); modelHealth.set(id, 0) }
          else {
            // Only drop a model from the user's config on definitive proof that it
            // is gone: "not supported", 404, "no such model". Everything else
            // (403 FreeTierError, 429, timeouts, 5xx) is a *temporary* access or
            // capacity condition — the model comes back on its own, so deleting it
            // would silently shrink the user's list and lose it forever.
            const gone =
              r.status === 404 ||
              /model_not_found|no such model|does not exist|is not supported|not supported/i.test(bodyErr)
            // Key/auth problems are not model problems either.
            const authErr = /AuthError|invalid api key|missing api key/i.test(bodyErr)
            // 403 FreeTierError means "only real opencode clients may use this".
            // Our probe is not a real client, so this tells us nothing about
            // whether the model works — don't call it flaky, and never remove it.
            const isGated = /FreeTierError|free tier can only/i.test(bodyErr)
            // Temporary blocks: keep the model, just remember it is unhealthy.
            const temporary = /RegionError|not available in your country|rate.?limit|overloaded/i.test(bodyErr)
            if (gone) { dead.push(id); removeFromCurrent.add(id) }
            else if (isGated) { gated.push(id) }
            else if (authErr) { flaky.push(id) }
            else {
              if (temporary) {
                modelHealth.set(id, 0)
                flaky.push(id)
              } else {
                const fails = (modelHealth.get(id) ?? 0) + 1
                modelHealth.set(id, fails)
                if (fails >= 3) { dead.push(id); removeFromCurrent.add(id) }
                else flaky.push(id)
              }
            }
          }
        } catch {
          const fails = (modelHealth.get(id) ?? 0) + 1
          modelHealth.set(id, fails)
          if (fails >= 3) dead.push(id)
          else flaky.push(id)
        }
      }
    }
    await Promise.all([probe(), probe(), probe()])
    // Keep the user's order, drop only definitively-gone models, then append
    // anything upstream offers that the user doesn't have yet. Temporary blocks
    // never remove a model, and new models appear without any manual step.
    const newList = current.filter((id) => !removeFromCurrent.has(id))
    // Only auto-add newly discovered models that are actually reachable (ok,
    // rate-limited or free-tier-gated). A model that errors on its first probe
    // is retired upstream and shouldn't be pushed at the user.
    for (const id of discovered) {
      if (!newList.includes(id) && !removeFromCurrent.has(id) && !flaky.includes(id)) newList.push(id)
    }
    for (const id of working) if (!newList.includes(id)) newList.push(id)
    const changed = newList.join(",") !== current.join(",")
    if (changed && newList.length) {
      config.fallbackModels = newList
      try { saveConfig({ fallbackModels: newList }) } catch {}
      log(`auto-sync: updated model list (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} agent-only, ${flaky.length} flaky, ${dead.length} dead)`)
    } else {
      log(`auto-sync: list unchanged (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} agent-only, ${flaky.length} flaky, ${dead.length} dead)`)
    }
    syncState.working = working
    syncState.rateLimited = rateLimited
    syncState.flaky = flaky
    syncState.gated = gated
    syncState.dead = dead
    syncState.error = ""
    syncState.ok = true
    modelsCache = { at: 0, data: [], ok: true }
  } catch (err) {
    syncState.ok = false
    syncState.error = err.message
    log(`auto-sync failed: ${err.message}`)
  }
  syncState.ms = Date.now() - start
  syncState.running = false
  return syncState
}

// ---- per-IP rate limiting (CWE-770) ---------------------------------------
// Scoped to the inference endpoints only: the dashboard, /health and the
// admin API stay reachable, otherwise the UI's own polling would trip it.
const rateBuckets = new Map()
function rateLimitFor(req) {
  const max = Number(config.rateLimitMax ?? 0)
  if (!Number.isFinite(max) || max <= 0) return { limited: false }
  const window = Number(config.rateLimitWindowMs) > 0 ? Number(config.rateLimitWindowMs) : 60_000
  const key = clientIp(req) || "unknown"
  const now = Date.now()
  let hits = rateBuckets.get(key)
  if (!hits) {
    hits = []
    rateBuckets.set(key, hits)
  }
  while (hits.length && now - hits[0] >= window) hits.shift()
  if (hits.length >= max) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((hits[0] + window - now) / 1000)) }
  }
  hits.push(now)
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) if (!v.length || now - v[v.length - 1] >= window) rateBuckets.delete(k)
  }
  return { limited: false }
}

let syncTimer = null
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  if (!config.autoSync || config.autoSyncIntervalMs <= 0) return
  syncTimer = setTimeout(async () => {
    await syncModels()
    scheduleSync()
  }, config.autoSyncIntervalMs)
  if (syncTimer.unref) syncTimer.unref()
}

// Auto-UA: opencode ships new versions regularly; keeping the injected
// `opencode/latest/<version>/cli` User-Agent current future-proofs the free-tier unlock.
const uaAutoState = { at: 0, version: "" }
async function refreshUA(force = false) {
  if (!config.autoUA) return ""
  const now = Date.now()
  if (!force && uaAutoState.at && now - uaAutoState.at < config.uaRefreshMs) return uaAutoState.version
  uaAutoState.at = now
  try {
    // Official CLI is now `@opencode/cli` (2.x); old `opencode-ai` is stale.
    // Try new package first, fall back to legacy.
    let v = ""
    for (const pkg of ["@opencode/cli", "opencode-ai"]) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) continue
        const data = await res.json()
        const cand = String(data?.version ?? "")
        if (/^\d+\.\d+\.\d+/.test(cand)) {
          v = cand
          break
        }
      } catch {}
    }
    if (!v) return uaAutoState.version
    uaAutoState.version = v
    const next = `opencode/latest/${v}/cli`
    if (next !== config.ua && /^opencode\/(latest\/)?\d+\.\d+\.\d+(\/cli)?$/.test(config.ua)) {
      log(`auto-UA: opencode ${v} released — updating User-Agent`)
      try { saveConfig({ ua: next }) } catch {}
    }
    return v
  } catch {
    return uaAutoState.version
  }
}

let uaTimer = null
function scheduleUA() {
  if (uaTimer) clearTimeout(uaTimer)
  if (!config.autoUA || config.uaRefreshMs <= 0) return
  uaTimer = setTimeout(async () => {
    await refreshUA()
    scheduleUA()
  }, config.uaRefreshMs)
  if (uaTimer.unref) uaTimer.unref()
}

async function handleModels(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  json(res, 200, { object: "list", data: cache.data, ok: cache.ok })
}

function adminAuth(req, res) {
  if (config.proxyKey && bearer(req) !== config.proxyKey) {
    json(res, 401, { error: "unauthorized" })
    return false
  }
  return true
}

async function handleApiConfig(req, res) {
  if (!adminAuth(req, res)) return
  if (req.method === "GET") return json(res, 200, { config: sanitize(config) })
  if (req.method === "POST") {
    // Reset the model list back to the shipped defaults (useful if the list was
    // trimmed by an older build or edited by hand). User keys are untouched.
    try {
      const body = await readBody(req)
      const parsed = body ? JSON.parse(body) : {}
      if (parsed.fallbackModels !== true) return json(res, 400, { error: "unsupported action" })
      const shipped = JSON.parse(JSON.stringify(DEFAULT_CONFIG.fallbackModels))
      const kept = config.fallbackModels.filter((m) => !shipped.includes(m))
      const merged = [...new Set([...kept, ...shipped])]
      saveConfig({ fallbackModels: merged })
      scheduleSync()
      log(`model list restored to defaults (${merged.length} models)`)
      return json(res, 200, { ok: true, config: sanitize(config) })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }
  if (req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req))
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("body must be a JSON object")
      const cleaned = {}
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (key in body) cleaned[key] = body[key]
      }
      cleaned.port = num(cleaned.port ?? config.port, config.port)
      cleaned.timeoutMs = num(cleaned.timeoutMs ?? config.timeoutMs, config.timeoutMs)
      cleaned.cacheMs = num(cleaned.cacheMs ?? config.cacheMs, config.cacheMs)
      cleaned.autoSyncIntervalMs = num(cleaned.autoSyncIntervalMs ?? config.autoSyncIntervalMs, config.autoSyncIntervalMs)
      cleaned.uaRefreshMs = num(cleaned.uaRefreshMs ?? config.uaRefreshMs, config.uaRefreshMs)
      cleaned.rateLimitMax = num(cleaned.rateLimitMax ?? config.rateLimitMax, config.rateLimitMax)
      cleaned.rateLimitWindowMs = num(cleaned.rateLimitWindowMs ?? config.rateLimitWindowMs, config.rateLimitWindowMs)
      if (cleaned.rateLimitMax < 0) cleaned.rateLimitMax = 0
      if (cleaned.rateLimitWindowMs <= 0) cleaned.rateLimitWindowMs = config.rateLimitWindowMs
      if (cleaned.cacheMs < 0) cleaned.cacheMs = config.cacheMs
      cleaned.trustForwarded = toBool(cleaned.trustForwarded, config.trustForwarded)
      cleaned.autoSync = toBool(cleaned.autoSync, config.autoSync)
      cleaned.autoUA = toBool(cleaned.autoUA, config.autoUA)
      cleaned.injectSession = toBool(cleaned.injectSession, config.injectSession)
      if (cleaned.proxyKey === "••••••••") cleaned.proxyKey = config.proxyKey
      if (cleaned.probeAuth != null && !["auto", "key", "anonymous"].includes(String(cleaned.probeAuth))) {
        cleaned.probeAuth = "auto"
      }
      if (cleaned.defaultZenKey === sanitize({ defaultZenKey: config.defaultZenKey }).defaultZenKey) {
        cleaned.defaultZenKey = config.defaultZenKey
      }
      if (!Array.isArray(cleaned.fallbackModels)) cleaned.fallbackModels = config.fallbackModels
      if (!Array.isArray(cleaned.responsesModels)) cleaned.responsesModels = config.responsesModels
      if (typeof cleaned.modelAliases !== "object" || cleaned.modelAliases === null) {
        cleaned.modelAliases = config.modelAliases
      }
      saveConfig(cleaned)
      scheduleSync()
      scheduleUA()
      log("config updated via UI")
      return json(res, 200, { config: sanitize(config) })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }
  return json(res, 405, { error: "method not allowed" })
}

async function handleStatus(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  const now = Date.now()
  while (requestStats.window60.length && requestStats.window60[0] < now - 60_000) requestStats.window60.shift()
  const minute = Math.floor(now / 60000)
  const lastMinute = requestStats.window60.length
  let last5m = 0
  for (const [m, c] of requestStats.perMinute) {
    if (minute - m <= 5) last5m += c
  }
  const authMode = config.defaultZenKey ? (config.proxyKey ? "proxy+byok" : "byok") : config.proxyKey ? "proxy" : "public"
  json(res, 200, {
    uptime: Math.floor(process.uptime()),
    upstreamOk: cache.ok,
    upstream: config.upstream,
    ua: config.ua,
    uaAutoVersion: uaAutoState.version,
    defaultModel: config.defaultModel,
    effectiveDefault: effectiveDefault(),
    auth: { mode: authMode, zenKey: maskKey(config.defaultZenKey), proxyKey: !!config.proxyKey },
    responsesModels: [...(config.responsesModels ?? [])],
    rateLimit: { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
    probeAuth: config.probeAuth ?? "auto",
    models: {
      total: cache.data.length,
      allowed: ALLOWED().size,
      served: cache.data.map((m) => m.id),
    },
    sync: {
      ok: syncState.ok,
      at: syncState.at,
      running: syncState.running,
      ms: syncState.ms,
      working: [...syncState.working],
      rateLimited: [...syncState.rateLimited],
      gated: [...syncState.gated],
      flaky: [...syncState.flaky],
      dead: [...syncState.dead],
      // Health learned from real client requests — the only reliable signal for
      // models the free tier hides from the synthetic probe.
      observed: Object.fromEntries(observed),
      error: syncState.error,
    },
    requests: { total: requestStats.total, errors: requestStats.errors, lastMinute, last5m },
    recent: requestStats.recent.map(([k, count, ms]) => ({ ...parseKey(k), count, ms })),
  })
}

function parseKey(key) {
  const [at, model, status] = key.split("|")
  return { at: Number(at), model, status: Number(status) }
}

async function handleTest(req, res) {
  if (!adminAuth(req, res)) return
  try {
    const body = JSON.parse(await readBody(req))
    const model = String(body.model ?? effectiveDefault())
    const start = Date.now()
    // Explicit key override lets the dashboard "test my key" flow verify a typed
    // key before saving it. Falls back to the normal auth path otherwise.
    const auth =
      typeof body.zenKey === "string" && body.zenKey.trim()
        ? `Bearer ${body.zenKey.trim()}`
        : (authForUpstream(req) ?? "Bearer public")
    const format = modelFormat(model)
    const testSess = genOfficialId("ses")
    const testProj = genProjectId()
    const testBody =
      format === "responses"
        ? {
            model,
            input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
            tools: MIN_OFFICIAL_TOOLS.map((n) => ({
              type: "function", name: n,
              description: `opencode tool ${n}`,
              parameters: { type: "object", properties: {} },
            })),
            store: false,
            prompt_cache_key: testSess,
            include: ["reasoning.encrypted_content"],
            stream: false,
          }
        : {
            model,
            messages: [{ role: "user", content: "ping" }],
            tools: mkOfficialTools(),
            stream: false,
          }
    // For free models, force stream:true for the probe (else always 403).
    if (isFreeModel(model)) {
      testBody.stream = true
      if (format !== "responses") testBody.stream_options = { include_usage: true }
    }
    const ip = clientIp(req)
    const upstreamRes = await fetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: auth,
        "user-agent": config.ua,
        "x-opencode-session": testSess,
        "x-opencode-client": "cli",
        "x-opencode-project": testProj,
        "x-session-affinity": testSess,
        "x-session-id": testSess,
        ...(!ipOmit(ip) ? { "x-real-ip": ip } : {}),
      },
      body: JSON.stringify(testBody),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    let detail = ""
    let gated = false
    try {
      const ctype = upstreamRes.headers.get("content-type") ?? ""
      if (ctype.includes("text/event-stream")) {
        const t = await upstreamRes.text()
        detail = t.slice(0, 300)
        // SSE 200 means working even though it's not JSON
        if (upstreamRes.ok && !detail.includes("FreeTierError") && !detail.includes("error")) {
          detail = "stream ok: " + detail.slice(0, 200)
        }
      } else {
        const parsed = await upstreamRes.json()
        if (format === "responses") detail = parsed.error?.message ?? (typeof parsed.output_text === "string" ? parsed.output_text : "")
        else detail = parsed.error?.message ?? parsed.choices?.[0]?.message?.content ?? ""
      }
      // A free-tier gate here is not a failure of the model: the free tier only
      // accepts genuine agent traffic, which a bare ping never is.
      if (upstreamRes.status === 403 && /FreeTierError|free tier can only/i.test(detail)) gated = true
    } catch {}
    json(res, 200, {
      ok: upstreamRes.ok || gated,
      gated,
      model,
      format,
      status: upstreamRes.status,
      ms: Date.now() - start,
      detail: gated ? "free tier accepts real agent requests only — this probe can't verify it" : detail,
    })
  } catch (err) {
    json(res, 400, { ok: false, error: err.message })
  }
}

function handleLogs(req, res) {
  if (!adminAuth(req, res)) return
  const n = Number(new URL(req.url, "http://x").searchParams.get("n") ?? 200)
  json(res, 200, { logs: logLines.slice(-n) })
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const p = url.pathname

  if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/ui")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(uiHtml || "<h1>UI not found</h1>")
  }
  if (req.method === "GET" && p.startsWith("/assets/")) {
    const file = path.join(__dirname, "assets", path.basename(p))
    try {
      const data = fs.readFileSync(file)
      const types = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      })
      return res.end(data)
    } catch {
      return json(res, 404, { error: "not found" })
    }
  }
  if (req.method === "GET" && p === "/health") {
    const cache = await fetchModels()
    return json(res, 200, { ok: cache.ok, upstream: config.upstream })
  }
  if (req.method === "GET" && p === "/robots.txt") {
    // Keep search-engine crawlers off the proxy (saves free-tier hours/quota).
    // Uptime monitors don't obey robots.txt, so keep-alive pings still work.
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    return res.end("User-agent: *\nDisallow: /\n")
  }

  if (p.startsWith("/api/")) {
    if (p === "/api/config") return handleApiConfig(req, res)
    if (p === "/api/status" && req.method === "GET") return handleStatus(req, res)
    if (p === "/api/test" && req.method === "POST") return handleTest(req, res)
    if (p === "/api/logs" && req.method === "GET") return handleLogs(req, res)
    if (p === "/api/sync" && req.method === "POST") {
      if (!adminAuth(req, res)) return
      syncModels().then((s) => json(res, 200, { ok: s.ok, ...s }))
      return
    }
    if (p === "/api/reset" && req.method === "POST") {
      if (!adminAuth(req, res)) return
      requestStats.total = 0
      requestStats.errors = 0
      requestStats.recent = []
      requestStats.perMinute.clear()
      requestStats.window60 = []
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: "not found" })
  }

  if (req.method === "GET" && (p === "/v1/models" || p === "/models")) return handleModels(req, res)
  if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
    // Throttle only the inference endpoints — the dashboard, /health and the
    // admin API must never be locked out by a client's burst.
    const rl = rateLimitFor(req)
    if (rl.limited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) })
      return res.end(
        JSON.stringify({
          error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` },
        }),
      )
    }
    return handleChat(req, res)
  }
  if (req.method === "POST" && (p === "/v1/responses" || p === "/responses")) {
    const rl = rateLimitFor(req)
    if (rl.limited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) })
      return res.end(
        JSON.stringify({
          error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` },
        }),
      )
    }
    return handleResponses(req, res)
  }
  if (req.method === "POST" && (p === "/v1/messages" || p === "/messages")) {
    // Anthropic Messages API — same throttling as the chat route.
    const rl = rateLimitFor(req)
    if (rl.limited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) })
      return res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` },
        }),
      )
    }
    return handleMessages(req, res)
  }
  json(res, 404, { error: { type: "not_found", message: p } })
}

const server = http.createServer(router)

server.requestTimeout = 0
server.headersTimeout = 60_000

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} already in use. Set PORT or edit zen-proxy.json.`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

if (isMain) {
  server.listen(config.port, config.host, () => {
    log(`zen-proxy listening on http://${config.host}:${config.port}`)
    log(`upstream ${config.upstream}  UA ${config.ua}  default ${config.defaultModel || "(auto)"}`)
    log(`config file: ${CONFIG_PATH}  UI: /`)
    if (!fs.existsSync(CONFIG_PATH)) {
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
        log(`created default config: ${CONFIG_PATH}`)
      } catch {}
    }
    if (config.autoUA) {
      log("auto-UA enabled — checking for new opencode releases…")
      refreshUA()
    }
    if (config.autoSync) {
      log(`auto-sync enabled (every ${Math.round(config.autoSyncIntervalMs / 60000)} min) — probing free models…`)
      syncModels()
    }
    scheduleSync()
    scheduleUA()
  })
}

export {
  isMain,
  config,
  loadConfig,
  saveConfig,
  sanitize,
  maskKey,
  resolveModel,
  effectiveDefault,
  modelFormat,
  responsesRequest,
  responsesToChat,
  responsesEventToDeltas,
  usageToChat,
  chatMessagesToInput,
  chatToolsToResponses,
  rateLimitFor,
  probeAuthHeader,
  authForUpstream,
  clientIp,
  ipOmit,
  zenHeaders,
  recordReq,
  requestStats,
  syncState,
  handleChat,
  handleResponses,
  handleMessages,
  anthropicToChat,
  anthropicStopReason,
  relayMessagesChatStream,
  relayMessagesResponsesStream,
  chatToAnthropic,
  relayStream,
  relayResponsesStream,
  relayResponsesPassthrough,
  rewriteSSE,
  fetchModels,
  handleModels,
  handleApiConfig,
  handleStatus,
  handleTest,
  handleLogs,
  logLines,
  router,
  syncModels,
  scheduleSync,
  refreshUA,
  scheduleUA,
  parseRetryAfter,
  retryableUpstream,
  toBool,
  sessionFor,
  sessionHeader,
  genOfficialId,
  genProjectId,
  mkOfficialTools,
  hasEnoughOfficialTools,
  isFreeModel,
  ensureChatFreeTier,
  ensureResponsesFreeTier,
  collectChatSSE,
  collectResponsesSSE,
  loadLocalZenKey,
  resolveZenKey,
  MAX_BODY,
  VALID_MODEL_ID,
}