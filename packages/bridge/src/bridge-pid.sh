#!/bin/zsh
# Shared bridge-process identification, sourced by the start/stop/reset scripts.
#
# These scripts used to identify the daemon by its absolute install path
# ("$root/dist/daemon.js"). That silently broke whenever a daemon was started
# from a different copy of the project — a TPM install and a local checkout,
# say. The mismatched script would not stop the running daemon, but WOULD go on
# to delete its pid/socket/health files, leaving a live daemon that still drove
# the keys and switched panes while the status badge reported it stopped.
#
# Identity is therefore path-independent: any node process running a
# claude-micro bridge daemon counts, wherever it was installed from.

pid_file="${CLAUDE_MICRO_PID:-/private/tmp/claude-micro.pid}"
socket="${CLAUDE_MICRO_SOCKET:-/private/tmp/claude-micro.sock}"
health_file="${CLAUDE_MICRO_HEALTH:-/private/tmp/claude-micro-health.json}"
device_lock="${CLAUDE_MICRO_DEVICE_LOCK:-/private/tmp/claude-micro-device.lock}"

is_bridge_pid() {
  local pid="$1"
  [[ "$pid" == <-> ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  # daemon.mjs matches the 0.1.x runtime too, so an upgrade can still stop it.
  [[ "$command" == *claude-micro*daemon.js* || "$command" == *claude-micro*daemon.mjs* ]]
}

# Every pid that might be a running bridge: the launcher's pid file, plus the
# device lock the daemon writes for itself (authoritative when the pid file is
# stale or was written by a different install).
bridge_pids() {
  # Accumulated as a padded string rather than an array: these scripts run
  # under `set -u`, where subscripting an empty array is itself an error.
  local found=" "
  local candidate
  for candidate in ${(f)"$(cat "$pid_file" "$device_lock" 2>/dev/null)"}; do
    candidate="${candidate//[[:space:]]/}"
    if [[ -z "$candidate" ]]; then
      continue
    fi
    if [[ "$found" == *" $candidate "* ]]; then
      continue
    fi
    if is_bridge_pid "$candidate"; then
      found="${found}${candidate} "
    fi
  done
  if [[ -n "${found// /}" ]]; then
    print -l -- ${=found}
  fi
}
