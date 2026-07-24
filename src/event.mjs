import fs from "node:fs";
import net from "node:net";

const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const auditPath = process.env.CLAUDE_MICRO_HOOK_AUDIT;
let body = "";
for await (const chunk of process.stdin) body += chunk;
if (!body.trim()) process.exit(0);

// Claude hooks inherit TMUX_PANE. Preserve it so the matching frosted key can
// focus this exact pane later through tmux.
let event;
try {
  event = JSON.parse(body);
  if (process.env.TMUX_PANE) event.tmux_pane = process.env.TMUX_PANE;
  // Diagnostic trail for understanding lifecycle transitions. Do not record
  // prompt bodies; notification text is capped because it explains why an
  // otherwise-idle session was surfaced.
  const notification = typeof event.message === "string" ? event.message.slice(0, 300) : undefined;
  if (auditPath) {
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

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  client.destroy();
  if (error) {
    console.error(`Claude Micro bridge unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}

client.on("connect", () => client.end(body));
client.setEncoding("utf8");
client.on("data", (data) => (response += data));
client.on("end", () => {
  try {
    const result = JSON.parse(response);
    if (!result?.ok) throw new Error(result?.error ?? "bridge rejected the hook event");
    finish();
  } catch (error) {
    finish(error);
  }
});
client.on("error", finish);
