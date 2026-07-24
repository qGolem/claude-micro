#!/bin/zsh
set -eu

root="${0:A:h:h}"
pid_file="/private/tmp/claude-micro.pid"
socket="/private/tmp/claude-micro.sock"

if [[ -f "$pid_file" ]]; then
  pid="$(<"$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
fi

rm -f "$pid_file" "$socket"
exec "$root/src/tmux-start-bridge.sh"
