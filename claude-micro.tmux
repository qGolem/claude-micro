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

if [[ ! -d "$root/node_modules/node-hid" ]]; then
  tmux display-message "claude-micro: dependencies missing — run: npm install --prefix $root"
  exit 0
fi

reset_key="$(option @claude_micro_reset_key)"
reset_key="${reset_key:-k}"
slot_bindings="$(option @claude_micro_slot_bindings)"
slot_bindings="${slot_bindings:-on}"
auto_status="$(option @claude_micro_auto_status)"
auto_status="${auto_status:-off}"

# Public status command.  Tmux does not recursively expand a #() command stored
# inside a user option, so themes must wrap this value in their own #(...).
status_command="$node_bin $root/src/tmux-status.mjs"
status_format="#($status_command)"
tmux set-option -g @claude_micro_status_command "$status_command"
tmux run-shell -b "$root/src/tmux-start-bridge.sh"
tmux bind-key -N "Restart Claude Micro bridge" "$reset_key" run-shell -b "$root/src/tmux-reset-bridge.sh"

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
    tmux bind-key -n -N "Focus Claude Micro slot $((slot + 1))" "M-$((slot + 1))" run-shell "$node_bin $root/src/focus-slot.mjs $slot"
  done
fi
