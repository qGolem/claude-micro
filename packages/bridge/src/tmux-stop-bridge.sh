#!/bin/zsh
set -eu

root="${0:A:h:h}"
pid_file="${CLAUDE_MICRO_PID:-/private/tmp/claude-micro.pid}"
socket="${CLAUDE_MICRO_SOCKET:-/private/tmp/claude-micro.sock}"
health_file="${CLAUDE_MICRO_HEALTH:-/private/tmp/claude-micro-health.json}"

# A stale pid file is the normal state after a crash or reboot, and PIDs are
# reused — so never signal a process without confirming it is this bridge.
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
    kill "$pid"
    for _ in {1..50}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      print -u2 "claude-micro: bridge did not stop"
      exit 1
    fi
  fi
fi

rm -f "$pid_file" "$socket" "$health_file"
