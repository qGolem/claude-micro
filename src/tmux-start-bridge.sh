#!/bin/zsh
set -eu

root="${0:A:h:h}"
pid_file="/private/tmp/claude-micro.pid"
socket="/private/tmp/claude-micro.sock"
log_file="/private/tmp/claude-micro.log"

if [[ -f "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null; then
  exit 0
fi

rm -f "$pid_file" "$socket"
nohup /usr/bin/env node "$root/src/daemon.mjs" >>"$log_file" 2>&1 &
echo $! > "$pid_file"
