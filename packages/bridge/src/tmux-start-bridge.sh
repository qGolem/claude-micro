#!/bin/zsh
set -eu

root="${0:A:h:h}"
pid_file="${CLAUDE_MICRO_PID:-/private/tmp/claude-micro.pid}"
socket="${CLAUDE_MICRO_SOCKET:-/private/tmp/claude-micro.sock}"
health_file="${CLAUDE_MICRO_HEALTH:-/private/tmp/claude-micro-health.json}"
# Logging is opt-in: set CLAUDE_MICRO_LOG to a path to capture daemon output.
# Left unset, the daemon runs silent — its state is still visible in the health
# file and the tmux status badge.
log_file="${CLAUDE_MICRO_LOG:-}"

is_bridge_pid() {
  local pid="$1"
  [[ "$pid" == <-> ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  [[ "$command" == *"$root/dist/daemon.js"* ]]
}

if [[ -f "$pid_file" ]]; then
  pid="$(<"$pid_file")"
  if is_bridge_pid "$pid"; then
    exit 0
  fi
fi

if [[ ! -d "$root/node_modules/node-hid" || ! -f "$root/dist/daemon.js" ]]; then
  print -u2 "claude-micro: dependencies or build missing; run 'pnpm install' in ${root:h:h}"
  exit 1
fi

node_bin="${CLAUDE_MICRO_NODE:-$(command -v node)}"
[[ -n "$node_bin" ]] || { print -u2 "claude-micro: Node.js was not found"; exit 1; }

rm -f "$pid_file" "$socket" "$health_file"

if [[ -n "$log_file" ]]; then
  # A shell append has no cap of its own, so a long-lived install would grow it
  # forever. Keep one previous generation and start fresh past the limit.
  log_max_bytes="${CLAUDE_MICRO_MAX_LOG_BYTES:-8388608}"
  if [[ -f "$log_file" ]]; then
    log_size="$(wc -c < "$log_file" | tr -d ' ')"
    if [[ "$log_size" == <-> ]] && (( log_size > log_max_bytes )); then
      mv -f "$log_file" "$log_file.1" 2>/dev/null || : > "$log_file"
    fi
  fi
  nohup "$node_bin" "$root/dist/daemon.js" >>"$log_file" 2>&1 &
else
  nohup "$node_bin" "$root/dist/daemon.js" >/dev/null 2>&1 &
fi
echo $! > "$pid_file"
