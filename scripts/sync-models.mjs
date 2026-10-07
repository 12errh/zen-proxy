#!/usr/bin/env node
// GitHub Actions model sync.
//
// Fetches opencode's Zen free model list, health-probes each free candidate like
// the proxy does at runtime, then updates the shipped defaults in zen-proxy.mjs
// (fallbackModels + auto defaultModel) and commits/pushes when anything changed.
// This keeps the repository's model list current as models come and go over time
// without any hand-tuning.
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const MAIN = path.join(ROOT, "zen-proxy.mjs")
const SNAPSHOT = path.join(ROOT, "free-models.json")
const UPSTREAM = "https://opencode.ai/zen/v1"
const UA = "opencode/latest/2.0.9/cli"
const CONCURRENCY = 3
const TIMEOUT_MS = 20_000
const KNOWN_FREE = new Set(["big-pickle"])
const OFFICIAL_TOOLS = ["edit", "glob", "grep", "question", "read", "shell"]
// Free models that are NOT reachable through /chat/completions or /responses.
// jev-* is served on /v1/systemone (structured classification), so routing it
// through a chat endpoint can only ever fail.
const NOT_CHAT_SERVABLE = [/^jev-/]
// Endpoint family is read from zen-proxy.mjs (see readResponsesModels) so the
// script and the proxy can never drift apart.

let RESPONSES_PATTERNS = []
function modelFormat(id) {
  for (const p of RESPONSES_PATTERNS) {
    if (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p) return "responses"
  }
  return "chat"
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA, ...headers }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function latestOpencodeVersion() {
  // Official CLI moved from `opencode-ai` to `@opencode/cli` (2.x).
  for (const pkg of ["@opencode/cli", "opencode-ai"]) {
    try {
      const d = await getJSON(`https://registry.npmjs.org/${pkg}/latest`)
      const v = String(d?.version ?? "")
      if (/^\d+\.\d+\.\d+/.test(v)) return v
    } catch {}
  }
  return ""
}

function genOfficialSession() {
  // Replicates opencode descending ID so probes look official.
  const cur = Date.now()
  // simple per-process counter
  genOfficialSession._c = (genOfficialSession._c ?? 0) + 1
  let now = BigInt(cur) * BigInt(0x1000) + BigInt(genOfficialSession._c)
  now = ~now
  const low = now & ((1n << 48n) - 1n)
  const hex = low.toString(16).padStart(12, "0")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = randomBytes(14)
  let rand = ""
  for (let i = 0; i < 14; i++) rand += chars[bytes[i] % 62]
  return `ses_${hex}${rand}`
}

async function probe(id, ua, session, authKey) {
  const started = Date.now()
  const format = modelFormat(id)
  const url = `${UPSTREAM}${format === "responses" ? "/responses" : "/chat/completions"}`
  const proj = randomBytes(20).toString("hex")
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${authKey}`,
    "user-agent": ua,
    "x-opencode-session": session,
    "x-opencode-client": "cli",
    "x-opencode-project": proj,
    "x-session-affinity": session,
    "x-session-id": session,
  }
  // Free-tier probes must look like opencode: valid session + UA + tools +
  // stream. Minimal ping bodies without tools always 403 FreeTierError.
  const body = format === "responses"
    ? {
        model: id,
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
        tools: OFFICIAL_TOOLS.map((n) => ({
          type: "function", name: n,
          description: `opencode tool ${n}`,
          parameters: { type: "object", properties: {} },
        })),
        store: false,
        prompt_cache_key: session,
        include: ["reasoning.encrypted_content"],
        stream: true,
      }
    : {
        model: id,
        messages: [{ role: "user", content: "ping" }],
        tools: OFFICIAL_TOOLS.map((n) => ({
          type: "function",
          function: { name: n, description: `opencode tool ${n}`, parameters: { type: "object", properties: {} } },
        })),
        stream: true,
        stream_options: { include_usage: true },
      }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // stream:true => success is 200 SSE (not JSON). Read text once.
    const text = await res.text().catch(() => "")
    let err = ""
    if (!res.ok) {
      try {
        const j = JSON.parse(text)
        const e = j.error ?? j
        err = `${e.type || ""} ${e.message || ""}`
      } catch {
        err = text.slice(0, 300)
      }
    }
    if (res.ok && !err) return { status: "ok", ms: Date.now() - started }
    if (res.status === 429) return { status: "rate-limited", ms: Date.now() - started }
    // Without a real SK (CI), every free model 403 FreeTierError. Don't nuke
    // the list in that case — treat as unknown/ok-needs-key.
    if (/only be used in opencode|FreeTierError/i.test(err) && authKey === "public")
      return { status: "ok-needs-key", ms: Date.now() - started, detail: err }
    // Definitive removal only when the model is genuinely gone. A 403
    // (FreeTierError / RegionError) is a temporary access policy, so the model
    // stays in the list and recovers on its own.
    if (res.status === 404 || /not supported|no such model|does not exist|model_not_found/i.test(err))
      return { status: "removed", ms: Date.now() - started, detail: err }
    if (/FreeTierError|free tier can only|RegionError|not available in your country|overloaded|unavailable/i.test(err) || res.status === 403)
      return { status: "unavailable", ms: Date.now() - started, detail: err }
    return { status: "unstable", ms: Date.now() - started, detail: err }
  } catch (e) {
    return { status: "unstable", ms: -1, detail: String(e?.message || e) }
  }
}

function readDefaultList(src) {
  const m = src.match(/JSON\.stringify\(\[([\s\S]*?)\]\),\n\s*\),\n\s*modelAliases:/)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

// Endpoint family comes from zen-proxy.mjs itself so there is a single source
// of truth (no drift between the proxy and this script).
function readResponsesModels(src) {
  const m = src.match(/responsesModels: JSON\.parse\(\s*ENV\.RESPONSES_MODELS \?\?\s*JSON\.stringify\(\[([\s\S]*?)\]\)/)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

function patchDefaults(src, list) {
  const i0 = src.indexOf("fallbackModels:")
  const start = src.indexOf("[", i0)
  if (start < 0) throw new Error("fallbackModels array not found")
  // balance brackets from the array literal
  let depth = 0
  let end = start
  for (; end < src.length; end++) {
    const c = src[end]
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) break
    }
  }
  if (end >= src.length) throw new Error("unterminated fallbackModels array")
  // items sit two spaces deeper than the line that opens the array literal
  const lineEnd = src.indexOf("\n", start) === -1 ? src.length : src.indexOf("\n", start)
  const arrayIndent = (src.slice(src.lastIndexOf("\n", start) + 1, lineEnd).match(/^\s*/) || [""])[0].length
  const itemIndent = arrayIndent + 2
  const body = list.map((id) => `${" ".repeat(itemIndent)}${JSON.stringify(id)},`).join("\n")
  const replacement = `[\n${body}\n${" ".repeat(arrayIndent)}]`
  let out = src.slice(0, start) + replacement + src.slice(end + 1)
  out = out.replace(/defaultModel: ENV\.DEFAULT_MODEL \?\? "([^"]*)"/, 'defaultModel: ENV.DEFAULT_MODEL ?? ""')
  return out
}

async function main() {
  const version = await latestOpencodeVersion()
  const ua = version ? `opencode/latest/${version}/cli` : UA
  log(`latest opencode: ${version || "unknown"} (UA ${ua})`)
  // In CI there is no opencode.db anonymous key; use ZEN_KEY if provided,
  // otherwise probes will get FreeTierError and be marked ok-needs-key.
  const authKey = process.env.ZEN_KEY || process.env.OPENCODE_ZEN_KEY || "public"
  if (authKey === "public") log("no ZEN_KEY: free probes will be marked ok-needs-key on FreeTierError")

  const listRes = await getJSON(`${UPSTREAM}/models`)
  const upstream = (listRes.data ?? []).map((m) => m.id)
  const catalog = [
    ...new Set(upstream.filter((id) => (id.endsWith("-free") || KNOWN_FREE.has(id)) && !NOT_CHAT_SERVABLE.some((re) => re.test(id)))),
  ]
  if (!catalog.length) throw new Error("no free models found upstream")
  log(`upstream free catalog: ${catalog.length} models`)

  // Keep the previous order as a stable prefix, then append brand-new models.
  const src = fs.readFileSync(MAIN, "utf8")
  RESPONSES_PATTERNS = readResponsesModels(src)
  log(`responses-endpoint patterns: ${RESPONSES_PATTERNS.join(", ") || "(none)"}`)
  const previous = readDefaultList(src).filter((id) => catalog.includes(id))
  const ordered = [...previous, ...catalog.filter((id) => !previous.includes(id))]

  const results = new Map()
  let i = 0
  async function worker() {
    while (i < ordered.length) {
      const id = ordered[i++]
      const session = genOfficialSession()
      results.set(id, await probe(id, ua, session, authKey))
      log(`probed ${id} -> ${results.get(id).status}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const bucket = (status) => ordered.filter((id) => results.get(id).status === status)
  const healthy = [...bucket("ok"), ...bucket("ok-needs-key")]
  const rateLimited = bucket("rate-limited")
  const unavailable = bucket("unavailable")
  const unstable = bucket("unstable")
  const removed = bucket("removed")
  log(`ok=${healthy.length} rate-limited=${rateLimited.length} unavailable=${unavailable.length} unstable=${unstable.length} removed=${removed.length}`)

  // Churn-free policy: keep the previous order, drop only models that are truly
  // gone upstream, and append brand-new free models. Status is diagnostic — a
  // temporarily down backend must not reshuffle (and re-commit) the list every run.
  const nextList = ordered.filter((id) => results.get(id).status !== "removed")
  if (!nextList.length) throw new Error("everything dead — refusing to wipe the model list")

  const snapshot = {
    updatedAt: new Date().toISOString(),
    ua,
    nextList,
    healthy,
    rateLimited,
    unavailable,
    unstable,
    removed,
    details: Object.fromEntries([...results].map(([id, r]) => [id, r])),
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n")
  fs.writeFileSync(MAIN, patchDefaults(src, nextList))
  const changed = nextList.join(",") !== previous.join(",") || !/defaultModel: ENV\.DEFAULT_MODEL \?\? ""/.test(src)
  log(`changed: ${changed} (shipping ${nextList.length} models)`)

  if (!changed) {
    log("model list unchanged — nothing to commit")
    return
  }
  execFileSync("git", ["add", "zen-proxy.mjs"], { cwd: ROOT })
  const diff = execFileSync("git", ["diff", "--cached", "--stat"], { cwd: ROOT, encoding: "utf8" }).trim()
  if (!diff) {
    log("no diff after patch — nothing to commit")
    return
  }
  log("committing:\n" + diff)
  execFileSync("git", ["config", "user.email", "model-sync[bot]@users.noreply.github.com"], { cwd: ROOT })
  execFileSync("git", ["config", "user.name", "zen-proxy model-sync bot"], { cwd: ROOT })
  execFileSync("git", ["commit", "-m", "model-sync: refresh opencode free model list"], { cwd: ROOT })
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (token && repo) {
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`
    execFileSync("git", ["push", remote, "HEAD:refs/heads/main"], { cwd: ROOT })
    log("pushed to main")
  } else {
    log("no GITHUB_TOKEN/GITHUB_REPOSITORY — commit made locally, not pushed")
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
