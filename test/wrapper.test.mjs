// The zen-claude launchers have to work by passing --settings, because Claude
// Code reads env from ~/.claude/settings.json (or %USERPROFILE%\.claude\) and
// that beats anything exported in the shell — so the "obvious" way of
// configuring it silently does nothing.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const isWindows = process.platform === "win32"
const REPO = fileURLToPath(new URL("..", import.meta.url))
const SH = path.join(REPO, "bin", "claude-zen")
const PS1 = path.join(REPO, "bin", "claude-zen.ps1")
const CMD = path.join(REPO, "bin", "claude-zen.cmd")
const SETTINGS = path.join(REPO, "claude", "zen-proxy.settings.json")

describe("launcher settings file", () => {
  test("points Claude Code at the local proxy with a model pinned", () => {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"))
    assert.equal(cfg.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787")
    assert.equal(cfg.env.ANTHROPIC_AUTH_TOKEN, "public")
    assert.ok(cfg.env.ANTHROPIC_MODEL, "a model is pinned so no /model is needed")
  })

  test("both launchers use --settings instead of exporting env", () => {
    for (const f of [SH, PS1]) {
      const src = fs.readFileSync(f, "utf8")
      assert.match(src, /claude --settings|claude.*--settings/, `${f} passes --settings`)
      assert.doesNotMatch(src, /^\s*export ANTHROPIC_BASE_URL/m, `${f} does not export ANTHROPIC_BASE_URL`)
    }
  })

  test("the Windows shim calls the PowerShell launcher", () => {
    const cmd = fs.readFileSync(CMD, "utf8")
    assert.match(cmd, /claude-zen\.ps1/i, "cmd shim delegates to the .ps1")
    assert.match(cmd, /%~|Bypass/i, "bypasses execution policy so it runs on a fresh machine")
  })

  test("install.ps1 puts both commands on PATH", () => {
    const ps = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8")
    assert.match(ps, /zen-proxy\.cmd/, "installs a zen-proxy shim")
    assert.match(ps, /claude-zen\.ps1/, "installs the claude-zen launcher")
    assert.match(ps, /SetEnvironmentVariable\("Path"/, "adds the bin dir to the user PATH")
  })

  test("install.sh also puts claude-zen on PATH", () => {
    const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8")
    assert.match(sh, /claude-zen/, "links claude-zen")
  })
})

// Lays out a throwaway copy the way the installer does, so results never depend
// on whether a proxy happens to be running on the default port.
function stage(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-claude-test-"))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.mkdirSync(path.join(dir, "claude"))
  fs.copyFileSync(SETTINGS, path.join(dir, "claude", "zen-proxy.settings.json"))
  fs.writeFileSync(path.join(dir, "zen-proxy.json"), JSON.stringify({ port }))
  return { dir, bin: path.join(dir, "bin") }
}

describe("posix launcher (bash)", { skip: isWindows && "bash launcher is posix-only" }, () => {
  const stageSh = (port) => {
    const { dir, bin } = stage(port)
    const wrapper = path.join(bin, "claude-zen")
    fs.copyFileSync(SH, wrapper)
    fs.chmodSync(wrapper, 0o755)
    return { dir, wrapper }
  }

  const run = (wrapper, viaSymlink = false) => {
    let target = wrapper
    if (viaSymlink) {
      target = path.join(path.dirname(wrapper), "linked-claude-zen")
      fs.symlinkSync(wrapper, target)
    }
    try {
      const stdout = execFileSync("bash", [target, "-p", "hi"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      return { code: 0, stdout, stderr: "" }
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }
    }
  }

  test("is executable and valid bash", () => {
    assert.ok(fs.statSync(SH).mode & 0o111, "executable")
    execFileSync("bash", ["-n", SH])
  })

  test("refuses to start when no proxy is listening", () => {
    const { dir, wrapper } = stageSh(45671)
    try {
      const r = run(wrapper)
      assert.notEqual(r.code, 0, "exits non-zero")
      assert.match(r.stderr, /no zen-proxy/, "says the proxy is not running")
      assert.doesNotMatch(r.stdout, /Hi!|Claude Code/, "never launches Claude Code")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves a symlink to find its settings", () => {
    // install.sh links claude-zen into ~/.local/bin, so $BASH_SOURCE[0] is the
    // symlink, not the real script — it has to be resolved first.
    const { dir, wrapper } = stageSh(45672)
    try {
      const r = run(wrapper, true)
      assert.notEqual(r.code, 0, "still fails on the health check")
      assert.doesNotMatch(r.stderr, /could not find/, "located the settings through the symlink")
      assert.match(r.stderr, /45672/, "and read the port from the config beside the real script")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("windows launcher (powershell)", { skip: !isWindows && "powershell launcher is windows-only" }, () => {
  test("refuses to start when no proxy is listening", () => {
    const { dir, bin } = stage(45673)
    fs.copyFileSync(PS1, path.join(bin, "claude-zen.ps1"))
    try {
      let stderr = ""
      let code = 0
      try {
        execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "claude-zen.ps1")], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (e) {
        code = e.status ?? 1
        stderr = String(e.stderr ?? "")
      }
      assert.notEqual(code, 0, "exits non-zero")
      assert.match(stderr, /no zen-proxy/, "says the proxy is not running")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})