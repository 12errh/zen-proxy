# Zen Proxy

A zero-dependency, local OpenAI-compatible proxy that unlocks **opencode's anonymous free AI tier** for **any** OpenAI-compatible coding agent.

**Why?** opencode's free `-free` models (deepseek-v4-flash, nemotron, etc.) are only served to requests that present the right `User-Agent`. Most agents (like the *mimo* CLI fork) force their own UA and get `429 FreeUsageLimitError`. Zen Proxy injects the correct `User-Agent` upstream and re-exposes everything as a plain OpenAI API — no accounts, no API keys, no source patches.

**Works with:** mimo cli, Cline, Roo Code, Continue, Aider, opencode forks, or anything that lets you set a `baseURL` + `apiKey`.

---

## Install

Requires **Node.js >= 18**.

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

Or clone the repo and run directly — it's a single file, no `npm install`:

```bash
git clone https://github.com/12errh/zen-proxy.git && cd zen-proxy
node zen-proxy.mjs
```

---

## Usage

Start the proxy, then open the management dashboard:

```
http://127.0.0.1:8787/
```

| Thing | Value |
|---|---|
| Dashboard / admin API | `http://127.0.0.1:8787/` |
| OpenAI base URL | `http://127.0.0.1:8787/v1` |
| API key | `public` (or any value when you set `proxyKey`) |
| Example model | `deepseek-v4-flash-free` |
| Health check | `http://127.0.0.1:8787/health` |

### Point your agent at it

Cline / Roo / Continue / Aider / mimo — wherever you configure an OpenAI-compatible provider:

```jsonc
{
  "provider": {
    "zen": {
      "baseURL": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "models": { "deepseek-v4-flash-free": {} }
    }
  }
}
```

Quick test:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"say hi"}]}'
```

---

## Dashboard

Served at `http://127.0.0.1:8787/` and lets you manage everything without touching config:

- **Overview** — upstream health, uptime, request counters, recent-request table with status + latency
- **Models** — add/remove allowed models, set the default, one-click **Test** (live status per model)
- **Settings** — edit host, port, upstream URL, User-Agent, proxy key, BYOK key, timeout, fallback list, model aliases; saved to `zen-proxy.json` and applied instantly (no restart, except host/port)
- **Logs** — live tail of server logs

Set `proxyKey` and the dashboard/API will require that key.

---

## Configuration

Config lives in **`zen-proxy.json`** (auto-created on first run, hot-reloaded when edited — the dashboard writes it too). Env vars can override at startup.

| Key | Default | Description |
|---|---|---|
| `host` | `127.0.0.1` | Bind address (restart needed) |
| `port` | `8787` | Listen port (restart needed) |
| `upstream` | `https://opencode.ai/zen/v1` | Zen API base |
| `ua` | `opencode/1.2.31` | The `User-Agent` that unlocks the free tier |
| `defaultModel` | `deepseek-v4-flash-free` | Used when a request names an unknown model |
| `fallbackModels` | `["deepseek-v4-flash-free","big-pickle","hy3-free", …]` | Tried in order on `429`/`5xx` |
| `modelAliases` | `{}` | e.g. `{"gpt-4o":"deepseek-v4-flash-free"}` — reply model is rewritten back |
| `proxyKey` | `""` | If set, clients must send it as `Bearer`; also locks the dashboard |
| `defaultZenKey` | `""` | Your own Zen key (BYOK) instead of anonymous `public` |
| `trustForwarded` | `false` | Trust `x-forwarded-for`/`x-real-ip` from a reverse proxy |
| `timeoutMs` | `120000` | Upstream timeout for non-streaming |
| `cacheMs` | `30000` | `/v1/models` cache TTL |

Env vars: `HOST`, `PORT`, `ZEN_URL`, `ZEN_UA`, `DEFAULT_MODEL`, `FALLBACK_MODELS` (JSON), `MODEL_ALIASES` (JSON), `PROXY_KEY`, `ZEN_KEY`, `TRUST_FORWARDED=1`, `TIMEOUT_MS`, `CACHE_MS`, `ZEN_PROXY_CONFIG` (custom config path).

### BYOK (bring your own key)

Anonymous `public` access rides opencode's shared free pool (per-IP quota, sometimes saturated). For stable/reliable use, set `defaultZenKey` to your own free Zen key, or have a client send it per request as `x-zen-key` / a non-`public` bearer token.

---

## API surface

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

---

## Systemd (Linux)

Install as a service via `install.sh` (it prompts you), or manually:

```bash
sudo systemctl enable --now zen-proxy
```

---

## Caveats

- This uses opencode's **anonymous free tier**: per-IP request/daily quotas and a shared free pool that is sometimes saturated. Don't rotate/abuse IPs or run heavy workloads anonymously.
- The `-free` models are "as-is" free tiers — expect rate limits and occasional provider errors.
- For anything serious, BYOK.

## License

MIT