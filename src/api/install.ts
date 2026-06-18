/**
 * The `curl <API>/install.sh | sh` installer, served by the deployed API and
 * templated with that instance's own URL. It is self-contained: it downloads the
 * CLI bundles this same API serves at /cli/*.mjs, installs `node` wrappers on the
 * user's PATH, and auto-configures the API URL — no npm, git, or external repo.
 * Only the API URL is interpolated; everything else is literal POSIX sh.
 */
export function installScript(apiUrl: string): string {
  return `#!/bin/sh
# Drop CLI installer — installs a self-contained CLI from this Drop instance and
# points it at ${apiUrl}.   Usage:  curl -fsSL ${apiUrl}/install.sh | sh
set -eu

API="${apiUrl}"
LIB="$HOME/.drop/lib"
BIN="$HOME/.local/bin"
CFG="$HOME/.config/drop"

command -v node >/dev/null 2>&1 || { echo "drop: Node.js is required (https://nodejs.org) — install Node 18+ and re-run." >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1";
  else echo "drop: need curl or wget" >&2; exit 1; fi
}

echo "drop: installing from $API"
mkdir -p "$LIB" "$BIN" "$CFG"
fetch "$API/cli/drop.mjs" "$LIB/drop.mjs"
fetch "$API/cli/mcp.mjs"  "$LIB/mcp.mjs"

# tiny wrappers on PATH (single-quoted printf format keeps "$@" literal in the file)
printf '#!/bin/sh\\nexec node "%s/drop.mjs" "$@"\\n' "$LIB" > "$BIN/drop"
printf '#!/bin/sh\\nexec node "%s/mcp.mjs" "$@"\\n'  "$LIB" > "$BIN/drop-mcp"
chmod +x "$BIN/drop" "$BIN/drop-mcp"

# auto-configure the control-plane URL (so 'drop login' / 'drop publish' just work)
printf '{ "apiBase": "%s" }\\n' "$API" > "$CFG/config.json"
chmod 600 "$CFG/config.json"

# make sure the bin dir is on PATH for future shells
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] || continue
      grep -q "drop CLI (added by install.sh)" "$rc" 2>/dev/null && continue
      printf '\\n# drop CLI (added by install.sh)\\nexport PATH="%s:$PATH"\\n' "$BIN" >> "$rc"
    done
    echo "drop: added $BIN to PATH — restart your shell to use 'drop'"
    ;;
esac

echo "drop: installed -> $BIN/drop   (API: $API)"
echo "drop: next -> drop login    (then: drop publish ./dist myapp)"
`;
}
