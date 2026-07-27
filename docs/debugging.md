# Debugging the bridge

The commands used to diagnose the July 2026 unplug/Bluetooth incident, kept
for the next one. Everything here is read-only unless marked otherwise; none
of it is needed in normal operation — the daemon runs silent and the status
badge plus `pnpm run doctor` cover the healthy path.

## The runtime files

Five files under `/private/tmp` ARE the bridge's live state — never delete
them while a daemon runs (the stop/reset scripts manage them):

| File | Contents |
| --- | --- |
| `claude-micro.pid` | pid of the daemon the launcher started |
| `claude-micro-device.lock` | pid of the daemon holding the HID device (written by the daemon itself; authoritative) |
| `claude-micro.sock` | unix socket the Claude Code hooks deliver events to |
| `claude-micro-health.json` | `{state, updatedAt, pid}` — what the status badge reads; stale >4 s counts as dead |
| `claude-micro-slots.json` | the six agent-key assignments; persists so a restart restores sessions to their keys |

Everything else matching `/private/tmp/claude-micro*` is opt-in logging or
leftover debugging output and is safe to delete at any time.

## Quick triage

```sh
pnpm --dir ~/.config/tmux/plugins/claude-micro run doctor
```

One failing line usually names the layer. For anything deeper, work through
the layers below in order: process → health → enumeration → traffic.

## Layer 1 — process

Exactly one daemon should exist, and the pid file, device lock, and process
table must agree:

```sh
pgrep -fl "claude-micro.*daemon.js"
cat /private/tmp/claude-micro.pid /private/tmp/claude-micro-device.lock
```

Kill everything and clear the bookkeeping (state-changing):

```sh
pkill -f 'claude-micro.*daemon.js'
rm -f /private/tmp/claude-micro.pid /private/tmp/claude-micro-device.lock
```

## Layer 2 — health over time

The health file shows the daemon's current belief; sampling it catches flaps
that a single read misses:

```sh
for i in $(seq 1 40); do
  python3 -c "import json;d=json.load(open('/private/tmp/claude-micro-health.json'));print(d['state'],d['updatedAt'],d['pid'])"
  sleep 0.5
done | uniq -c
```

A `connected → reconnecting → connected` cycle every few seconds is the
teardown churn signature; `reconnecting` frozen for minutes means reconnect
attempts are failing (or, before the identity watchdog, had given up).

## Layer 3 — what macOS actually sees

```sh
cd ~/.config/tmux/plugins/claude-micro/packages/bridge
node -e 'import("node-hid").then(async(h)=>{const a=await h.devicesAsync();
  console.log(JSON.stringify(a.filter(d=>d.vendorId===0x303a).map(d=>
    ({path:d.path,usagePage:d.usagePage,interface:d.interface,product:d.product})),null,1))})'
```

How to read it:

- `interface: -1` and a `#1`-suffixed product name → **Bluetooth** transport;
  `interface >= 0` → USB.
- The `DevSrvsID:` path is the device's identity for this power cycle. It
  changes on every reboot — unplugging causes one. The daemon compares this
  path against its open handle every 2.5 s and reconnects on mismatch;
  if lighting is frozen while this command shows a different path than the
  daemon connected to, that watchdog is the thing to suspect.
- The vendor RPC interface is `usagePage: 65280`. If it is missing entirely,
  the device is not presenting (re-pair or replug); the bridge cannot help.

## Layer 4 — traffic (opt-in tracing)

Restart the daemon with tracing, always via tmux — see the permission note
below (state-changing):

```sh
tmux run-shell -b "CLAUDE_MICRO_LOG=/private/tmp/claude-micro-diagnose.log \
  CLAUDE_MICRO_DEBUG_DIR=/private/tmp/claude-micro-debug \
  ~/.config/tmux/plugins/claude-micro/packages/bridge/src/tmux-reset-bridge.sh"
```

- `claude-micro-diagnose.log` — daemon stdout/stderr: connect errors, write
  failures, reconnects.
- `claude-micro-debug/hid-raw.log` — one line per **incoming** HID report.
  Press a key: if nothing appends, input is not reaching the daemon and the
  bug is below the bridge (see signatures).
- `claude-micro-debug/hid-keys.log` — parsed key events, one per press.

Confirm the env actually reached the daemon (a restart from the wrong shell
silently drops it):

```sh
ps eww "$(cat /private/tmp/claude-micro.pid)" | tr ' ' '\n' | grep CLAUDE_MICRO
```

When done, restart without the variables and delete the files — and check
tmux's global environment, which silently re-arms tracing on every restart
until unset:

```sh
tmux show-environment -g | grep CLAUDE_MICRO     # should print nothing
tmux set-environment -gu CLAUDE_MICRO_DEBUG_DIR  # if it did
rm -rf /private/tmp/claude-micro-diagnose.log /private/tmp/claude-micro-debug
```

## Live experiment recorder

For unplug/replug testing: emits one line per state change and per burst of
incoming input, so a physical experiment leaves a timestamped record.

```sh
cd ~/.config/tmux/plugins/claude-micro/packages/bridge
prev=""; prevraw=0
while true; do
  H=$(python3 -c "import json;d=json.load(open('/private/tmp/claude-micro-health.json'));print(d['state']+':'+str(d['pid']))" 2>/dev/null)
  ENUM=$(node -e 'import("node-hid").then(async(h)=>{const a=(await h.devicesAsync()).filter(d=>d.vendorId===0x303a);const v=a.find(d=>d.usagePage===0xff00);console.log(a.length+" "+(v?v.path.slice(-6):"none")+" "+(v&&v.interface>=0?"USB":"BT"))})' 2>/dev/null)
  RAW=$(wc -l < /private/tmp/claude-micro-debug/hid-raw.log 2>/dev/null || echo 0)
  STATE="health=$H ifaces=$ENUM"
  [ "$STATE" != "$prev" ] && { echo "$(date +%H:%M:%S) $STATE"; prev="$STATE"; }
  [ "$RAW" -gt "$prevraw" ] && { echo "$(date +%H:%M:%S) input +$((RAW-prevraw)) (total $RAW)"; prevraw=$RAW; }
  sleep 2
done
```

Slot assignments, for checking that a press/hold actually did something:

```sh
python3 -c "import json;[print(s['id'],s['state'],s['tmuxPane'],s['sessionId']) for s in json.load(open('/private/tmp/claude-micro-slots.json'))['slots']]"
```

## Signatures worth remembering

| Symptom | Meaning | Remedy |
| --- | --- | --- |
| LEDs update, key presses produce no `hid-raw.log` lines | Corrupted Bluetooth pairing: output reports delivered, input reports silently dropped. The daemon cannot detect this — writes succeed. | Forget the device in System Settings → Bluetooth and re-pair |
| `hid_open_path … (0xE00002E2) not permitted` | Daemon launched from a context without the Input Monitoring grant. Only starts made through tmux (`prefix + k`, the plugin entrypoint) inherit iTerm/tmux's permission — a daemon started from any other shell comes up blind with no visible error. | Restart via `prefix + k` or `tmux run-shell` |
| `SetReport … not ready` / `general error` bursts in the log | Bluetooth write pressure or a marginal link. The daemon retries and only tears down after 3 consecutive failures. | Usually self-heals; persistent → replug or re-pair |
| Health `connected` but enumeration shows a different `DevSrvsID` | Stale handle after a device reboot. The identity watchdog reconnects within ~2.5 s; if it persists, the deployed plugin predates the watchdog. | Update the plugin (`prefix + U`, `prefix + k`) |
| Device works plugged, dies unplugged, recovers on replug | The full incident this document comes from — some mix of the above. | Work the layers top to bottom |

## Resetting the device

- Unplugging is a power cycle — the device reboots and re-enumerates with a
  new identity (expect one LED flash as the daemon reattaches).
- The deep reset for Bluetooth weirdness: System Settings → Bluetooth →
  forget "Codex Micro", then re-pair. This rebuilt input delivery when
  nothing software-side could.
