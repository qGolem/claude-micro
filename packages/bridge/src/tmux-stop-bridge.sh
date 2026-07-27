#!/bin/zsh
set -eu

root="${0:A:h:h}"
source "${0:A:h}/bridge-pid.sh"

stopped=0
for pid in ${(f)"$(bridge_pids)"}; do
  [[ -n "$pid" ]] || continue
  kill "$pid" 2>/dev/null || continue
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    print -u2 "claude-micro: bridge $pid did not stop"
  else
    stopped=$((stopped + 1))
  fi
done

# Never clear state while a bridge is still alive: doing that is what produced
# a running daemon with no socket, still switching panes behind a badge that
# claimed it was stopped.
remaining="$(bridge_pids)"
if [[ -n "$remaining" ]]; then
  print -u2 "claude-micro: still running (${remaining//$'\n'/, }); leaving state files in place"
  exit 1
fi

rm -f "$pid_file" "$socket" "$health_file" "$device_lock"

# Bound to a key, so say something — a silent stop is indistinguishable from a
# binding that did not fire. Skipped when there is no tmux server (the legacy
# cleanup path also runs this script).
if command -v tmux >/dev/null 2>&1; then
  if (( stopped > 0 )); then
    tmux display-message "Claude Micro: bridge stopped." 2>/dev/null || :
  else
    tmux display-message "Claude Micro: no bridge was running." 2>/dev/null || :
  fi
fi
