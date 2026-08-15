#!/usr/bin/env bash
# Zen Proxy installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
#   # or, from a local checkout:
#   bash install.sh --local /path/to/zen-proxy
#
# Env options:
#   ZEN_PROXY_REPO   GitHub "owner/repo" (default: 12errh/zen-proxy)
#   ZEN_PROXY_DIR    install directory (default: ~/.zen-proxy)
#   ZEN_PROXY_PORT   default port (default: 8787)

set -euo pipefail

REPO="${ZEN_PROXY_REPO:-12errh/zen-proxy}"
INSTALL_DIR="${ZEN_PROXY_DIR:-$HOME/.zen-proxy}"
PORT="${ZEN_PROXY_PORT:-8787}"
LOCAL_SRC="${1:-}"
if [[ "${1:-}" == "--local" && "$#" -ge 2 ]]; then LOCAL_SRC="$2"; fi

info()  { printf "\033[32m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
die()   { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ]; then
  die "Refusing to install into '$INSTALL_DIR'"
fi

command -v curl >/dev/null 2>&1 || die "curl is required. Install it first."
command -v node >/dev/null 2>&1 || die "Node.js >= 18 is required. See https://nodejs.org"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then die "Node.js >= 18 is required (found $(node -v)). See https://nodejs.org"; fi

mkdir -p "$INSTALL_DIR"
info "Installing zen-proxy to $INSTALL_DIR"

# Preserve an existing config across the wipe/copy below.
CFG_BAK="$(mktemp)"
if [ -f "$INSTALL_DIR/zen-proxy.json" ]; then
  cp "$INSTALL_DIR/zen-proxy.json" "$CFG_BAK"
fi

if [ -n "$LOCAL_SRC" ]; then
  [ -d "$LOCAL_SRC" ] || die "Local source not found: $LOCAL_SRC"
  cp -r "$LOCAL_SRC/." "$INSTALL_DIR/"
  rm -rf "$INSTALL_DIR/.mimocode" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/.git" "$INSTALL_DIR/zen-proxy.json.tmp"
  info "Copied from local source: $LOCAL_SRC"
else
  TARBALL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  info "Downloading $TARBALL …"
  TMP="$(mktemp -d)"
  curl -fsSL "$TARBALL" -o "$TMP/repo.tar.gz"
  tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
  rm -rf "$INSTALL_DIR"/*
  cp -r "$TMP"/*/. "$INSTALL_DIR/"
  rm -rf "$TMP"
  info "Downloaded and extracted $REPO"
fi

if [ -s "$CFG_BAK" ]; then
  cp "$CFG_BAK" "$INSTALL_DIR/zen-proxy.json"
fi
rm -f "$CFG_BAK"

if [ ! -f "$INSTALL_DIR/zen-proxy.mjs" ]; then
  die "zen-proxy.mjs not found after install — check ZEN_PROXY_REPO"
fi

if [ ! -f "$INSTALL_DIR/zen-proxy.json" ]; then
  printf '{ "host": "127.0.0.1", "port": %s }\n' "$PORT" > "$INSTALL_DIR/zen-proxy.json"
  info "Created default config with port $PORT"
fi

cat > "$INSTALL_DIR/zen-proxy" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/zen-proxy.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/zen-proxy"

ln -sf "$INSTALL_DIR/zen-proxy" "$HOME/.local/bin/zen-proxy" 2>/dev/null || {
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_DIR/zen-proxy" "$HOME/.local/bin/zen-proxy"
}

info ""
info "✓ zen-proxy installed!"
info "  Dashboard: http://127.0.0.1:$PORT"
info ""
info "Run it:            zen-proxy"
info "Or add PATH:       export PATH=\"\$HOME/.local/bin:\$PATH\""
info ""
info "Point your AI agent at:"
info "  baseURL = http://127.0.0.1:$PORT/v1"
info "  apiKey  = public"
info "  model   = deepseek-v4-flash-free"

if command -v systemctl >/dev/null 2>&1 && [ -w /etc/systemd/system ]; then
  info ""
  read -r -p "Install as a systemd service (auto-start)? [y/N] " ans || true
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    cat > /etc/systemd/system/zen-proxy.service <<SVC
[Unit]
Description=Zen Proxy
After=network.target

[Service]
ExecStart=$(command -v node) $INSTALL_DIR/zen-proxy.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC
    systemctl daemon-reload
    systemctl enable --now zen-proxy
    info "systemd service zen-proxy started."
  fi
fi