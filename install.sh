#!/bin/bash
# Installs (or reinstalls) the shared figma-console bridge as a launchd user agent
# on macOS and waits until it answers on /health.
#
# Everything machine-specific is resolved at install time:
#   - install dir: the folder this script lives in
#   - node:        $NODE, or `command -v node`
#   - port:        $FIGMA_SHARED_PORT (default 9240)
#   - token file:  $FIGMA_SHARED_TOKEN_FILE (default: <install dir>/token)
#   - log file:    ~/Library/Logs/figma-console-shared.log
#
# Usage: ./install.sh [--dry-run]
#   --dry-run  print the generated plist and exit without touching launchd
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install.sh uses launchd and only works on macOS; run 'node bridge.mjs' under your own supervisor instead." >&2
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
LABEL="local.figma-console-shared"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$INSTALL_DIR/launchd/figma-console-shared.plist.template"
PORT="${FIGMA_SHARED_PORT:-9240}"
TOKEN_FILE="${FIGMA_SHARED_TOKEN_FILE:-$INSTALL_DIR/token}"
LOG_FILE="$HOME/Library/Logs/figma-console-shared.log"

NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "node not found on PATH (Node.js 18+ is required); set NODE=/path/to/node to override." >&2
  exit 1
fi
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

case "$PORT" in
  ''|*[!0-9]*) echo "FIGMA_SHARED_PORT must be a number, got '$PORT'" >&2; exit 1 ;;
esac

if [ ! -f "$INSTALL_DIR/node_modules/figma-console-mcp/dist/local.js" ]; then
  echo "dependencies are missing; run 'npm ci' in $INSTALL_DIR first." >&2
  exit 1
fi

if [ -f "$TOKEN_FILE" ]; then
  [ "$DRY_RUN" = 1 ] || chmod 600 "$TOKEN_FILE"
else
  echo "note: no token file at $TOKEN_FILE; Figma REST-API tools will be unavailable (Desktop Bridge tools still work)." >&2
fi

if [ "$DRY_RUN" = 1 ]; then
  OUT="$(mktemp -t figma-console-shared)"
  trap 'rm -f "$OUT"' EXIT
else
  mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG_FILE")"
  OUT="$PLIST"
fi

# Render the template with node so values are XML-escaped and no sed quoting is involved.
LABEL="$LABEL" NODE_BIN="$NODE" INSTALL_DIR="$INSTALL_DIR" PORT="$PORT" TOKEN_FILE="$TOKEN_FILE" \
LOG_FILE="$LOG_FILE" SERVICE_PATH="$(dirname "$NODE"):/usr/bin:/bin" \
  "$NODE" -e '
    const fs = require("fs");
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const e = process.env;
    const values = {
      LABEL: e.LABEL, NODE: e.NODE_BIN, INSTALL_DIR: e.INSTALL_DIR, PORT: e.PORT,
      TOKEN_FILE: e.TOKEN_FILE, LOG_FILE: e.LOG_FILE, PATH: e.SERVICE_PATH,
    };
    const out = fs.readFileSync(process.argv[1], "utf8")
      .replace(/<!-- Template:.*-->\n/, "")
      .replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
        if (!(k in values)) throw new Error("unknown placeholder " + m);
        return esc(values[k]);
      });
    fs.writeFileSync(process.argv[2], out);
  ' "$TEMPLATE" "$OUT"

plutil -lint "$OUT" >/dev/null

if [ "$DRY_RUN" = 1 ]; then
  cat "$OUT"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health"; then
    echo
    echo "OK: shared figma-console is up at http://127.0.0.1:$PORT/mcp"
    exit 0
  fi
  sleep 1
done
echo "service did not come up; see $LOG_FILE" >&2
exit 1
