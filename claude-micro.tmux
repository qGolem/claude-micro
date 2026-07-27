#!/usr/bin/env bash
# Claude Micro tmux plugin entrypoint (TPM-compatible).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

option() {
  tmux show-option -gqv "$1"
}

node_bin="$(option @claude_micro_node)"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  node_bin="${CLAUDE_MICRO_NODE:-$(command -v node || true)}"
fi
if [[ -z "$node_bin" ]]; then
  tmux display-message "claude-micro: Node.js not found — set @claude_micro_node to an absolute Node path"
  exit 0
fi

bridge_root="$root/packages/bridge"

# dist/ is committed, so a checkout without it is broken rather than merely
# unprovisioned — there is nothing to fetch that would fix it.
if [[ ! -f "$bridge_root/dist/daemon.js" ]]; then
  tmux display-message "claude-micro: build missing at $bridge_root/dist — reinstall the plugin"
  exit 0
fi

reset_key="$(option @claude_micro_reset_key)"
reset_key="${reset_key:-k}"
stop_key="$(option @claude_micro_stop_key)"
stop_key="${stop_key:-K}"
slot_bindings="$(option @claude_micro_slot_bindings)"
slot_bindings="${slot_bindings:-on}"
auto_status="$(option @claude_micro_auto_status)"
auto_status="${auto_status:-off}"
# Fetching the native dependency is an explicit action, not something a config
# reload does behind you: the entrypoint runs on every tmux server start, TPM
# discards its output so a failure would be invisible, and downloading a binary
# that gets loaded into a long-running daemon is a decision worth making
# deliberately. Set to 'on' for zero-touch provisioning instead.
auto_vendor="$(option @claude_micro_auto_vendor)"
auto_vendor="${auto_vendor:-off}"
vendor_key="$(option @claude_micro_vendor_key)"
vendor_key="${vendor_key:-V}"

# Public status command.  Tmux does not recursively expand a #() command stored
# inside a user option, so themes must wrap this value in their own #(...).
status_command="$node_bin $bridge_root/dist/tmux-status.js"
status_format="#($status_command)"
tmux set-option -g @claude_micro_status_command "$status_command"
# The native dependency cannot ship in the repo (it is a compiled binary) and
# TPM has no install hook, so it is fetched from GitHub Releases — on request,
# not on load. display-message rather than print: TPM runs this file with its
# output discarded, so printing would say nothing to anyone.
if [[ -d "$bridge_root/node_modules/node-hid" ]]; then
  tmux run-shell -b "$bridge_root/src/tmux-start-bridge.sh"
elif [[ "$auto_vendor" == "on" ]]; then
  tmux run-shell -b "$bridge_root/src/vendor-deps.sh"
else
  tmux display-message "Claude Micro: device driver not installed — press Prefix + $vendor_key to install it"
fi
tmux bind-key -N "Restart Claude Micro bridge" "$reset_key" run-shell -b "$bridge_root/src/tmux-reset-bridge.sh"
# Stopping is deliberately a separate binding from restarting: the bridge holds
# the HID device, so there has to be a way to release it without a restart
# putting it straight back. Shifted by default, next to the reset key.
if [[ "$stop_key" != "off" ]]; then
  tmux bind-key -N "Stop Claude Micro bridge" "$stop_key" run-shell -b "$bridge_root/src/tmux-stop-bridge.sh"
fi
# Bound whether or not the dependency is missing, so it is discoverable in the
# key list and safe to press twice — the provisioner exits early if the driver
# is already installed.
if [[ "$vendor_key" != "off" ]]; then
  tmux bind-key -N "Install the Claude Micro device driver" "$vendor_key" run-shell -b "$bridge_root/src/vendor-deps.sh"
fi

if [[ "$auto_status" == "on" ]]; then
  status_left="$(tmux show-option -gqv status-left)"
  # Replace the format published by versions 0.1.x; tmux displays it literally.
  status_left="${status_left//\#\{\@claude_micro_status\}/}"
  if [[ "$status_left" != *"$status_format"* ]]; then
    tmux set-option -g status-left "$status_left $status_format"
  fi
fi

if [[ "$slot_bindings" != "off" ]]; then
  for slot in 0 1 2 3 4 5; do
    tmux bind-key -n -N "Focus Claude Micro slot $((slot + 1))" "M-$((slot + 1))" run-shell "$node_bin $bridge_root/dist/focus-slot.js $slot"
  done
fi
