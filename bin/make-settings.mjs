#!/usr/bin/env node
// Generate a Claude Code settings file that points at a local zen-proxy and
// fills the /model picker with every free Zen model the proxy currently serves.
//
//   node make-settings.mjs <port> <outPath>
//
// Claude Code keeps its own model catalog, so `zen-claude` would otherwise start
// with a model the proxy cannot serve and no way to see the ones it can. Each
// free model becomes a picker row; `behavesAs` names a model this Claude Code
// version already knows, so it treats the row with sensible defaults. The model
// id actually sent is still ours — the row never lies about it.
import fs from "node:fs"

const port = Number(process.argv[2] || 8787)
const outPath = process.argv[3]
if (!outPath) {
  console.error("usage: make-settings.mjs <port> <outPath>")
  process.exit(2)
}

const BEHAVES_AS = "claude-sonnet-4-5"

// Prefer what the proxy is actually serving right now; fall back to the shipped
// catalog so a slow or unreachable /models does not leave the picker empty.
async function loadModels() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { accept: "application/json", authorization: "Bearer public" },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const ids = (await res.json()).data?.map((m) => m?.id).filter(Boolean)
      if (ids?.length) return ids
    }
  } catch {}
  try {
    const here = new URL("../models.json", import.meta.url)
    const models = JSON.parse(fs.readFileSync(here, "utf8"))?.models
    if (Array.isArray(models) && models.length) return models
  } catch {}
  return []
}

const models = await loadModels()
const firstModel = models[0] ?? "space-bunny-free"
const settings = {
  env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "public",
    ANTHROPIC_MODEL: firstModel,
    // Claude Code sends its built-in haiku id for background work (titles,
    // quotas, summaries). Left unset, those requests name a model this proxy
    // cannot serve and it has to silently answer with its default — pinning the
    // id keeps every request naming a model the proxy actually serves.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: firstModel,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  },
  modelPicker: {
    // Only the Default row and the free Zen models — the built-in lineup would
    // all fail against this proxy.
    replaceBuiltInOptions: true,
    options: models.map((id) => ({
      model: id,
      label: id,
      description: "free Zen model via zen-proxy",
      behavesAs: BEHAVES_AS,
    })),
  },
}

fs.writeFileSync(outPath, JSON.stringify(settings, null, 2))
console.log(models.length)