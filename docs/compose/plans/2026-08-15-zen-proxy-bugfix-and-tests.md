# zen-proxy Bugfix + Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 reported bugs in zen-proxy (single-file Node proxy) and add a real `node:test` suite proving each fix.

**Architecture:** All server fixes land in `zen-proxy.mjs` (one file, zero deps). The module must first be made *importable* (guard `server.listen`/`fs.watch` behind an `isMain` check, export internals) so tests can drive handlers with a stubbed `fetch` and mock req/res. Dashboard XSS fix is in `public/index.html` (inline script). Installer config-loss fix is in `install.sh` + `install.ps1`.

**Tech Stack:** Node ≥ 18, zero deps, `node:test` + `node --test test/`. No package installs.

## Global Constraints

- Node >= 18 only — no `AbortSignal.any`, no `import.meta.main` (use `process.argv[1]` check).
- Zero new npm dependencies; tests use `node:test` and the global `fetch`/`Response`.
- Keep the file single-module; exports are live ESM bindings (tests read `config` after `saveConfig`).
- No behavior changes beyond the bug list — no new features, no renames of public API surface (endpoints, config keys).
- TDD: every fix gets a failing test first, verified RED, then GREEN.

---

### Task 1: Make the module testable (scaffolding, no behavior change)

**Files:**
- Modify: `zen-proxy.mjs` (add `isMain` guard around `fs.watch`, `server.listen` block; add `export { ... }` at bottom)
- Test: `test/zen-proxy.test.mjs` (harness: mock req/res, fetch stub, env `ZEN_PROXY_CONFIG` → temp dir before import)

**Interfaces:**
- Produces: `isMain`, `config`, `loadConfig`, `saveConfig`, `sanitize`, `maskKey`, `resolveModel`, `authForUpstream`, `clientIp`, `ipOmit`, `zenHeaders`, `handleChat`, `relayStream`, `rewriteSSE`, `fetchModels`, `handleModels`, `handleApiConfig`, `handleStatus`, `recordReq`, `requestStats` exports.

- [ ] **Step 1:** Add `const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`; wrap the top-level `fs.watch` block and the `server.listen(...)` startup block in `if (isMain)`.
- [ ] **Step 2:** Append `export { ... }` listing the interfaces above.
- [ ] **Step 3:** Verify: `node --check zen-proxy.mjs` passes; `node zen-proxy.mjs` still starts; a tiny `node -e "import('./zen-proxy.mjs').then(m => console.log(typeof m.handleChat))"` prints `function` without binding the port.

---

### Task 2: Core proxy fixes (T2 — dedup/stats, status propagation, stream timeout, retry-after, stream cleanup, models cache stampede)

**Files:**
- Modify: `zen-proxy.mjs`
- Test: `test/zen-proxy.test.mjs`

**B1 — broken recent-request dedup.** `recordReq` compares `recent[last][1]` (count) against the key string — always true, increment branch dead.
- Test: `recordReq` twice with same `(at, model, status)` → `recent` has 1 entry with count 2; different status → 2 entries.
- Fix: compare `[0]`; add optional `at = Date.now()` param (time-injection seam, no test-only method).

**B10 — unbounded `perMinute` map + "last minute" semantics.** Add rolling 60s window `window60`; prune buckets older than 60 min in `recordReq`; `handleStatus` computes `lastMinute = window60.length`, `last5m` from buckets `< 5` min old.
- Test: after recording at `at` and `at + 61s`, old bucket pruned; `window60` counts only last 60s.

**B2 — final error always 429.** Track `lastStatus` in `handleChat` loop (502 on fetch throw, upstream status otherwise); final `writeHead(lastStatus)` + `recordReq(..., lastStatus)`.
- Test: single candidate returns 400 → `handleChat` responds 400 (not 429) with upstream error body; all candidates 429 → 429; all fetch throws → 502.

**B9 — `retry-after` parse.** Add `parseRetryAfter(value)`: seconds number, else HTTP-date via `Date.parse`, else 0.
- Test: `"5"` → 5; `"Fri, 01 Jan 2026 00:00:00 GMT"` → > 0; garbage → 0.

**B8 — no stream timeout.** Add `streamAbort(req)`: AbortController bridged to `req.signal` + `setTimeout(config.timeoutMs)`; used for stream fetches; `cleanup()` on finish/error.
- Test: stream fetch receives a signal; after `cleanup()`, aborting does not throw.

**B13 — stream reader not cancelled on error.** `relayStream` returns the `pump()` promise; catch calls `reader.cancel()`.
- Test: `relayStream` with an SSE `Response` writes rewritten events + `[DONE]` and resolves.

**B14 — `/v1/models` cache stampede.** In-flight dedupe via module-level `modelsFetch` promise.
- Test: two concurrent `fetchModels()` with stale cache → stub `fetch` called once.

---

### Task 3: Robustness fixes (T3 — body limit/validation, models auth, honest health, masked-key PUT, coercion)

**Files:**
- Modify: `zen-proxy.mjs`
- Test: `test/zen-proxy.test.mjs`

**B4/B15 — unbounded body + non-object body.** `MAX_BODY = 1 MiB`, `BodyTooLargeError` thrown by `readBody`; `handleChat`/`handleApiConfig` map it to 413; `handleChat` rejects non-object bodies with 400.
- Test: oversized body → 413; `[1,2]` body → 400.

**B5 — `/v1/models` unauthenticated.** `handleModels` calls `adminAuth`; `/health` returns real `fetchModels().ok`.
- Test: proxyKey set + no bearer → `handleModels` 401; with key → 200.

**B7 — masked-key PUT footgun + coercion.** PUT drops `proxyKey === "••••••••"` and `defaultZenKey` equal to current masked form; `toBool()` handles `"0"`/`"false"` strings for `autoSync`/`trustForwarded`; numeric fields validated (finite, > 0, cacheMs >= 0).
- Test: PUT with masked proxyKey keeps existing key; PUT `autoSync: "0"` → false; PUT `port: "abc"` → unchanged; unknown keys ignored.

---

### Task 4: Dashboard XSS + upstream model-ID validation (T4)

**Files:**
- Modify: `public/index.html`, `zen-proxy.mjs`
- Test: `test/zen-proxy.test.mjs`

**B6 — XSS via model id in onclick.** `escapeHtml` decodes `&#39;` back to `'` inside attributes → JS string breakout. Fix: `jsStr(s)` = `JSON.stringify` with `'`→`\x27`, `&`→`\u0026`; embed as `onclick='testModel(${jsStr(m)})'` (single-quoted attributes).
- Server side: `VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/`; `syncModels` filters upstream ids and `current`/`defaultModel` through it.
- Test: `syncModels` with a stub upstream returning a malicious id (`x');alert(1)//-free`) → not added to config; normal `-free` ids added.

---

### Task 5: Installer config preservation (T5)

**Files:**
- Modify: `install.sh`, `install.ps1`

**B3 — reinstall wipes `zen-proxy.json`.** Back up existing config to a temp file before the wipe/copy, restore after; default-config creation only when still missing.
- Test (manual): run `bash install.sh --local .` twice with a custom `zen-proxy.json`; second run preserves it.

---

### Task 6: Complete suite + verification (T6)

**Files:**
- Create: `package.json` (`"type": "module"`, `"scripts": { "start": "node zen-proxy.mjs", "test": "node --test test/" }`, `engines.node >= 18`)
- Test: `test/zen-proxy.test.mjs` (full suite: resolveModel, authForUpstream, ipOmit/clientIp/zenHeaders, recordReq/stats, handleChat success/fallback/400/401/413/stream, rewriteSSE, handleApiConfig GET/PUT, sanitize/maskKey, fetchModels cache+stampede, handleStatus windows, parseRetryAfter, handleModels auth)

- [ ] **Step 1:** Run `node --test test/` — all tests pass.
- [ ] **Step 2:** Run `node --check zen-proxy.mjs` and `node --check` on the test file.
- [ ] **Step 3:** Boot smoke test: `AUTO_SYNC=0 ZEN_PROXY_CONFIG=/tmp/zp-smoke.json PORT=8799 node zen-proxy.mjs &` → `curl /health` → kill; confirm clean startup and shutdown.