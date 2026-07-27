// src/event.ts
import fs from "fs";
import net from "net";
var socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
var auditPath = process.env.CLAUDE_MICRO_HOOK_AUDIT;
if (!fs.existsSync(socketPath)) process.exit(0);
var body = "";
for await (const chunk of process.stdin) body += chunk;
if (!body.trim()) process.exit(0);
try {
  const event = JSON.parse(body);
  if (process.env.TMUX_PANE) event.tmux_pane = process.env.TMUX_PANE;
  const notification = typeof event.message === "string" ? event.message.slice(0, 300) : void 0;
  if (auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      hook: event.hook_event_name,
      sessionId: event.session_id,
      tool: event.tool_name,
      notification,
      tmuxPane: event.tmux_pane
    })}
`);
  }
  body = JSON.stringify(event);
} catch {
}
var timeoutMs = Number(process.env.CLAUDE_MICRO_HOOK_TIMEOUT_MS ?? 1500);
var client = net.createConnection(socketPath);
var response = "";
var finished = false;
var timeout = setTimeout(() => finish(new Error(`bridge did not respond within ${timeoutMs}ms`)), timeoutMs);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  client.destroy();
  if (!error) return;
  const code = error.code;
  if (code === "ECONNREFUSED" || code === "ENOENT") process.exit(0);
  console.error(`Claude Micro bridge unavailable: ${error.message}`);
  process.exitCode = 1;
}
client.on("connect", () => client.end(body));
client.setEncoding("utf8");
client.on("data", (data) => response += data);
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
