#!/usr/bin/env bash
# Update the WorkPulse extension in place, keeping everything it has saved:
#
#   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash -s -- --dir "/path/you/loaded"
#
# Chrome keeps an unpacked extension's data as long as the folder it loads from
# stays the same, so this replaces the files *inside* that folder with the latest
# release and leaves the folder where it is. Then press Reload in WorkPulse (or
# the ↻ on chrome://extensions). Never Remove the extension to update it: that
# deletes its data.
#
# The folder is --dir, or the one used last time (~/.config/workpulse/extension-dir),
# or ~/WorkPulse/extension. A folder that already has files must hold WorkPulse
# (its manifest says so); anything else is refused, never emptied. The version
# before is kept beside it as <folder>.previous.
#
# --version 1.4.0 picks a release instead of the latest; --check only says what
# would happen.
set -euo pipefail

REPO="myind-ai/workpulse-extension"
REMEMBER="${XDG_CONFIG_HOME:-$HOME/.config}/workpulse/extension-dir"
# The extension's fixed public key: the same key is the same extension ID, so the
# same saved data. A zip without it is not this extension.
KEY_START="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsEMgIrMCTjjk2d0cKuzvzojUtN3Z0jC"

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
ok() { printf '✓ %s\n' "$1"; }

DIR=""
WANT=""
CHECK=0
while [ $# -gt 0 ]; do
	case "$1" in
		--dir) DIR="${2:-}"; shift 2 ;;
		--version) WANT="${2#v}"; shift 2 ;;
		--check) CHECK=1; shift ;;
		-h|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
		*) fail "Unknown option: $1 (use --dir, --version or --check)" ;;
	esac
done
[ -n "$DIR" ] || { [ -r "$REMEMBER" ] && DIR="$(cat "$REMEMBER")"; } || true
[ -n "$DIR" ] || DIR="$HOME/WorkPulse/extension"
DIR="${DIR%/}"
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac

command -v curl >/dev/null || fail "curl is needed."
command -v unzip >/dev/null || fail "unzip is needed."

version_in() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' "$1" | head -1; }

# What is there now. An empty or missing folder is a first install.
HAVE=""
if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
	[ -f "$DIR/manifest.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"WorkPulse' "$DIR/manifest.json" \
		|| fail "$DIR has files but no WorkPulse manifest.json. Pass --dir with the folder you chose in Load unpacked."
	HAVE="$(version_in "$DIR/manifest.json")"
fi

# Which release, and its zip.
if [ -n "$WANT" ]; then
	API="https://api.github.com/repos/$REPO/releases/tags/v$WANT"
else
	API="https://api.github.com/repos/$REPO/releases/latest"
fi
INFO="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || fail "Could not read the release from GitHub ($API)."
TAG="$(printf '%s' "$INFO" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
LATEST="${TAG#v}"
ZIP_URL="$(printf '%s' "$INFO" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*-chrome\.zip"' | grep -v 'workpulse-extension-chrome\.zip' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$ZIP_URL" ] || ZIP_URL="$(printf '%s' "$INFO" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$LATEST" ] && [ -n "$ZIP_URL" ] || fail "That release has no Chrome zip."

if [ -n "$HAVE" ] && [ "$HAVE" = "$LATEST" ]; then
	ok "WorkPulse $HAVE in $DIR is already the latest."
	exit 0
fi
if [ "$CHECK" = 1 ]; then
	if [ -n "$HAVE" ]; then echo "Would update $HAVE → $LATEST in $DIR (from $ZIP_URL)."; else echo "Would install $LATEST in $DIR (from $ZIP_URL)."; fi
	exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$ZIP_URL" -o "$TMP/wp.zip" || fail "Download failed: $ZIP_URL"
mkdir "$TMP/new"
unzip -q "$TMP/wp.zip" -d "$TMP/new" || fail "The download is not a zip."
# A zip with one top folder: use what is inside it.
if [ ! -f "$TMP/new/manifest.json" ] && [ "$(ls -A "$TMP/new" | wc -l | tr -d ' ')" = 1 ]; then
	INNER="$TMP/new/$(ls -A "$TMP/new")"
	[ -f "$INNER/manifest.json" ] && TMP_NEW="$INNER"
fi
NEW="${TMP_NEW:-$TMP/new}"
[ -f "$NEW/manifest.json" ] || fail "The release zip has no manifest.json."
grep -q "$KEY_START" "$NEW/manifest.json" || fail "The release zip is not this extension (its key differs), so nothing was changed."
GOT="$(version_in "$NEW/manifest.json")"

# Swap: the old files go to <folder>.previous, the new ones into the same folder.
mkdir -p "$(dirname "$DIR")"
if [ -n "$HAVE" ]; then
	rm -rf "$DIR.previous"
	mkdir "$DIR.previous"
	(cd "$DIR" && find . -mindepth 1 -maxdepth 1 -exec mv {} "$DIR.previous/" \;)
else
	mkdir -p "$DIR"
fi
(cd "$NEW" && find . -mindepth 1 -maxdepth 1 -exec mv {} "$DIR/" \;)
mkdir -p "$(dirname "$REMEMBER")"
printf '%s\n' "$DIR" > "$REMEMBER"

if [ -n "$HAVE" ]; then
	ok "WorkPulse $HAVE → $GOT in $DIR (the old files are in $DIR.previous)"
	echo "  Now press Reload on the update notice in WorkPulse, or ↻ on chrome://extensions. Your data stays."
else
	ok "WorkPulse $GOT is in $DIR"
	echo "  First time: chrome://extensions → Developer mode → Load unpacked → pick $DIR"
	echo "  Next time, this same line updates it in place."
fi
