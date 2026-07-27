import fs from "node:fs";
import net from "node:net";

const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const auditPath = process.env.CLAUDE_MICRO_HOOK_AUDIT;
// The hooks and the tmux bridge install independently. A bridge that is not
// running is a normal state, not an error worth surfacing on every hook.
if (!fs.existsSync(socketPath)) process.exit(0);
let body = "";
for await (const chunk of process.stdin) body += chunk;
if (!body.trim()) process.exit(0);

// Claude hooks inherit TMUX_PANE. Preserve it so the matching frosted key can
// focus this exact pane later through tmux.
try {
  const event = JSON.parse(body) as Record<string, unknown>;
  if (process.env.TMUX_PANE) event.tmux_pane = process.env.TMUX_PANE;
  // Diagnostic trail for understanding lifecycle transitions. Do not record
  // prompt bodies; notification text is capped because it explains why an
  // otherwise-idle session was surfaced.
  const notification = typeof event.message === "string" ? event.message.slice(0, 300) : undefined;
  // Opt-in audit trail, capped so a long-lived session cannot fill the disk.
  // Each hook is a fresh process, so the size is checked rather than tracked.
  const auditCapBytes = Number(process.env.CLAUDE_MICRO_MAX_AUDIT_BYTES ?? 16 * 1024 * 1024);
  let auditedBytes = 0;
  try {
    auditedBytes = auditPath ? fs.statSync(auditPath).size : 0;
  } catch {
    auditedBytes = 0;
  }
  if (auditPath && auditedBytes < auditCapBytes) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      at: new Date().toISOString(),
      hook: event.hook_event_name,
      sessionId: event.session_id,
      tool: event.tool_name,
      notification,
      tmuxPane: event.tmux_pane,
    })}\n`);
  }
  body = JSON.stringify(event);
} catch {
  // Let the daemon report malformed hook payloads in its normal response.
}

const timeoutMs = Number(process.env.CLAUDE_MICRO_HOOK_TIMEOUT_MS ?? 1_500);
const client = net.createConnection(socketPath);
let response = "";
let finished = false;
const timeout = setTimeout(() => finish(new Error(`bridge did not respond within ${timeoutMs}ms`)), timeoutMs);

function finish(error?: Error): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  client.destroy();
  if (!error) return;
  // A daemon killed by anything other than SIGINT/SIGTERM leaves its socket
  // file behind, so the existsSync check above passes and we land here on
  // every hook. That is the same "bridge is not running" state the check
  // exists to keep quiet — and the tmux status badge already reports it
  // actionably ("↻ k"), so an error per tool call adds noise, not signal.
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ENOENT") process.exit(0);
  console.error(`Claude Micro bridge unavailable: ${error.message}`);
  process.exitCode = 1;
}

client.on("connect", () => client.end(body));
client.setEncoding("utf8");
client.on("data", (data: string) => (response += data));
client.on("end", () => {
  try {
    const result = JSON.parse(response) as { ok?: boolean; error?: string };
    if (!result?.ok) throw new Error(result?.error ?? "bridge rejected the hook event");
    finish();
  } catch (error) {
    finish(error as Error);
  }
});
client.on("error", finish);
