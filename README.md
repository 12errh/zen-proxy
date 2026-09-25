<p align="center">
  <img src="assets/logo.png" width="128" alt="zen-proxy logo" style="border:3px solid #1a1612;border-radius:22px;box-shadow:8px 8px 0 #ff5c39;">
</p>

<p align="center" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:800;font-size:26px;letter-spacing:.12em;color:#1a1612;margin-top:14px;">ZEN·PROXY</p>
<p align="center" style="font-family:'Iowan Old Style',Georgia,serif;font-style:italic;font-size:15px;color:#7d7461;">a local OpenAI-compatible proxy that unlocks opencode's anonymous free tier — for any agent.</p>

<div align="center" style="background-color:#ccf73a;border:2px solid #1a1612;border-radius:999px;padding:9px 22px;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:12px;letter-spacing:.15em;color:#1a1612;margin:18px 0;text-transform:uppercase;">
anonymous free tier &nbsp;◦&nbsp; no accounts &nbsp;◦&nbsp; no keys &nbsp;◦&nbsp; any openai-compatible agent &nbsp;◦&nbsp; 100% local
</div>

> **Zen Proxy** is a zero-dependency, locally-run OpenAI-compatible proxy that unlocks opencode's Zen free tier **for any coding agent — not just opencode**.
>
> opencode gives you free models like `mimo-v2.5-free`, `big-pickle`, and `nemotron` — but only to requests that look like they come from opencode itself: the right `User-Agent` **and** an `x-opencode-session` header. Most agents force their own identity and get shut out with `400 MissingSessionID` ("OpenCode's free tier can only be used in OpenCode") or `429 FreeUsageLimitError`. Zen Proxy quietly speaks for them: it injects the correct `User-Agent`, mints stable per-client session IDs, forwards your real IP, and re-exposes everything as a standard `/v1/chat/completions` + `/v1/models` API.
>
> The result: whatever tool you love — Cline, Roo Code, Continue, Aider, mimo, or a plain `curl` — can now ride opencode's free models with **zero accounts, zero API keys**, and zero config beyond a `baseURL`.

**What it enables:**

- **Free OpenAI-compatible models outside opencode** — bring your own agent, keep the free tier
- **Anonymous access with no accounts or keys** (`Bearer public`), or bring your own Zen key (BYOK) for your own quota
- **Smart model fallback** — when one free model is saturated, it rolls to the next
- **Model aliases** — call them `gpt-4o` or `claude-3-5`, get routed to free models
- **Self-updating** — tracks new opencode releases (auto User-Agent) and a GitHub Action keeps the shipped free-model list current as models come and go
- **Per-IP fairness** — real client IPs are forwarded (local clients fall back to your machine's real IP, same quota bucket as opencode direct)
- **A retro-zine management dashboard** — stats, one-click model tests, live config, and logs at `http://127.0.0.1:8787/`
- **One-file install** on Linux, macOS, and Windows with a single `curl`

---

## why it exists

opencode's free `-free` models (`mimo-v2.5-free`, `big-pickle`, `nemotron`, …) are only served to requests that mimic the real client. Since opencode started requiring an `x-opencode-session` header, anything without it gets `400 MissingSessionID: "OpenCode's free tier can only be used in OpenCode"` — even with a valid API key. Most coding agents — like the *mimo* CLI fork — force their own identity and get slammed with that error (or `429 FreeUsageLimitError`).

**zen-proxy** injects the correct `User-Agent` and a stable synthetic `x-opencode-session` per client, then re-exposes everything as a plain OpenAI API. No accounts, no API keys, no source patches.

> works with: **mimo cli**, **Cline**, **Roo Code**, **Continue**, **Aider**, opencode forks — anything that lets you set a `baseURL` + `apiKey`.

<div style="background-color:#1a1612;border-radius:14px;padding:20px;color:#efe8d9;margin:16px 0;">
  <p style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#ccf73a;">▸ feature list</p>
  <ul style="margin:10px 0 0;padding-left:20px;line-height:1.9;font-size:14px;">
    <li><b>OpenAI-compatible API</b> — <code>/v1/chat/completions</code> (stream + non-stream), <code>/v1/models</code>, <code>/v1/responses</code></li>
    <li><b>UA unlock</b> — injects <code>User-Agent: opencode/1.18.30</code> plus a stable per-client <code>x-opencode-session</code> upstream, the two things that open the free tier</li>
    <li><b>BYOK</b> — ride anonymous <code>public</code> or bring your own Zen key (stable + no shared-pool throttling)</li>
    <li><b>Smart fallback</b> — tries models in order on <code>429</code>/<code>5xx</code>, honors <code>retry-after</code></li>
    <li><b>Model aliases</b> — e.g. <code>gpt-4o → mimo-v2.5-free</code>, replies rewritten back</li>
    <li><b>Per-IP fairness</b> — real client IPs forwarded; local clients fall back to your real IP (same quota bucket as opencode direct)</li>
    <li><b>Management dashboard</b> — glass… no, sticker-style UI at <code>/</code> for stats, model tests, config &amp; logs</li>
    <li><b>Zero dependencies</b> — one <code>zen-proxy.mjs</code>, runs on any Node ≥ 18</li>
  </ul>
</div>

## dashboard

The management UI runs on **`http://localhost:8787`** (or `http://127.0.0.1:8787`) once the proxy is running — live stats, one-click model tests, auto-sync status, config editing, and server logs.

![zen-proxy dashboard](assets/dashboard.png)

---

## install

Requires **Node.js ≥ 18**.

<table>
<tr>
<td width="50%" valign="top">

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

</td>
<td valign="top">

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

</td>
</tr>
</table>

Or just clone and run — it's a single file, no `npm install`:

```bash
git clone https://github.com/12errh/zen-proxy.git && cd zen-proxy
node zen-proxy.mjs
```

---

## usage

```bash
node zen-proxy.mjs            # or the installer's `zen-proxy` launcher
# dashboard → http://127.0.0.1:8787/
```

| Thing | Value |
|---|---|
| Dashboard / admin UI | `http://127.0.0.1:8787/` |
| OpenAI base URL | `http://127.0.0.1:8787/v1` |
| API key | `public` (or your `proxyKey` once set) |
| Example model | `mimo-v2.5-free` (auto default picks a healthy free model) |
| Health check | `http://127.0.0.1:8787/health` |

### point your agent at it

Cline / Roo / Continue / Aider / mimo — anywhere you configure an OpenAI-compatible provider:

```jsonc
{
  "provider": {
    "zen": {
      "baseURL": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "models": { "mimo-v2.5-free": {} }
    }
  }
}
```

Quick test:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"say hi"}]}'
```

---

## the dashboard

<div style="background-color:#ccf73a;border:2px solid #1a1612;border-radius:999px;padding:6px 16px;display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#1a1612;transform:rotate(-2deg);">manage everything, no config files</div>

- **Overview** — upstream health, uptime, request counters, live recent-request feed with status + latency
- **Models** — add/remove allowed models, pick the default, one-click **Test** per model
- **Settings** — edit host, port, upstream URL, User-Agent, proxy key, BYOK key, timeout, fallback list, aliases; saved to `zen-proxy.json` and applied instantly
- **Logs** — live terminal-style log tail

Set `proxyKey` and the dashboard, `/api/*`, chat completions, and `/v1/models` all require it (`/health` stays open for uptime monitors).

---

## configuration

Config lives in **`zen-proxy.json`** (auto-created on first run, hot-reloaded when edited — the dashboard writes it too). Env vars can override at startup.

| Key | Default | Description |
|---|---|---|
| `host` | `127.0.0.1` | Bind address (restart needed) |
| `port` | `8787` | Listen port (restart needed) |
| `upstream` | `https://opencode.ai/zen/v1` | Zen API base |
| `ua` | `opencode/1.18.30` | The `User-Agent` that unlocks the free tier (auto-updates to new opencode releases) |
| `autoUA` | `true` | Track opencode releases and update `ua` automatically (`opencode/<latest>`) |
| `uaRefreshMs` | `21600000` | How often to check for a new opencode version (ms) |
| `injectSession` | `true` | Mint an `x-opencode-session` header per client (upstream rejects requests without one) |
| `defaultModel` | `""` | Empty = auto: pick the first *healthy* free model (no more hardcoded/vanished defaults) |
| `fallbackModels` | `["space-bunny-free","mimo-v2.6-flash-free", …]` | Tried in order on `429`/`5xx` and unavailable-model `4xx`. Auto-sync **only removes a model the upstream says is gone** (`not supported`, 404) — temporary blocks like `403 FreeTierError` keep it configured so it recovers on its own |
| `responsesModels` | `["gpt-5*","gpt-6*","grok-*","muse-spark-*"]` | Models served on `/v1/responses` (patterns may end in `*`); the proxy translates to/from chat completions for you |
| `rateLimitMax` | `0` (off) | Max chat requests per client per window — `0` disables the limiter |
| `rateLimitWindowMs` | `60000` | Rate-limit window |
| `modelAliases` | `{}` | e.g. `{"gpt-4o":"mimo-v2.5-free"}` — reply model rewritten back |
| `proxyKey` | `""` | If set, clients must send it as `Bearer`; locks the dashboard too |
| `defaultZenKey` | `""` | Your own Zen key (BYOK) instead of anonymous `public` |
| `trustForwarded` | `false` | Trust `x-forwarded-for`/`x-real-ip` from a reverse proxy |
| `timeoutMs` | `120000` | Upstream timeout (streaming and non-streaming) |
| `cacheMs` | `30000` | `/v1/models` cache TTL |

Env vars: `HOST`, `PORT`, `ZEN_URL`, `ZEN_UA`, `INJECT_SESSION` (`0` to disable), `AUTO_UA` (`0` to disable), `UA_REFRESH_MS`, `RESPONSES_MODELS` (JSON), `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `DEFAULT_MODEL`, `FALLBACK_MODELS` (JSON), `MODEL_ALIASES` (JSON), `PROXY_KEY`, `ZEN_KEY`, `TRUST_FORWARDED=1`, `TIMEOUT_MS`, `CACHE_MS`, `AUTO_SYNC` (`0` to disable), `AUTO_SYNC_MS`, `ZEN_PROXY_CONFIG` (custom config path).

### bring your own key

Anonymous `public` access rides opencode's shared free pool (per-IP quota, sometimes saturated). For stable, reliable use set `defaultZenKey` to your own free Zen key — or send it per request as `x-zen-key` / a non-`public` bearer token.

---

## api surface

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions (stream + non-stream) |
| `POST` | `/v1/responses` | Responses passthrough |
| `GET` | `/v1/models` | Allowed models (cached) |
| `GET` | `/health` | Health check |
| `GET` | `/` | Dashboard |
| `GET` | `/api/status` | Stats + upstream health |
| `GET/PUT` | `/api/config` | Read / update config |
| `POST` | `/api/test` | Test a model (`{"model":"…"}`) |
| `GET` | `/api/logs` | Log tail |
| `POST` | `/api/reset` | Reset request stats |
| `GET` | `/assets/*` | Static assets (logo, favicon) |

---

## systemd (linux)

Install as a service via `install.sh` (it prompts you), or manually:

```bash
sudo systemctl enable --now zen-proxy
```

---

## caveats

- This rides opencode's **anonymous free tier**: per-IP request/daily quotas and a shared pool that's sometimes saturated. Don't rotate/abuse IPs or run heavy workloads anonymously.
- When the proxy falls back to a different model, the response includes `zen_served_by` so you can see which model actually answered.
- opencode keeps **tightening the anonymous free tier** — most `-free` models now answer `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`, and that hits the real opencode client too. The proxy detects it and rolls to the next working model, so requests keep succeeding, but the pool is much smaller than it used to be. A Zen API key (BYOK) is the reliable path.
- The `-free` models are "as-is" free tiers — expect rate limits and occasional provider errors.
- For anything serious, **BYOK**.

---

<p align="center" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;color:#7d7461;text-transform:uppercase;">zen-proxy · anonymous free tier · no accounts · no keys · 100% local</p>
<p align="center" style="font-family:'Iowan Old Style',Georgia,serif;font-style:italic;color:#7d7461;font-size:13px;">go make some noise.</p>

<p align="center"><b>MIT License</b></p>