#!/bin/zsh
set -eu

root="${0:A:h:h}"
pid_file="${CLAUDE_MICRO_PID:-/private/tmp/claude-micro.pid}"
socket="${CLAUDE_MICRO_SOCKET:-/private/tmp/claude-micro.sock}"
health_file="${CLAUDE_MICRO_HEALTH:-/private/tmp/claude-micro-health.json}"
log_file="${CLAUDE_MICRO_LOG:-/private/tmp/claude-micro.log}"

is_bridge_pid() {
  local pid="$1"
  [[ "$pid" == <-> ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  [[ "$command" == *"$root/src/daemon.mjs"* ]]
}

if [[ -f "$pid_file" ]]; then
  pid="$(<"$pid_file")"
  if is_bridge_pid "$pid"; then
    exit 0
  fi
fi

if [[ ! -d "$root/node_modules/node-hid" ]]; then
  print -u2 "claude-micro: dependencies missing; run 'npm install' in $root"
  exit 1
fi

node_bin="${CLAUDE_MICRO_NODE:-$(command -v node)}"
[[ -n "$node_bin" ]] || { print -u2 "claude-micro: Node.js was not found"; exit 1; }
rm -f "$pid_file" "$socket" "$health_file"
nohup "$node_bin" "$root/src/daemon.mjs" >>"$log_file" 2>&1 &
echo $! > "$pid_file"
