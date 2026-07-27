#!/bin/zsh
# Fetches the prebuilt native dependency from GitHub Releases.
#
# NOT a user-facing install script: the tmux entrypoint runs this automatically
# in the background when the dependency is missing, and starts the bridge when
# it completes. TPM has no install hook, so this is how the plugin provisions
# itself rather than asking you to run a package manager inside its directory.
set -euo pipefail

root="${0:A:h:h}"                       # packages/bridge
repo="${CLAUDE_MICRO_REPO:-qGolem/claude-micro}"
base_url="${CLAUDE_MICRO_VENDOR_BASE_URL:-}"
target="$root/node_modules"
lock_dir="${TMPDIR:-/private/tmp}/claude-micro-vendor.lock"

notify() {
  print -- "claude-micro: $1"
  if command -v tmux >/dev/null 2>&1; then
    tmux display-message "Claude Micro: $1" 2>/dev/null || :
  fi
}

fail() {
  notify "$1"
  notify "install manually instead: pnpm install --dir ${root:h:h}"
  exit 1
}

# Only one provisioning run at a time: tmux may source its config repeatedly
# (new sessions, reloads) and each pass would otherwise start its own download.
# mkdir is atomic, so this is a race-free mutex.
#
# A run killed outright (SIGKILL, a reboot mid-download) cannot clean up after
# itself, so an old lock is treated as abandoned rather than blocking every
# future attempt.
if [[ -d "$lock_dir" ]]; then
  if [[ -z "$(find "$lock_dir" -maxdepth 0 -mmin -10 2>/dev/null)" ]]; then
    rmdir "$lock_dir" 2>/dev/null || :
  fi
fi
if ! mkdir "$lock_dir" 2>/dev/null; then
  print -- "claude-micro: another provisioning run is in progress"
  exit 0
fi
cleanup() { rmdir "$lock_dir" 2>/dev/null || :; }
trap cleanup EXIT INT TERM

if [[ -d "$target/node-hid" ]]; then
  print -- "claude-micro: dependency already present"
  exit 0
fi

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  *) fail "unsupported platform $(uname -s); this bridge is macOS-only" ;;
esac
case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# Fetch the bundle matching this checkout's version, so a plugin update and its
# native dependency can never drift apart.
version="$(node -p "require('$root/package.json').version" 2>/dev/null || echo "")"
tag="${CLAUDE_MICRO_VENDOR_TAG:-v$version}"
asset="claude-micro-vendor-${platform}-${arch}.tar.gz"
[[ -n "$base_url" ]] || base_url="https://github.com/$repo/releases/download/$tag"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; rmdir "$lock_dir" 2>/dev/null || :; }

notify "fetching $asset ($tag)…"
if ! curl --fail --silent --show-error --location --retry 3 --retry-delay 1 \
     --max-time 120 --output "$work/$asset" "$base_url/$asset" 2>"$work/curl.err"; then
  fail "could not download $asset — $(head -1 "$work/curl.err" 2>/dev/null)"
fi

# Verify before unpacking: this is a binary fetched over the network and then
# loaded into the daemon's process.
if curl --fail --silent --location --max-time 30 \
     --output "$work/$asset.sha256" "$base_url/$asset.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$work/$asset.sha256")"
  actual="$(shasum -a 256 "$work/$asset" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    fail "checksum mismatch for $asset (expected $expected, got $actual)"
  fi
else
  fail "no published checksum for $asset; refusing to install an unverified binary"
fi

tar -xzf "$work/$asset" -C "$work" || fail "could not unpack $asset"
[[ -d "$work/node_modules/node-hid" ]] || fail "$asset did not contain node-hid"

# Confirm the module actually loads on this machine before declaring success —
# a wrong-architecture binary would otherwise fail later, at daemon start.
if ! (cd "$work" && node -e 'require("node-hid").devices' >/dev/null 2>&1); then
  fail "the downloaded build does not load on this machine"
fi

mkdir -p "$target"
for module in "$work"/node_modules/*(N); do
  rm -rf "$target/${module:t}"
  mv "$module" "$target/${module:t}"
done

notify "dependency installed; starting the bridge"
# Release the lock explicitly: exec replaces this process, so the EXIT trap
# would never fire and the lock would block every later run.
cleanup
trap - EXIT INT TERM
exec "${0:A:h}/tmux-start-bridge.sh"
