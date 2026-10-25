<p align="center">
  <img src="assets/logo.png" width="96" alt="zen-proxy" />
</p>

<p align="center"><b>zen-proxy</b></p>
<p align="center">Use OpenCode Zen's free models from any AI coding agent.</p>
<p align="center"><sub>No account. No API key. OpenAI&nbsp;and&nbsp;Anthropic&nbsp;compatible. Runs on your machine.</sub></p>

<p align="center">
  <a href="https://discord.gg/Dw5Ctrtuw">
    <img src="https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=flat-square&labelColor=1a1612&logo=discord&logoColor=white" alt="Join the Discord server">
  </a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ccf73a?style=flat-square&labelColor=1a1612" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/bun-1.2%2B%20(or%20node%2018%2B%20BYOK)-8b8b8b?style=flat-square&labelColor=1a1612" alt="Bun 1.2+">
  <img src="https://img.shields.io/badge/dependencies-0-8b8b8b?style=flat-square&labelColor=1a1612" alt="Zero dependencies">
  <a href="#any-openai-compatible-agent">
    <img src="https://img.shields.io/badge/OpenAI_compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=openai" alt="OpenAI compatible">
  </a>
  <a href="#claude-code">
    <img src="https://img.shields.io/badge/Claude_Code-compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=anthropic" alt="Claude Code compatible">
  </a>
</p>

<p align="center">
  <img src="assets/brag-demo.gif" alt="zen-proxy in 25 seconds: install → run the proxy → zen-claude → point any OpenAI-compatible agent at it" width="860" />
  <br />
  <sub>
    <a href="assets/brag-demo.mp4">▶ full video with sound</a>
  </sub>
</p>

---

## Start here

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

<sub>That is the entire installation — no account, no API key, no `npm install`. Now pick your agent below.</sub>

---

### Claude Code

```bash
zen-claude
```

<sub>Identical on Linux, macOS and Windows.</sub>

It starts the proxy if it is not already running, loads every live free Zen model into Claude Code's `/model` picker, runs Claude Code, and stops the proxy again when you exit. Your existing Claude Code config is never touched.

---

### Any OpenAI-compatible agent

<sub>Cline, Roo Code, Continue, Aider, mimo, opencode forks — anything with a `baseURL` setting.</sub>

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `public` |
| Model | anything from `GET /v1/models` |

Confirm the proxy is up:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"upstream":"https://opencode.ai/inference/openai/v1"}
```

<details>
<summary>Run the proxy yourself</summary>

```bash
zen-proxy     # http://127.0.0.1:8787 — dashboard at /
```

It stays up until you stop it, so you point your agent at it once and keep using it. `zen-claude` does this for you and cleans up after.
</details>

---

## What you get

| | |
|---|---|
| `POST /v1/chat/completions` | OpenAI, streaming and not |
| `POST /v1/responses` | OpenAI Responses API, translated both ways — a body that speaks Responses gets Responses back, a chat body keeps its chat reply |
| `POST /v1/messages` | Anthropic Messages API — **this is the Claude Code one** |
| `POST /v1/messages/count_tokens` | Anthropic token estimate |
| `GET /v1/models` | What's live right now |
| Automatic fallback | Retries the next free model on `429` / `5xx` / unavailable |
| Model aliases | Call it `gpt-4o`, get a free model back |
| Auth | Anonymous `Bearer public`, or bring your own Zen key |
| Dashboard | `http://127.0.0.1:8787/` |

The free-model catalog in [`models.json`](models.json) is refreshed from OpenCode's public catalog by a GitHub Action every 6 hours.

---

## Why a proxy is needed

OpenCode's free models are served only to the OpenCode CLI itself. Everyone else gets one of:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
429 FreeUsageLimitError: Free usage limit reached …   ← what you get instead now
```

Since OpenCode 2, the second one is what a non-CLI client sees — with a `retry-after` window and zero personal usage. It is not your quota: it is the gate's verdict on the request.

zen-proxy sits in front of that gateway and makes your agent's traffic indistinguishable from the CLI's, on three layers — all measured from a byte-capture of a real OpenCode 2.1.4 request.

<details>
<summary>What it actually changes</summary>

| Gateway requirement | What zen-proxy does |
|---|---|
| **Run under Bun.** The gate fingerprints the TLS/HTTP stack — the exact bytes that stream `200` under Bun's fetch get `429 FreeUsageLimitError` from Node's (same second, same session) | `zen-proxy` / `zen-claude` prefer bun; node works with a BYOK key, and the proxy warns at boot under node |
| The v2 endpoint `https://opencode.ai/inference/openai/v1` | Uses it, and migrates old configs pointing at `/inference/v1` or `/zen/v1` |
| The v2 wire identity: `x-opencode-client`, `x-opencode-project` (sha1, per-install), `b3`/`traceparent`, affinity pair | Sends all of it, in the CLI's own formats |
| The **OpenCode harness system text** — requests whose system prompt is not the CLI's harness preamble are refused however agent-shaped the rest is (a generic prompt, the opening line, or a ~1.8 KB cut of it are all refused) | Prepends the captured harness preamble (`agent-preamble.txt`) ahead of your agent's own instructions, on every route, idempotently |
| OpenCode's own tool manifest (the gate refuses a bare `read` stub now) | Attaches the captured v2 manifest (`agent-tools.json`: read/edit/glob/grep/shell/write are the ones whose name your agent maps to) ahead of your tools, renames the mapped calls back to your agent's names, and drops the rest |
| Streams with `stream_options` and a real `max_completion_tokens` | Mirrors the CLI's shape on health probes, and forwards yours untouched |

**Run it with bun** (`bun zen-proxy.mjs`, or through `zen-proxy`/`zen-claude`, which pick bun when present): that is the one requirement node cannot substitute away — the gateway 429s node's stack even though headers, sessions and bodies are byte-identical.

For replies, one rule: a reply may only carry calls your agent can actually run. An agent turn with its own tools keeps its calls (mapped manifest calls come back renamed) and loses everything else — manifest names it has no counterpart for, and tool names the provider invents; a `tool_choice`-pinned turn keeps only the pinned call; a reply with no tools attached at all (title generators, plain pings) is stripped of every `tool_call`. Health probes send the same harness preamble + manifest + a real ask (serially, spaced out — the gate blanket-403s a rapid model-hop burst from one identity), so a model in the dashboard's `ok` row genuinely answered; the old `rate-limited` parking behaviour is gone (a `FreeUsageLimitError` bucket no longer removes or dead-labels a model).
</details>

<details>
<summary>Gotchas worth knowing before you file a bug</summary>

- **This rides an anonymous free tier.** Per-IP quotas, shared pool, sometimes saturated. Bring a key if you need reliability.
- **A bare `curl` gets 429/403.** The gateway only answers genuine *agent* traffic (harness preamble, manifest, plausible wire) — every agent above does this; a hand-rolled chat client won't.
- **Health probes are agent-shaped.** Sync sends each model the same thing a real v2 client sends — harness preamble, OpenCode's manifest, `stream_options`, a real token budget — serially, with a beat between hops (a rapid burst from one identity is blanket-refused), so `ok` means the model actually streamed. A `FreeUsageLimitError` probe never marks a model dead or drops it from your list.
- **Fallbacks announce themselves** via `zen_served_by` and the `x-zen-served-by` / `x-zen-fallback` headers.
- **`agent-tools.json` and `agent-preamble.txt` are captures of OpenCode v2.1.4's request.** If OpenCode changes its harness text or tool schemas, re-capture both from any real request (the gate fingerprints the preamble; the first 139 characters are not enough). The preamble file is plain text; the tools file accepts a bare array or `{"tools":[...]}`.
</details>

---

## Configuration

`zen-proxy.json`, created on first run, hot-reloaded, and editable from the dashboard. Environment variables override at startup.

<details>
<summary>Keys</summary>

| Key | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | Bind address (restart required) |
| `upstream` | `https://opencode.ai/inference/openai/v1` | Zen gateway base (v2; discovery stays on `/inference/v1`) |
| `ua` / `autoUA` | `opencode/latest/2.1.4/cli` / `true` | The v2 CLI's UA format; auto-tracking skips v2-style UAs (npm only carries 1.x) |
| `clientName` / `projectHash` / `tracing` | `cli` / auto / `true` | The v2 identity headers: `x-opencode-client`, per-install `x-opencode-project` (sha1 of `directory:<cwd>`), `b3`/`traceparent` |
| `injectSession` | `true` | Mint and send the session header pair + affinity pair |
| `agentPreamble` | `""` (= auto) | `""`/`auto` → shipped harness preamble; `off`/`none` → none; other text → used verbatim |
| `agentTools` | `true` | Attach OpenCode's v2 manifest to every request, ahead of your agent's tools; replies keep only the calls your agent can run — mapped ones renamed back, the rest dropped |
| `defaultModel` | `""` | Empty = auto-pick the first working free model |
| `fallbackModels` | *(from [`models.json`](models.json))* | Tried in order on failure. Omit to follow the catalog; save once to pin your own list |
| `modelAliases` | `{}` | e.g. `{"gpt-4o": "space-bunny-free"}` |
| `responsesModels` | `["gpt-5*","gpt-6*","grok-*","muse-spark-*"]` | Models served on `/v1/responses`; patterns may end in `*` |
| `defaultZenKey` | `""` | Your own Zen key instead of anonymous `public` |
| `proxyKey` | `""` | Require this from clients; also locks the dashboard and `/api/*` |
| `rateLimitMax` / `rateLimitWindowMs` | `0` (off) / `60000` | Per-client rate limiting |
| `timeoutMs` / `cacheMs` | `120000` / `30000` | Upstream timeout, `/v1/models` cache TTL |
| `autoSync` / `autoSyncIntervalMs` | `true` / `3600000` | Runtime discovery of newly-offered free models |
| `trustForwarded` | `false` | Honour `x-forwarded-for` behind a reverse proxy |

`HOST` `PORT` `ZEN_URL` `ZEN_UA` `ZEN_CLIENT` `ZEN_PROJECT_HASH` `ZEN_TRACING=0` `INJECT_SESSION=0` `AUTO_UA=0` `UA_REFRESH_MS` `AGENT_TOOLS=0` `AGENT_PREAMBLE=off` `ZEN_PROXY_AGENT_TOOLS` `ZEN_PROXY_AGENT_PREAMBLE` `PROBE_AUTH` `DEFAULT_MODEL` `FALLBACK_MODELS` `MODEL_ALIASES` `RESPONSES_MODELS` `PROXY_KEY` `ZEN_KEY` `TRUST_FORWARDED=1` `TIMEOUT_MS` `CACHE_MS` `RATE_LIMIT_MAX` `RATE_LIMIT_WINDOW_MS` `AUTO_SYNC=0` `AUTO_SYNC_MS` `ZEN_PROXY_CONFIG`

Anonymous `public` access shares a per-IP quota that is sometimes saturated. Set `defaultZenKey`, or send `x-zen-key` per request, for steadier service.
</details>

<details>
<summary>Dashboard</summary>

`http://127.0.0.1:8787/` — upstream health and uptime, a live request feed, one-click model testing, instant config editing, and a log tail.

![zen-proxy dashboard](assets/dashboard.png)
</details>

<details>
<summary>HTTP API</summary>

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
</details>

<details>
<summary>Running as a service (Linux)</summary>

`install.sh` offers to install a systemd unit, or:

```bash
sudo systemctl enable --now zen-proxy
```
</details>

<details>
<summary>Doing it by hand instead of using <code>zen-claude</code></summary>

Both launchers pass `--settings` rather than exported env vars — **Claude Code reads env from `~/.claude/settings.json`, and that wins over your shell**, so an `export` is silently ignored if that file already sets `ANTHROPIC_BASE_URL`. Your existing config is left alone; a plain `claude` still uses it.

```bash
claude --settings ./claude/zen-proxy.settings.json
```

The generated picker comes from `bin/make-settings.mjs`, which reads the live model list from the proxy (falling back to `models.json`). Each row sets `behavesAs` so Claude Code handles an unfamiliar model id sensibly while still sending that exact id upstream.

If `zen-claude` says `command not found`, check `ls -l ~/.local/bin/zen-claude` first — if the symlink is missing, re-run the installer. Only if it exists is it a stale `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"                          # this terminal
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc      # permanent
```
</details>

---

<p align="center">
  <sub>💬 <a href="https://discord.gg/Dw5Ctrtuw">Join the Discord</a> — install help, troubleshooting, and which free model is fast right now.</sub>
  <br />
  <sub>The demo video up top was built using the brag skill.</sub>
</p>

<p align="center">
  <sub>Machine-readable: <a href="llms.txt">llms.txt</a> &nbsp;·&nbsp; <a href="llms-full.txt">llms-full.txt</a></sub>
</p>

<p align="center">
  <a href="https://github.com/12errh/zen-proxy/issues">
    <img src="https://img.shields.io/github/issues/12errh/zen-proxy?style=flat-square&labelColor=1a1612&color=8b8b8b" alt="Open issues">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-8b8b8b?style=flat-square&labelColor=1a1612" alt="MIT License">
  </a>
</p>