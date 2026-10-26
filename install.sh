#!/usr/bin/env bash
# Link Claude Code on this machine to a WorkPulse Brain, in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash -s -- --repo you/workpulse-notes --branch brain
#
# It checks Node (22.18+), git and the GitHub CLI login, puts the open-source
# CLI and skill in ~/workpulse-extension (or updates them), then runs
# `wp-brain setup`, which asks before it installs anything. Every flag is passed
# on to setup: --repo --branch --device --create --brief --record --rule --skill.
# Re-running it is safe; it is also how you update.
#
# WP_DIR overrides the install folder. Nothing here needs or stores a token: the
# terminal side pushes with your own GitHub login (gh), the extension with its own
# fine-grained token.
set -euo pipefail

SRC="https://github.com/myind-ai/workpulse-extension.git"
DIR="${WP_DIR:-$HOME/workpulse-extension}"

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
ok() { printf '✓ %s\n' "$1"; }

command -v git >/dev/null || fail "git is needed: https://git-scm.com/downloads"
command -v node >/dev/null || fail "Node 22.18 or newer is needed: https://nodejs.org (or: nvm install 24)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
	|| fail "Node $(node -v) is too old; 22.18 or newer is needed (nvm install 24 && nvm use 24)"
ok "Node $(node -v)"

if ! command -v gh >/dev/null; then
	fail "The GitHub CLI is needed to push with your own login: https://cli.github.com, then: gh auth login"
fi
gh auth status >/dev/null 2>&1 || fail "Not signed in to GitHub. Run: gh auth login   (then run this line again)"
gh auth setup-git >/dev/null 2>&1 || true # git pushes over https with the same login
ok "GitHub: $(gh api user --jq .login 2>/dev/null || echo signed in)"

if [ -d "$DIR/.git" ]; then
	git -C "$DIR" pull --ff-only --quiet || fail "Could not update $DIR (local changes?). Fix it or set WP_DIR to a new folder."
	ok "Updated $DIR"
else
	[ -e "$DIR" ] && fail "$DIR exists and is not a clone of $SRC. Move it, or set WP_DIR."
	git clone --quiet --depth 1 "$SRC" "$DIR"
	ok "Installed $DIR"
fi
echo

# Piped from curl, stdin is the script; give setup the terminal so it can ask.
if [ -r /dev/tty ] && [ -t 1 ]; then
	exec node "$DIR/cli/wp-brain.mjs" setup "$@" </dev/tty
else
	exec node "$DIR/cli/wp-brain.mjs" setup "$@"
fi
