# Claude Micro tmux plugin

macOS tmux integration for the Work Louder / OpenAI Codex Micro and Claude Code.
It keeps the six frosted Agent keys in sync with up to six Claude sessions,
focuses the matching tmux pane when an Agent key is pressed, and turns the
joystick into arrow-key navigation.

It uses the Micro's vendor HID interface. It does not flash firmware or modify
Work Louder Input layers.

## Requirements

- macOS, Node.js 22+, tmux, and Claude Code
- A wired Codex Micro
- **Input Monitoring** enabled for the terminal app that runs tmux (usually
  iTerm) in **System Settings → Privacy & Security → Input Monitoring**

## Install

```sh
git clone <your-repository-url> claude-micro
cd claude-micro
npm install
npm run install-plugin
```

The installer copies the runnable plugin to
`~/.config/tmux/plugins/claude-micro`, adds its source line to
`~/.config/tmux/tmux.conf`, ensures `~/.tmux.conf` loads that configuration,
and installs its Claude Code hooks into `~/.claude/settings.json`. Existing
hooks are preserved and the first install creates
`~/.claude/settings.json.before-claude-micro`.

Reload a running tmux server once:

```sh
tmux source-file ~/.config/tmux/tmux.conf
```

Future tmux starts launch the bridge automatically.

## tmux status and reset

The left side of tmux's status line shows a `◈` Micro indicator immediately
after your existing status content:

- green — bridge connected to the Micro
- amber — bridge process is reconnecting
- red — bridge is stopped

Press **Prefix + Shift-R** to restart only the Micro bridge. It does not close
tmux panes or Claude sessions.

## Status lights

| Claude Code event | Frosted Agent-key state |
| --- | --- |
| Session start/end | dim white |
| Prompt submission or regular tool activity | pulsing blue |
| `AskUserQuestion`, permission request, or notification | pulsing amber |
| Stop/completion | solid green |
| Notification containing `error` or `failed` | pulsing red |

Claude Code sends an ordinary notification reading **“Claude is waiting for
your input”** about a minute after a completed session is left idle; that is
why its key becomes amber.

## Controls

The bridge maps the locked Layer 1 vendor controls as follows:

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

The dial click is available to the bridge as `ENC_CLK`; dial rotation remains
owned by the native Codex controller integration.

## Development and diagnostics

```sh
npm test
npm start
```

To audit Claude hook transitions during troubleshooting, set
`CLAUDE_MICRO_HOOK_AUDIT` to a writable file when invoking `src/event.mjs`.
Normal operation does not retain hook payloads or prompt contents.

The bridge logs to `/private/tmp/claude-micro.log`; current slot assignments
are in `/private/tmp/claude-micro-slots.json`.
