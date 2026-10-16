<p align="center">
  <img src="assets/logo.png" width="110" alt="zen-proxy" />
</p>

<p align="center"><b>zen-proxy</b></p>
<p align="center">Use OpenCode Zen's free models from any AI coding agent — <b>OpenAI&nbsp;and&nbsp;Anthropic&nbsp;compatible</b> — no account, no API key.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ccf73a?style=flat-square&labelColor=1a1612" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-8b8b8b?style=flat-square&labelColor=1a1612" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencies-0-8b8b8b?style=flat-square&labelColor=1a1612" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/endpoint-OpenAI%20%2B%20Anthropic-8b8b8b?style=flat-square&labelColor=1a1612" alt="OpenAI and Anthropic compatible">
</p>

---

## What it is

OpenCode publishes free AI models (`space-bunny-free`, `mimo-v2.6-flash-free`, `big-pickle`, …) — but their gateway only answers requests that come from the OpenCode CLI itself. Any other agent gets:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

**zen-proxy** is a single-file local server that sits in front of that gateway and speaks for your agent. Point Cline, Roo, Continue, Aider, Claude Code, or anything else that accepts a `baseURL` at it, and you get those free models — still anonymously, still with no account and no API key.

It speaks **two wire formats**, so you're not locked into one SDK:

- **OpenAI** — `/v1/chat/completions`, `/v1/responses`, `/v1/models`. Cline, Roo Code, Continue, Aider, mimo, opencode forks, anything with a `baseURL`.
- **Anthropic** — `/v1/messages` and `/v1/messages/count_tokens`, including the full streaming envelope, tools, images and thinking blocks. **Claude Code works as-is**, including file and shell tools.

Everything runs on your machine. Nothing is sent anywhere but OpenCode's own API.

---

## How it works

The gateway accepts a request only when it carries the identity and shape of a real OpenCode session. Three things matter, all measured by replaying genuine requests upstream:

| Requirement | What zen-proxy does |
|---|---|
| A valid session identity — `x-opencode-session` **and** `x-opencode-session-id`, sharing one value | Mints a stable per-client ID and sends both headers |
| The ID must look real — its first 12 hex characters encode a creation time | Generates IDs in OpenCode's own format, not random hex |
| Served from `https://opencode.ai/inference/v1` | Uses that base, and migrates older configs that still point at the retired `/zen/v1` path |

One more rule applies specifically to `/v1/messages` (the Anthropic endpoint): the gateway requires OpenCode's own tool manifest to be present. Claude Code's system prompt is passed through **completely untouched** — but zen-proxy attaches a few of OpenCode's built-in tools alongside Claude Code's, and renames any resulting tool calls back to Claude Code's names and argument spelling. Details in [Claude Code](#claude-code).

> **Note on plain chat clients:** the gateway only answers genuine *agent* traffic — a request must stream, carry a system message, and include tool definitions. All the coding agents above do this, so they work as-is. A bare `curl` or a chat-only client that sends none of those gets `403 FreeTierError`; that is the gateway's rule, not a proxy fault.

---

## What it supports

| Capability | Status |
|---|---|
| `POST /v1/chat/completions` — streaming and non-streaming | ✅ |
| `POST /v1/responses` (Responses API) | ✅ translated both ways |
| `POST /v1/messages` — Anthropic Messages API, for Claude Code | ✅ full streaming envelope, tools, images, thinking |
| `POST /v1/messages/count_tokens` | ✅ |
| `GET /v1/models` | ✅ |
| Automatic fallback across free models on `429`/`5xx`/unavailable | ✅ honors `retry-after` |
| Model aliases — call it `gpt-4o`, get a free model back | ✅ |
| Anonymous `Bearer public` **or** your own Zen key (BYOK) | ✅ |
| Free-model catalog kept current by a GitHub Action | ✅ [`models.json`](models.json), every 6 h |
| Management dashboard | ✅ `http://127.0.0.1:8787/` |
| Per-IP rate limiting, `proxyKey` lock | ✅ opt-in |

---

## Install

Requires **Node.js 18 or newer**. No `npm install` — there are no dependencies.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

**Or from source**

```bash
git clone https://github.com/12errh/zen-proxy.git
cd zen-proxy
node zen-proxy.mjs
```

The proxy listens on `http://127.0.0.1:8787` and prints its URLs on startup.

---

## Setup

### Any OpenAI-compatible agent (Cline, Roo, Continue, Aider, mimo, opencode)

Set the base URL to `http://127.0.0.1:8787/v1` and the API key to `public`. That's the whole configuration.

**opencode** — in `opencode.json`:

```jsonc
{
  "provider": {
    "zen": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": { "space-bunny-free": { "name": "Space Bunny Free" } }
    }
  },
  "model": "zen/space-bunny-free"
}
```

**Cline / Roo Code / Continue / Aider / mimo** — any provider form that takes a `baseURL` + `apiKey`:

```jsonc
{
  "provider": {
    "zen": {
      "baseURL": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "models": { "space-bunny-free": {} }
    }
  }
}
```

Which models are available right now:

```bash
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer public"
```

### Claude Code

Claude Code speaks the Anthropic Messages API, which zen-proxy implements directly. The installer drops a `zen-claude` command on your `PATH`:

**Linux / macOS**

```bash
zen-proxy &      # terminal 1
zen-claude       # terminal 2 — done
```

**Windows (PowerShell)** — same two commands:

```powershell
zen-proxy        # terminal 1
zen-claude       # terminal 2
```

The installer puts both on your `PATH` (on Windows it also adds `~/.local/bin` to your user `PATH` for you). `zen-claude "fix the failing test"` works too.

That's the whole setup. `zen-claude` runs Claude Code against `http://127.0.0.1:8787` on a free model.

Both launchers work by passing `--settings`, not by exporting environment variables — **Claude Code reads env from `~/.claude/settings.json` and that wins over your shell**, so if you already have `ANTHROPIC_BASE_URL` set there, `export` would be silently ignored. The launchers leave your existing Claude Code configuration untouched, and a plain `claude` still uses it.

<details>
<summary>Prefer to wire it up yourself?</summary>

```bash
claude --settings ./claude/zen-proxy.settings.json
```

Or copy the two variables into `~/.claude/settings.json`:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "public",
    "ANTHROPIC_MODEL": "space-bunny-free"
  }
}
```

Switch back to the original Claude Code with a plain `claude`.

</details>

Two things worth knowing:

- **Claude Code warns the model is outside its catalog** and assumes a 200k context window. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the free model's real limit to avoid premature auto-compact.
- **Why OpenCode's tools get attached.** With only Claude Code's own tools the gateway returns `403` — measured, not assumed. zen-proxy therefore adds a handful of OpenCode's built-in tools alongside Claude Code's, **only those Claude Code has a counterpart for**, and translates calls back:

  | Attached as | You get back | Arguments |
  |---|---|---|
  | `read` | `Read` | `filePath` → `file_path` |
  | `edit` | `Edit` | `filePath`, `oldString`, `newString` → `file_path`, `old_string`, `new_string` |
  | `write` | `Write` | `filePath` → `file_path` |
  | `bash` | `Bash` | `workdir` dropped (no counterpart) |
  | `grep`, `glob`, `list` | `Grep`, `Glob`, `LS` | passed through |

  A tool Claude Code doesn't offer is never attached, so the model can't request something that can't run. Set `agentTools: false` to turn this off.

### Verify it works

Check the server is up:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"upstream":"https://opencode.ai/inference/v1"}
```

Then send a request shaped the way the gateway expects — **streaming**, with a system message and at least one tool:

```bash
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{
    "model": "space-bunny-free",
    "stream": true,
    "max_tokens": 32,
    "system": "You are a coding assistant. Answer concisely.",
    "messages": [{"role": "user", "content": "say hi"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read a file from disk.",
        "parameters": {"type": "object", "properties": {"filePath": {"type": "string"}}}
      }
    }]
  }'
```

You should see `data:` lines streaming back. See [Things to know](#things-to-know) for why the shape matters.

---

## Configuration

Config lives in **`zen-proxy.json`**, created on first run, hot-reloaded when edited, and writable from the dashboard. Environment variables can override anything at startup.

| Key | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | Bind address (restart required) |
| `upstream` | `https://opencode.ai/inference/v1` | Zen gateway base |
| `ua` / `autoUA` | `opencode/1.18.30` / `true` | User-Agent sent upstream; auto-tracks new OpenCode releases |
| `injectSession` | `true` | Mint and send the session header pair |
| `agentTools` | `true` | Attach OpenCode's tools to `/v1/messages` (see [Claude Code](#claude-code)) |
| `defaultModel` | `""` | Empty = auto-pick the first working free model |
| `fallbackModels` | *(from [`models.json`](models.json))* | Tried in order on `429`/`5xx`/unavailable. Omit it to follow the catalog; save it once to pin your own list |
| `modelAliases` | `{}` | e.g. `{"gpt-4o": "space-bunny-free"}`; the reply's model name is rewritten back |
| `responsesModels` | `["gpt-5*","gpt-6*","grok-*","muse-spark-*"]` | Models served on `/v1/responses`; patterns may end in `*` |
| `defaultZenKey` | `""` | Your own Zen key instead of anonymous `public` |
| `proxyKey` | `""` | If set, clients must send it; also locks the dashboard and `/api/*` |
| `rateLimitMax` / `rateLimitWindowMs` | `0` (off) / `60000` | Per-client rate limiting for inference routes |
| `timeoutMs` / `cacheMs` | `120000` / `30000` | Upstream timeout, `/v1/models` cache TTL |
| `autoSync` / `autoSyncIntervalMs` | `true` / `3600000` | Runtime discovery of newly-offered free models |
| `trustForwarded` | `false` | Honour `x-forwarded-for` when behind a reverse proxy |

**Environment variables:** `HOST`, `PORT`, `ZEN_URL`, `ZEN_UA`, `INJECT_SESSION=0`, `AUTO_UA=0`, `UA_REFRESH_MS`, `AGENT_TOOLS=0`, `PROBE_AUTH`, `DEFAULT_MODEL`, `FALLBACK_MODELS` (JSON), `MODEL_ALIASES` (JSON), `RESPONSES_MODELS` (JSON), `PROXY_KEY`, `ZEN_KEY`, `TRUST_FORWARDED=1`, `TIMEOUT_MS`, `CACHE_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `AUTO_SYNC=0`, `AUTO_SYNC_MS`, `ZEN_PROXY_CONFIG`.

### Bring your own key

Anonymous `public` access shares a per-IP quota that is sometimes saturated. For steadier service set `defaultZenKey` to your own Zen key, or send it per request as `x-zen-key`.

---

## Dashboard

`http://127.0.0.1:8787/`

- **Overview** — upstream health, uptime, request counters, live request feed with status and latency
- **Models** — add or remove models, pick the default, test any model with one click
- **Settings** — edit and save config instantly; **Restore defaults** returns the model list to following [`models.json`](models.json)
- **Logs** — live log tail

![zen-proxy dashboard](assets/dashboard.png)

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/messages/count_tokens` | Anthropic token estimate |
| `GET` | `/v1/models` | Available models |
| `GET` | `/health` | Health check (always open) |
| `GET` | `/` | Dashboard |
| `GET`/`PUT` | `/api/config` | Read / update configuration |
| `GET` | `/api/status` | Stats and upstream health |
| `POST` | `/api/test` | Test one model — `{"model":"..."}` |
| `GET` | `/api/logs` | Log tail |
| `POST` | `/api/sync` | Re-run model discovery |
| `POST` | `/api/reset` | Reset request statistics |

Setting `proxyKey` protects the dashboard and every `/api/*` route.

---

## Running as a service (Linux)

`install.sh` offers to install a systemd unit; or manually:

```bash
sudo systemctl enable --now zen-proxy
```

---

## Things to know

- **This rides an anonymous free tier.** Expect per-IP quotas and a shared pool that gets saturated. Don't run heavy workloads on it — bring a key if you need reliability.
- **The gateway expects agent-shaped traffic.** Streaming, a system message, and tool definitions are all required; without them you get `403 FreeTierError`. Every coding agent listed above sends them. If you build your own client, send them too.
- **A model showing "agent-only" is not broken.** The gateway refuses the built-in health probe because it isn't genuine agent traffic, so the proxy can't confirm those models up front. It learns real health from your actual requests instead — a model that serves you shows `ok (live traffic)`. Models are never removed on a temporary block.
- **Which models exist comes from OpenCode's public catalog**, not from probing: a retired model and a healthy one are refused identically, so probing can't tell them apart. A GitHub Action refreshes [`models.json`](models.json) every 6 hours.
- **When the proxy falls back**, the response carries `zen_served_by` plus `x-zen-served-by` and `x-zen-fallback` headers so you can see which model actually answered.
- **`agent-tools.json` is a capture of OpenCode's tools.** If OpenCode changes its tool schemas, the `/v1/messages` bridge may stop satisfying the gateway and Claude Code will start returning `403`. Regenerate it by capturing any OpenCode request.

---

<p align="center">MIT licensed. Runs entirely on your machine.</p>