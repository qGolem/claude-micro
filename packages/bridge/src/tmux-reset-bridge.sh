#!/bin/zsh
set -eu

root="${0:A:h:h}"
source "${0:A:h}/bridge-pid.sh"

for pid in ${(f)"$(bridge_pids)"}; do
  [[ -n "$pid" ]] || continue
  kill "$pid" 2>/dev/null || continue
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
done

if [[ -n "$(bridge_pids)" ]]; then
  print -u2 "claude-micro: a bridge did not stop; refusing to start a second one"
  exit 1
fi

rm -f "$pid_file" "$socket" "$health_file" "$device_lock"
exec "${0:A:h}/tmux-start-bridge.sh"
