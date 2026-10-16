// The zen-claude wrapper has to work by passing --settings, because Claude Code
// reads env from ~/.claude/settings.json and that beats anything exported in the
// shell — so the "obvious" way of configuring it silently does nothing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const WRAPPER = path.join(REPO, "bin", "claude-zen")
const SETTINGS = path.join(REPO, "claude", "zen-proxy.settings.json")

// Lays out a throwaway copy the way the installer does, so results never depend
// on whether a proxy happens to be running on the default port.
function stage(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-claude-test-"))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.mkdirSync(path.join(dir, "claude"))
  fs.copyFileSync(SETTINGS, path.join(dir, "claude", "zen-proxy.settings.json"))
  fs.writeFileSync(path.join(dir, "zen-proxy.json"), JSON.stringify({ port }))
  const wrapper = path.join(dir, "bin", "claude-zen")
  fs.copyFileSync(WRAPPER, wrapper)
  fs.chmodSync(wrapper, 0o755)
  return { dir, wrapper }
}

function run(wrapper) {
  try {
    const stdout = execFileSync("bash", [wrapper, "-p", "hi"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, stdout, stderr: "" }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }
  }
}

test("bin/claude-zen is executable and valid bash", () => {
  assert.ok(fs.existsSync(WRAPPER), "wrapper exists")
  assert.ok(fs.statSync(WRAPPER).mode & 0o111, "wrapper is executable")
  execFileSync("bash", ["-n", WRAPPER])
})

test("the bundled settings point Claude Code at the local proxy", () => {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"))
  assert.equal(cfg.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787")
  assert.equal(cfg.env.ANTHROPIC_AUTH_TOKEN, "public")
  assert.ok(cfg.env.ANTHROPIC_MODEL, "a model is pinned so no /model is needed")
})

test("the wrapper passes --settings rather than exporting env", () => {
  const src = fs.readFileSync(WRAPPER, "utf8")
  assert.match(src, /exec claude --settings/, "claude is exec'd with --settings")
  assert.doesNotMatch(src, /^\s*export ANTHROPIC_BASE_URL/m, "does not rely on exporting ANTHROPIC_BASE_URL")
})

test("the wrapper refuses to start when no proxy is listening", () => {
  const { dir, wrapper } = stage(45671)
  try {
    const r = run(wrapper)
    assert.notEqual(r.code, 0, "exits non-zero")
    assert.match(r.stderr, /no zen-proxy/, "says the proxy is not running")
    assert.doesNotMatch(r.stdout, /Hi!|Claude Code/, "never launches Claude Code")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the wrapper resolves a symlink to find its settings", () => {
  // install.sh links claude-zen into ~/.local/bin, so $BASH_SOURCE[0] is the
  // symlink, not the real script — it has to be resolved first.
  const { dir, wrapper } = stage(45672)
  const link = path.join(dir, "linked-claude-zen")
  fs.symlinkSync(wrapper, link)
  try {
    const r = run(link)
    assert.notEqual(r.code, 0, "still fails on the health check")
    assert.doesNotMatch(r.stderr, /could not find/, "located the settings through the symlink")
    assert.match(r.stderr, /45672/, "and read the port from the config beside the real script")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})