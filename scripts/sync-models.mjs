#!/usr/bin/env node
// GitHub Actions model sync.
//
// Reads opencode's public Zen model catalog and keeps models.json current:
// brand-new free models get appended, models that upstream no longer offers get
// removed. That is the whole job.
//
// Why there is no health probe here: the free tier only answers requests that
// look like genuine agent traffic — a valid session pair, `stream: true`, and a
// system prompt carrying opencode's own wording. A synthetic probe is rejected
// with 403 FreeTierError even for models that are working perfectly, and a
// retired model is rejected exactly the same way, so a probe can tell you
// nothing about which models are alive. The `/models` catalog is the only
// authoritative source for that, and it needs no auth.
//
// Model health is not this file's business. The proxy learns it from real client
// traffic at runtime instead, which is the only signal that is actually
// trustworthy.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CATALOG = path.join(ROOT, "models.json")
// Same override the proxy honours, so the bot can be pointed at a stub in tests.
const UPSTREAM = (process.env.ZEN_URL ?? "https://opencode.ai/inference/v1").replace(/\/+$/, "")
const UA = process.env.ZEN_UA ?? "opencode/1.18.35"
// Free models that do not carry the `-free` suffix. `big-pickle` is a stealth
// model that upstream prices at zero, so a plain suffix filter would drop it.
const KNOWN_FREE = new Set(["big-pickle"])
// Models that are NOT reachable through /chat/completions or /responses.
// jev-* is served on /v1/systemone (structured classification), so listing it
// here could only ever produce a failed request.
const NOT_CHAT_SERVABLE = [/^jev-/]

// Keeps whitespace, quotes, backslashes and shell metacharacters out of the
// catalog. `/` and `.` are allowed — provider-qualified ids use them
// (`nvidia/nemotron-3-free`), and ids only ever travel in JSON bodies.
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function readCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG, "utf8"))
    const models = Array.isArray(parsed?.models) ? parsed.models : []
    return { models: models.filter((id) => typeof id === "string" && VALID_MODEL_ID.test(id)), raw: parsed }
  } catch {
    return { models: [], raw: null }
  }
}

async function fetchUpstreamModels() {
  const res = await fetch(`${UPSTREAM}/models`, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${UPSTREAM}/models -> ${res.status}`)
  const parsed = await res.json()
  return (parsed.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string")
}

function isFree(id) {
  return VALID_MODEL_ID.test(id) && !NOT_CHAT_SERVABLE.some((re) => re.test(id)) && (id.endsWith("-free") || KNOWN_FREE.has(id))
}

async function main() {
  const upstreamIds = await fetchUpstreamModels()
  const catalog = [...new Set(upstreamIds.filter(isFree))].sort()
  if (!catalog.length) throw new Error("upstream returned no free models — refusing to touch models.json")
  log(`upstream: ${upstreamIds.length} models, ${catalog.length} free`)

  const previous = readCatalog().models
  // Preserve the existing order so the default model does not jump around, then
  // append whatever is new. Anything no longer offered upstream is dropped.
  const kept = previous.filter((id) => catalog.includes(id))
  const added = catalog.filter((id) => !kept.includes(id))
  const removed = previous.filter((id) => !catalog.includes(id))
  const ordered = [...kept, ...added]
  log(`kept=${kept.length} added=[${added.join(", ") || "-"}] removed=[${removed.join(", ") || "-"}]`)

  if (!ordered.length) throw new Error("nothing left to ship — refusing to empty models.json")
  if (ordered.join(",") === previous.join(",") && previous.length) {
    log("catalog unchanged — nothing to commit")
    return
  }

  fs.writeFileSync(CATALOG, JSON.stringify({ updatedAt: new Date().toISOString(), upstream: UPSTREAM, models: ordered }, null, 2) + "\n")

  execFileSync("git", ["add", "models.json"], { cwd: ROOT })
  const staged = execFileSync("git", ["diff", "--cached", "--stat", "--", "models.json"], { cwd: ROOT, encoding: "utf8" }).trim()
  if (!staged) {
    log("no diff after write — nothing to commit")
    return
  }
  log(`committing:\n${staged}`)

  const parts = ["model-sync: refresh opencode free model list"]
  if (added.length) parts.push("", `added: ${added.join(", ")}`)
  if (removed.length) parts.push(`removed: ${removed.join(", ")}`)
  execFileSync("git", ["config", "user.email", "model-sync[bot]@users.noreply.github.com"], { cwd: ROOT })
  execFileSync("git", ["config", "user.name", "zen-proxy model-sync bot"], { cwd: ROOT })
  execFileSync("git", ["commit", "-m", parts.join("\n")], { cwd: ROOT })

  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (token && repo) {
    execFileSync("git", ["push", `https://x-access-token:${token}@github.com/${repo}.git`, "HEAD:refs/heads/main"], { cwd: ROOT })
    log("pushed to main")
  } else {
    log("no GITHUB_TOKEN/GITHUB_REPOSITORY — commit made locally, not pushed")
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})