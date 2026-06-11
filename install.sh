#!/usr/bin/env bash
#
# Drop CLI installer — sets up the `drop` command for the current user.
#
# Usage:
#   ./install.sh                         # install, prompt for nothing
#   ./install.sh --api https://api.drop.company.com   # bake a default control-plane URL
#
# What it does (idempotent, no sudo required):
#   1. ensures Bun is installed (installs it if missing)
#   2. installs the project's dependencies
#   3. writes a `drop` wrapper into a bin dir on your PATH
#   4. adds that bin dir to your shell rc if needed
#
# We ship a wrapper around `bun run` rather than a compiled binary: standalone
# binaries are unsigned and get blocked/killed on managed (corp) machines, while
# invoking the already-trusted `bun` runtime works everywhere.

set -euo pipefail

# ---- resolve the repo root (this script's directory) ---------------------------
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DROP_HOME="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

API_DEFAULT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_DEFAULT="${2:-}"; shift 2 ;;
    --api=*) API_DEFAULT="${1#*=}"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

if [ ! -f "$DROP_HOME/bin/drop.ts" ]; then
  echo "error: bin/drop.ts not found next to install.sh (run this from the cloned repo)" >&2
  exit 1
fi

# ---- 1. ensure Bun -------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "Bun not found — installing it…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "error: bun still not on PATH after install" >&2; exit 1; }
ok "Bun $(bun --version)"

# ---- 2. install dependencies ---------------------------------------------------
say "Installing dependencies…"
( cd "$DROP_HOME" && (bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1) )
ok "Dependencies installed"

# ---- 3. pick a bin dir on PATH and write the wrapper ---------------------------
choose_bindir() {
  for d in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then echo "$d"; return; fi
  done
  mkdir -p "$HOME/.local/bin" && echo "$HOME/.local/bin"
}
BIN_DIR="$(choose_bindir)"
WRAPPER="$BIN_DIR/drop"

{
  echo '#!/usr/bin/env bash'
  [ -n "$API_DEFAULT" ] && echo ": \"\${DROP_API:=$API_DEFAULT}\"; export DROP_API"
  echo "exec bun run \"$DROP_HOME/bin/drop.ts\" \"\$@\""
} > "$WRAPPER"
chmod +x "$WRAPPER"
ok "Installed: $WRAPPER"

# ---- 4. ensure BIN_DIR is on PATH ----------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac

if [ "$ON_PATH" -eq 0 ]; then
  case "${SHELL:-}" in
    *zsh) RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *) RC="$HOME/.profile" ;;
  esac
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
  if ! grep -qsF "$LINE" "$RC" 2>/dev/null; then
    printf '\n# added by Drop installer\n%s\n' "$LINE" >> "$RC"
    warn "Added $BIN_DIR to PATH in $RC — run: source $RC  (or open a new terminal)"
  fi
fi

# ---- done ----------------------------------------------------------------------
echo
ok "Drop CLI installed."
echo
echo "Next steps:"
if [ -n "$API_DEFAULT" ]; then
  echo "  drop login                       # sign in with Google"
else
  echo "  drop login --api https://api.drop.company.com    # sign in with Google"
  echo "  (or set DROP_API once:  export DROP_API=https://api.drop.company.com)"
fi
echo "  drop publish ./dist myapp        # publish a built folder"
echo "  drop ls                          # list your sites"
echo
[ "$ON_PATH" -eq 0 ] && echo "(open a new terminal first so 'drop' is on your PATH)"
