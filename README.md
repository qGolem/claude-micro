# Claude Micro tmux plugin

macOS integration for the Work Louder / OpenAI Codex Micro, Claude Code, and
tmux. It gives six Claude sessions live Agent-key lighting, focuses the matching
tmux pane from a frosted key, and maps the Micro controls to the active pane.

The HID bridge is written in Node.js; the tmux interface is a conventional
tmux plugin entrypoint with options, a status format, health reporting, and
safe install/update/uninstall commands.

## Requirements

- macOS, Node.js 20+, tmux, Claude Code, and iTerm2
- Wired Codex Micro
- **Input Monitoring** for iTerm:
  **System Settings → Privacy & Security → Input Monitoring**

The pane-focus feature uses iTerm's AppleScript API to find the correct tmux
client across windows. Grant its macOS Automation prompt if one appears. Other
terminals can still use the lighting and active-pane controls, but do not get
cross-window Agent-key focus.

## Install

```sh
git clone <repository-url> claude-micro
cd claude-micro
npm install
npm run install-plugin
tmux source-file ~/.config/tmux/tmux.conf
```

The installer copies a self-contained runtime to
`~/.config/tmux/plugins/claude-micro`, installs Claude Code hooks, and manages
only its marked block in `~/.config/tmux/tmux.conf`. It creates one backup of
that config and of pre-existing Claude settings.

Re-run `npm run install-plugin` to update an existing installation. It is
idempotent: unrelated tmux configuration and status settings are preserved.

## Status module

The plugin publishes a tmux command named `#{@claude_micro_status_command}`.
Wrap it in tmux's `#(...)` syntax wherever your theme places status modules;
it does not replace `status-left` or change your theme refresh interval.

For a plain tmux status line, add this after the plugin entrypoint:

```tmux
set -ag status-left ' #(#{@claude_micro_status_command})'
```

If a theme rebuilds `status-left` and you prefer automatic placement, opt in:

```tmux
set -g @claude_micro_auto_status 'on'
```

It appends the module once after your theme has loaded; it never replaces the
existing value.

Place it after your Pomodoro module to keep the Micro badge beside it. The
badge is green when connected; amber/red shows `↻ k` when reconnecting/stopped.
Press **Prefix + k** to reset only the bridge.

## Configuration

Set options before the plugin entrypoint in your tmux config.

```tmux
# Default: k. Any unused tmux key is accepted.
set -g @claude_micro_reset_key 'k'

# Default: on. Set off if you do not use the Meta-1 through Meta-6 focus keys.
set -g @claude_micro_slot_bindings 'on'

# Default: off. Append the status module once without replacing status-left.
set -g @claude_micro_auto_status 'off'

# Optional: absolute Node executable for tmux servers with a restricted PATH.
set -g @claude_micro_node '/absolute/path/to/node'
```

The installer records its current Node path automatically. Override it only if
you intentionally use a different Node installation.

## Controls

| Physical control | Action in active tmux pane |
| --- | --- |
| Frosted Agent keys 1–6 | focus their assigned Claude pane |
| Third-row left | Ctrl+S |
| Third-row middle-left | Ctrl+W |
| Third-row middle-right | `daw` (Vim motion) |
| Third-row right | Return |
| Dial press | Escape |
| Dial turn left / right | Left / Right arrow |
| Bottom Whisperflow key | right Command (for Whisperflow) |
| Bottom-right | Ctrl+C |
| Joystick flick | corresponding arrow key |

## Agent key states

| Claude Code event | Frosted Agent-key state |
| --- | --- |
| Session start/end | dim white |
| Prompt submission or regular tool activity | pulsing blue |
| `AskUserQuestion`, permission request, or notification | pulsing amber |
| Stop/completion | solid green |
| Notification containing `error` or `failed` | pulsing red |

Claude Code sends an ordinary **“Claude is waiting for your input”** notification
about a minute after a completed session is left idle. That is why a finished
key can become amber.

## Diagnostics and recovery

```sh
npm run doctor
```

`doctor` checks Node, tmux, the vendor HID interface, installed Claude hooks,
the bridge health record, and socket reachability.

- If the badge shows `↻ k`, press **Prefix + k**.
- Disconnect/reconnect the Micro: the bridge retries automatically.
- The bridge restores active session-to-key assignments from its state file
  after a bridge restart.
- To collect temporary protocol traces, start it with
  `CLAUDE_MICRO_DEBUG_DIR=/private/tmp/claude-micro-debug`. Normal operation
  does not retain raw HID reports.
- Agent-key focus usually takes about 0.3 seconds because macOS must bring the
  matching iTerm window forward. The Micro-to-bridge part is about 30 ms.

## Uninstall

```sh
npm run uninstall-plugin
```

This removes only the managed tmux block and the plugin’s Claude hooks, then
stops the bridge. Restart tmux to clear its already-loaded key binding. The
plugin directory is left in place deliberately so removal is recoverable.

## Development

```sh
npm run verify
npm run doctor
npm start
```

Tests cover protocol encoding, hook state mapping, restart slot restoration,
the reset safety guard, and a clean install/reinstall/uninstall cycle. GitHub
Actions runs the same verification on clean macOS runners with Node 20 and 22.
