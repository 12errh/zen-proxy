#!/usr/bin/env node
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")
const UI_PATH = path.join(__dirname, "public", "index.html")
const ENV = process.env

const DEFAULT_CONFIG = {
  host: ENV.HOST ?? "127.0.0.1",
  port: Number(ENV.PORT ?? 8787),
  upstream: (ENV.ZEN_URL ?? "https://opencode.ai/zen/v1").replace(/\/+$/, ""),
  ua: ENV.ZEN_UA ?? "opencode/1.2.31",
  defaultModel: ENV.DEFAULT_MODEL ?? "deepseek-v4-flash-free",
  fallbackModels: JSON.parse(
    ENV.FALLBACK_MODELS ??
      JSON.stringify([
        "deepseek-v4-flash-free",
        "big-pickle",
        "hy3-free",
        "mimo-v2.5-free",
        "nemotron-3.5-lightning-free",
        "nemotron-3-ultra-free",
        "laguna-s-2.1-free",
      ]),
  ),
  modelAliases: JSON.parse(ENV.MODEL_ALIASES ?? "{}"),
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
    return { ...DEFAULT_CONFIG, ...raw }
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

function parseRetryAfter(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(v)
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000)
  return 0
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
const syncState = { at: 0, ok: false, running: false, working: [], rateLimited: [], flaky: [], dead: [], error: "", ms: 0 }
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
    requestStats.recent.push([key, 1])
    if (requestStats.recent.length > 200) requestStats.recent.shift()
  } else {
    requestStats.recent[requestStats.recent.length - 1][1]++
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

function resolveModel(requested) {
  const id = String(requested ?? "").split("/").pop()
  const target = config.modelAliases[id] || (ALLOWED().has(id) ? id : "") || config.defaultModel
  const rest = config.fallbackModels.filter((m) => m !== target)
  return { requested: id || config.defaultModel, candidates: [target, ...rest] }
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

function zenHeaders(req, auth) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
  }
  const ip = clientIp(req)
  if (!ipOmit(ip)) headers["x-real-ip"] = ip
  for (const h of ["x-opencode-session", "x-opencode-request", "x-opencode-client", "x-opencode-project"]) {
    const v = req.headers[h]
    if (typeof v === "string" && v) headers[h] = v
  }
  return headers
}

function bearer(req) {
  const v = req.headers["authorization"]
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : ""
}

function authForUpstream(req) {
  const incoming = bearer(req)
  if (config.proxyKey) {
    if (incoming !== config.proxyKey) return null
    const zen = req.headers["x-zen-key"]
    if (typeof zen === "string" && zen && zen !== "public") return `Bearer ${zen}`
    if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
    return "Bearer public"
  }
  if (incoming && incoming !== "public") return `Bearer ${incoming}`
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

  let lastErr = null
  let lastStatus = 502
  let used = requested
  for (const model of candidates) {
    used = model
    const payload = { ...body, model }
    let upstreamRes
    try {
      upstreamRes = await fetch(`${config.upstream}/chat/completions`, {
        method: "POST",
        headers: zenHeaders(req, auth),
        body: JSON.stringify(payload),
        signal: isStream ? req.signal : AbortSignal.timeout(config.timeoutMs),
      })
    } catch (err) {
      lastErr = { error: { type: "upstream_error", message: err.message } }
      lastStatus = 502
      continue
    }

    if (upstreamRes.ok) {
      const contentType = upstreamRes.headers.get("content-type") ?? "application/json"
      if (isStream) {
        relayStream(req, res, upstreamRes, requested)
        res.on("finish", () => recordReq(req, `${requested}→${model}`, Date.now() - start, 200))
        return
      }
      try {
        const content = await upstreamRes.json()
        if (content && typeof content === "object") content.model = requested
        recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
        return json(res, 200, content)
      } catch {
        recordReq(req, requested, Date.now() - start, 502)
        return json(res, 502, { error: { type: "upstream_error", message: "bad upstream response" } })
      }
    }

    try {
      lastErr = await upstreamRes.json()
    } catch {
      lastErr = { error: { type: "upstream_error", message: `upstream returned ${upstreamRes.status}` } }
    }
    lastStatus = upstreamRes.status
    const wait = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
    if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
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
        let free
        if (syncState.ok && syncState.at) {
          const live = new Set([...syncState.working, ...syncState.rateLimited])
          free = upstreamModels.filter((m) => live.has(m.id) || allowed.has(m.id))
        } else {
          free = upstreamModels.filter((m) => m.id.endsWith("-free") || allowed.has(m.id))
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
    const current = [...config.fallbackModels].filter((id) => VALID_MODEL_ID.test(id))
    const candidates = [...new Set([...current, ...[...upstreamIds].filter((id) => id.endsWith("-free") && VALID_MODEL_ID.test(id))])]
    const working = []
    const rateLimited = []
    const dead = []
    const flaky = []
    const removeFromCurrent = new Set()
    const auth = config.defaultZenKey ? `Bearer ${config.defaultZenKey}` : "Bearer public"
    let idx = 0
    const probe = async () => {
      while (idx < candidates.length) {
        const id = candidates[idx++]
        try {
          const r = await fetch(`${config.upstream}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              authorization: auth,
              "user-agent": config.ua,
            },
            body: JSON.stringify({ model: id, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
            signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
          })
          let bodyErr = ""
          if (r.status === 200) {
            try {
              const j = await r.json()
              if (j && j.error) bodyErr = (j.error.type || "") + " " + (j.error.message || "")
            } catch {}
          }
          if (r.ok && !bodyErr) { working.push(id); modelHealth.set(id, 0) }
          else if (r.status === 429 && !bodyErr) { rateLimited.push(id); modelHealth.set(id, 0) }
          else {
            const definiteDead = r.status === 404 || /model_not_found|no such model|does not exist/i.test(bodyErr || `${r.status}`)
            const fails = (modelHealth.get(id) ?? 0) + 1
            modelHealth.set(id, fails)
            if (definiteDead) { dead.push(id); removeFromCurrent.add(id) }
            else if (fails >= 2) { dead.push(id); removeFromCurrent.add(id) }
            else { flaky.push(id) }
          }
        } catch {
          const fails = (modelHealth.get(id) ?? 0) + 1
          modelHealth.set(id, fails)
          if (fails >= 2) { dead.push(id); removeFromCurrent.add(id) }
          else flaky.push(id)
        }
      }
    }
    await Promise.all([probe(), probe(), probe()])
    const newList = current.filter((id) => !removeFromCurrent.has(id))
    for (const id of working) if (!newList.includes(id)) newList.push(id)
    if (config.defaultModel && !newList.includes(config.defaultModel)) newList.push(config.defaultModel)
    const changed = newList.join(",") !== current.join(",")
    if (changed && newList.length) {
      config.fallbackModels = newList
      try { saveConfig({ fallbackModels: newList }) } catch {}
      log(`auto-sync: updated model list (${working.length} ok, ${rateLimited.length} rate-limited, ${flaky.length} flaky, ${dead.length} dead)`)
    } else {
      log(`auto-sync: list unchanged (${working.length} ok, ${rateLimited.length} rate-limited, ${flaky.length} flaky, ${dead.length} dead)`)
    }
    syncState.working = working
    syncState.rateLimited = rateLimited
    syncState.flaky = flaky
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
      if (cleaned.cacheMs < 0) cleaned.cacheMs = config.cacheMs
      cleaned.trustForwarded = toBool(cleaned.trustForwarded, config.trustForwarded)
      cleaned.autoSync = toBool(cleaned.autoSync, config.autoSync)
      if (cleaned.proxyKey === "••••••••") cleaned.proxyKey = config.proxyKey
      if (cleaned.defaultZenKey === sanitize({ defaultZenKey: config.defaultZenKey }).defaultZenKey) {
        cleaned.defaultZenKey = config.defaultZenKey
      }
      if (!Array.isArray(cleaned.fallbackModels)) cleaned.fallbackModels = config.fallbackModels
      if (typeof cleaned.modelAliases !== "object" || cleaned.modelAliases === null) {
        cleaned.modelAliases = config.modelAliases
      }
      saveConfig(cleaned)
      scheduleSync()
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
  json(res, 200, {
    uptime: Math.floor(process.uptime()),
    upstreamOk: cache.ok,
    upstream: config.upstream,
    ua: config.ua,
    defaultModel: config.defaultModel,
    models: { total: cache.data.length, allowed: ALLOWED().size },
    sync: {
      ok: syncState.ok,
      at: syncState.at,
      running: syncState.running,
      ms: syncState.ms,
      working: [...syncState.working],
      rateLimited: [...syncState.rateLimited],
      flaky: [...syncState.flaky],
      dead: [...syncState.dead],
      error: syncState.error,
    },
    requests: { total: requestStats.total, errors: requestStats.errors, lastMinute, last5m },
    recent: requestStats.recent.map(([k, count]) => ({ ...parseKey(k), count })),
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
    const model = String(body.model ?? config.defaultModel)
    const start = Date.now()
    const auth = authForUpstream(req) ?? "Bearer public"
    const upstreamRes = await fetch(`${config.upstream}/chat/completions`, {
      method: "POST",
      headers: (() => {
        const h = {
          "content-type": "application/json",
          accept: "application/json",
          authorization: auth,
          "user-agent": config.ua,
        }
        const ip = req.socket.remoteAddress ?? ""
        if (!ipOmit(ip)) h["x-real-ip"] = ip
        return h
      })(),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    let detail = ""
    try {
      const parsed = await upstreamRes.json()
      detail = parsed.error?.message ?? parsed.choices?.[0]?.message?.content ?? ""
    } catch {}
    json(res, 200, { ok: upstreamRes.ok, model, status: upstreamRes.status, ms: Date.now() - start, detail })
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
  if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions" || p === "/v1/responses" || p === "/responses")) {
    return handleChat(req, res)
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
    log(`upstream ${config.upstream}  UA ${config.ua}  default ${config.defaultModel}`)
    log(`config file: ${CONFIG_PATH}  UI: /`)
    if (!fs.existsSync(CONFIG_PATH)) {
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
        log(`created default config: ${CONFIG_PATH}`)
      } catch {}
    }
    if (config.autoSync) {
      log(`auto-sync enabled (every ${Math.round(config.autoSyncIntervalMs / 60000)} min) — probing free models…`)
      syncModels()
    }
    scheduleSync()
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
  authForUpstream,
  clientIp,
  ipOmit,
  zenHeaders,
  recordReq,
  requestStats,
  handleChat,
  relayStream,
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
  parseRetryAfter,
  toBool,
  MAX_BODY,
  VALID_MODEL_ID,
}