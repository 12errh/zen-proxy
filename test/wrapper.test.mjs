// zen-claude is meant to be one command: start the proxy if needed, register
// every free Zen model in Claude Code's /model picker, and clean up on exit.
// It works by passing --settings, because Claude Code reads env from
// ~/.claude/settings.json and that beats anything exported in the shell — so the
// "obvious" way of configuring it silently does nothing.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const isWindows = process.platform === "win32"
const REPO = fileURLToPath(new URL("..", import.meta.url))
const SH = path.join(REPO, "bin", "claude-zen")
const PS1 = path.join(REPO, "bin", "claude-zen.ps1")
const CMD = path.join(REPO, "bin", "claude-zen.cmd")
const MAKER = path.join(REPO, "bin", "make-settings.mjs")
const SETTINGS = path.join(REPO, "claude", "zen-proxy.settings.json")

// A copy laid out the way the installer produces, on a port nothing is using.
function stage(port, { fakeClaude = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-claude-test-"))
  for (const sub of ["bin", "claude"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  fs.copyFileSync(SETTINGS, path.join(dir, "claude", "zen-proxy.settings.json"))
  fs.copyFileSync(SH, path.join(dir, "bin", "claude-zen"))
  fs.copyFileSync(MAKER, path.join(dir, "bin", "make-settings.mjs"))
  fs.copyFileSync(path.join(REPO, "zen-proxy.mjs"), path.join(dir, "zen-proxy.mjs"))
  fs.copyFileSync(path.join(REPO, "models.json"), path.join(dir, "models.json"))
  fs.copyFileSync(path.join(REPO, "agent-tools.json"), path.join(dir, "agent-tools.json"))
  fs.writeFileSync(path.join(dir, "zen-proxy.json"), JSON.stringify({ port }))
  fs.chmodSync(path.join(dir, "bin", "claude-zen"), 0o755)

  if (fakeClaude) {
    // A stand-in for claude that records the settings it was handed and exits,
    // so the launcher can be exercised without a real Claude Code session.
    const fake = path.join(dir, "bin", "claude")
    fs.writeFileSync(fake, ['#!/usr/bin/env bash',
      'NEXT=',
      'for a in "$@"; do',
      '  if [ "$NEXT" = 1 ]; then cat "$a" > "$(dirname "$0")/../settings-used.json"; echo "$a" > "$(dirname "$0")/../settings-path.txt"; NEXT=; continue; fi',
      '  [ "$a" = "--settings" ] && NEXT=1',
      'done',
      'echo "FAKE-CLAUDE-OK"',
      ''].join('\n'))
    fs.chmodSync(fake, 0o755)
  }
  return { dir, wrapper: path.join(dir, "bin", "claude-zen") }
}

// spawnSync, not execFileSync: the launcher writes its progress to stderr and
// exits 0, and execFileSync discards stderr on success.
function run(wrapper, { withFakeClaude = true, env = {}, binDir } = {}) {
  const PATH = withFakeClaude ? `${binDir ?? path.dirname(wrapper)}:${process.env.PATH}` : "/usr/bin:/bin"
  const r = spawnSync("bash", [wrapper, "-p", "hi"], {
    encoding: "utf8",
    env: { ...process.env, PATH, ...env },
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const PORT = 45699
function down(port = PORT) {
  const r = spawnSync("curl", ["-fsS", "-m", "2", `http://127.0.0.1:${port}/health`], { encoding: "utf8" })
  return r.status !== 0
}

describe("launcher settings", () => {
  test("the static fallback points at the proxy with a model pinned", () => {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"))
    assert.equal(cfg.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787")
    assert.equal(cfg.env.ANTHROPIC_AUTH_TOKEN, "public")
    assert.ok(cfg.env.ANTHROPIC_MODEL)
  })

  test("both launchers use --settings instead of exporting env", () => {
    for (const f of [SH, PS1]) {
      const src = fs.readFileSync(f, "utf8")
      assert.match(src, /--settings/, `${f} passes --settings`)
      assert.doesNotMatch(src, /^\s*export ANTHROPIC_BASE_URL/m, `${f} does not export ANTHROPIC_BASE_URL`)
    }
  })

  test("both launchers check for Claude Code and say how to install it", () => {
    for (const f of [SH, PS1]) {
      const src = fs.readFileSync(f, "utf8")
      assert.match(src, /not installed/, `${f} reports a missing Claude Code`)
      assert.match(src, /@anthropic-ai\/claude-code/, `${f} says how to install it`)
    }
  })

  test("the Windows shim calls the PowerShell launcher", () => {
    const cmd = fs.readFileSync(CMD, "utf8")
    assert.match(cmd, /claude-zen\.ps1/i, "delegates to the .ps1")
    assert.match(cmd, /%~|Bypass/i, "bypasses execution policy")
  })

  test("both installers put the commands on PATH", () => {
    assert.match(fs.readFileSync(path.join(REPO, "install.sh"), "utf8"), /claude-zen/)
    const ps = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8")
    assert.match(ps, /zen-proxy\.cmd/, "installs a zen-proxy shim")
    assert.match(ps, /claude-zen\.ps1/, "installs the claude-zen launcher")
    assert.match(ps, /SetEnvironmentVariable\("Path"/, "adds the bin dir to the user PATH")
  })

  test("the installer links the command under the name the docs use", () => {
    // The command is zen-claude but the script is bin/claude-zen. Linking only
    // the script's own name means `zen-claude` is "command not found" after a
    // successful install — which is exactly what it looked like from the outside.
    const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8")
    assert.match(sh, /bin\/claude-zen" "\$HOME\/\.local\/bin\/zen-claude"/, "install.sh links zen-claude")
    const ps = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8")
    assert.match(ps, /zen-claude\.cmd/, "install.ps1 provides zen-claude.cmd")
  })

  test("install.sh tells the user how to fix a stale PATH", () => {
    // The common post-install failure is a shell that was already open, so its
    // PATH predates ~/.local/bin.
    const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8")
    assert.match(sh, /not on this shell's PATH|not on your PATH/, "detects an unresolvable command")
    assert.match(sh, /\.zshrc/, "and says how to fix it permanently")
  })
})

describe("model picker generation", () => {
  test("make-settings.mjs lists every free model with a behavesAs row", () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zen-picker-")), "settings.json")
    try {
      const n = Number(execFileSync("node", [MAKER, "1", out], { encoding: "utf8" }).trim())
      const cfg = JSON.parse(fs.readFileSync(out, "utf8"))
      assert.ok(n > 0, "found models")
      assert.equal(cfg.modelPicker.replaceBuiltInOptions, true, "built-in lineup hidden")
      assert.equal(cfg.modelPicker.options.length, n)
      for (const o of cfg.modelPicker.options) {
        assert.ok(o.model, "row names the model actually sent")
        assert.ok(o.behavesAs, "row tells Claude Code which known model to imitate")
        assert.notEqual(o.model, o.behavesAs, "behavesAs is a stand-in, not the row's model")
      }
      assert.equal(cfg.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1")
    } finally {
      fs.rmSync(path.dirname(out), { recursive: true, force: true })
    }
  })

  test("it falls back to the shipped catalog when the proxy is unreachable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-picker-"))
    const out = path.join(dir, "settings.json")
    try {
      const n = Number(execFileSync("node", [MAKER, "1", out], { encoding: "utf8" }).trim())
      const shipped = JSON.parse(fs.readFileSync(path.join(REPO, "models.json"), "utf8")).models
      assert.equal(n, shipped.length, "used models.json instead of an empty list")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("posix launcher (bash)", { skip: isWindows && "bash launcher is posix-only" }, () => {
  test("is executable and valid bash", () => {
    assert.ok(fs.statSync(SH).mode & 0o111, "executable")
    execFileSync("bash", ["-n", SH])
  })

  test("does not exec claude, so the cleanup trap survives", () => {
    // exec replaces the shell: the EXIT trap never runs and an auto-started
    // proxy is left running after the session ends.
    const src = fs.readFileSync(SH, "utf8")
    assert.doesNotMatch(src, /^\s*exec claude/m, "does not exec claude")
    assert.match(src, /trap cleanup EXIT/, "cleans up on exit")
  })

  test("reports clearly when Claude Code is not installed", () => {
    const { dir, wrapper } = stage(PORT, { fakeClaude: false })
    try {
      const r = run(wrapper, { withFakeClaude: false })
      assert.notEqual(r.code, 0, "exits non-zero")
      assert.match(r.stderr, /Claude Code is not installed/, "names the problem")
      assert.match(r.stderr, /npm install -g @anthropic-ai\/claude-code/, "says how to fix it")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not start a proxy when Claude Code is missing", () => {
    const { dir, wrapper } = stage(PORT, { fakeClaude: false })
    try {
      run(wrapper, { withFakeClaude: false })
      assert.ok(down(), "no proxy was started")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("one command: starts the proxy, runs claude, then cleans up", () => {
    const { dir, wrapper } = stage(PORT)
    try {
      assert.ok(down(), "precondition: nothing on the port")
      const r = run(wrapper)
      assert.equal(r.code, 0, "exits cleanly")
      assert.match(r.stdout, /FAKE-CLAUDE-OK/, "Claude Code was launched")
      assert.match(r.stderr, /starting zen-proxy/, "and it said it was starting the proxy")

      const cfg = JSON.parse(fs.readFileSync(path.join(dir, "settings-used.json"), "utf8"))
      assert.equal(cfg.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`)
      assert.ok(cfg.modelPicker.options.length > 0, "the picker was populated")

      assert.ok(down(), "proxy was stopped again on exit")
      const tmp = fs.readFileSync(path.join(dir, "settings-path.txt"), "utf8").trim()
      assert.equal(fs.existsSync(tmp), false, "temp settings file removed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves a symlink to find its files", () => {
    // install.sh links claude-zen into ~/.local/bin, so $BASH_SOURCE[0] is the
    // symlink, not the real script.
    const { dir, wrapper } = stage(PORT)
    const link = path.join(dir, "linked-claude-zen")
    fs.symlinkSync(wrapper, link)
    try {
      const r = run(link, { binDir: path.join(dir, "bin") })
      assert.equal(r.code, 0, "ran through the symlink")
      assert.match(r.stdout, /FAKE-CLAUDE-OK/)
      assert.doesNotMatch(r.stderr, /could not find/, "found everything beside the real script")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("windows launcher (powershell)", { skip: !isWindows && "powershell launcher is windows-only" }, () => {
  // Staging a fake claude.cmd keeps this deterministic. The previous version
  // proved the "not installed" path by stripping PATH to System32, which left
  // PowerShell itself unable to start: it exited non-zero with no output, so
  // the assertion was matching against an empty string. The missing-install
  // message is covered by the static assertion on the script's source instead.
  function stageWin(port) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-claude-win-"))
    for (const sub of ["bin", "claude"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.copyFileSync(PS1, path.join(dir, "bin", "claude-zen.ps1"))
    fs.copyFileSync(MAKER, path.join(dir, "bin", "make-settings.mjs"))
    fs.copyFileSync(SETTINGS, path.join(dir, "claude", "zen-proxy.settings.json"))
    for (const f of ["zen-proxy.mjs", "models.json", "agent-tools.json"]) fs.copyFileSync(path.join(REPO, f), path.join(dir, f))
    fs.writeFileSync(path.join(dir, "zen-proxy.json"), JSON.stringify({ port }))
    fs.writeFileSync(path.join(dir, "bin", "claude.cmd"), "@echo off\r\necho FAKE-CLAUDE-OK\r\n")
    return dir
  }

  const psRun = (dir, extra = []) =>
    spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "bin", "claude-zen.ps1"), ...extra], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(dir, "bin")};${process.env.PATH ?? ""}` },
    })

  test("the script parses", () => {
    const dir = stageWin(45701)
    try {
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `[scriptblock]::Create((Get-Content -Raw '${path.join(dir, "bin", "claude-zen.ps1")}')) | Out-Null`],
        { encoding: "utf8" },
      )
      assert.equal(r.status, 0, `syntax error: ${r.stderr}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("one command: starts the proxy, runs claude, then cleans up", () => {
    const port = 45702
    const dir = stageWin(port)
    try {
      assert.ok(down(port), "precondition: nothing on the port")
      const r = psRun(dir, ["-p", "hi"])
      assert.match(`${r.stdout ?? ""}`, /FAKE-CLAUDE-OK/, `claude launched; stderr=${r.stderr}`)
      assert.match(`${r.stderr ?? ""}`, /starting zen-proxy/, "and it said it was starting the proxy")
      assert.ok(down(port), "proxy was stopped again on exit")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("README badges", () => {
  // shields.io answers a malformed badge with HTTP 200 and an SVG whose title
  // is "404: badge not found". Checking the status code alone — which is what
  // I did before shipping two of these — reports success for a broken badge.
  const badges = [...fs.readFileSync(path.join(REPO, "README.md"), "utf8").matchAll(/https:\/\/img\.shields\.io\/[^"\s]+/g)].map(
    (m) => m[0].replace(/&amp;/g, "&"),
  )

  test("there are badges to check", () => {
    assert.ok(badges.length >= 5, `expected several badges, found ${badges.length}`)
  })

  test("none of them are malformed", { skip: !process.env.NETWORK && "needs network" }, async () => {
    const broken = []
    for (const url of badges) {
      const res = await fetch(url)
      const body = await res.text()
      if (!res.ok || /badge not found|invalid/.test(body)) broken.push(url)
    }
    assert.deepEqual(broken, [], `shields.io could not render:\n  ${broken.join("\n  ")}`)
  })

  test("every anchor a badge links to exists", () => {
    const md = fs.readFileSync(path.join(REPO, "README.md"), "utf8")
    const headings = [...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
      m[1].toLowerCase().replace(/[`*]/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-"),
    )
    const anchors = [...md.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1])
    assert.deepEqual(anchors.filter((a) => !headings.includes(a)), [])
  })
})

describe("the launcher keeps the proxy alive", { skip: isWindows && "drives the bash launcher, which is posix-only" }, () => {
  // Reproduces the reported failure: the proxy goes away partway through a
  // session and the agent is left talking to a closed port, with a connection
  // error as the only symptom.
  function stage() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-watch-"))
    for (const sub of ["bin", "claude"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.copyFileSync(SH, path.join(dir, "bin", "claude-zen"))
    fs.copyFileSync(MAKER, path.join(dir, "bin", "make-settings.mjs"))
    fs.copyFileSync(SETTINGS, path.join(dir, "claude", "zen-proxy.settings.json"))
    for (const f of ["zen-proxy.mjs", "models.json", "agent-tools.json"]) fs.copyFileSync(path.join(REPO, f), path.join(dir, f))
    fs.writeFileSync(path.join(dir, "zen-proxy.json"), JSON.stringify({ port: PORT }))
    // A stand-in for Claude Code that kills the proxy halfway through, the way a
    // crash or an OOM kill would, then keeps running for a few more seconds.
    fs.writeFileSync(
      path.join(dir, "bin", "claude"),
      `#!/usr/bin/env bash\ncurl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 9\n` +
        // Scoped to the staged path: a bare `pkill -f zen-proxy.mjs` matches
        // every proxy on the machine, including one the developer is running.
        `pkill -f '${dir}/zen-proxy.mjs' 2>/dev/null; sleep 6\n` +
        `curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && echo PROXY-STILL-THERE || echo PROXY-GONE\n`,
    )
    fs.chmodSync(path.join(dir, "bin", "claude"), 0o755)
    return dir
  }

  test("restarts the proxy if it dies while Claude Code is running", () => {
    const dir = stage()
    try {
      assert.ok(down(), "precondition: nothing on the port")
      const r = spawnSync("bash", [path.join(dir, "bin", "claude-zen")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` },
        timeout: 90_000,
      })
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
      assert.match(out, /restarting \(1\/10\)/, `expected a restart, got: ${out}`)
      assert.match(out, /PROXY-STILL-THERE/, `proxy should be back up by the end: ${out}`)
    } finally {
      // Sweep only the proxy this test staged — its command line contains the
      // temp dir. `pgrep -f zen-proxy.mjs` would match any proxy the developer
      // has running, and its stdout is null where pgrep does not exist.
      const pgrep = spawnSync("pgrep", ["-f", path.join(dir, "zen-proxy.mjs")], { encoding: "utf8" })
      for (const p of (pgrep.stdout ?? "").split("\n").filter(Boolean))
        try { process.kill(Number(p), "SIGKILL") } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
