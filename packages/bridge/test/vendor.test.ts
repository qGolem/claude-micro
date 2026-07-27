// Covers the self-provisioning path: the plugin fetches its native dependency
// from GitHub Releases on first load, because TPM only clones a repo and has no
// install hook. This downloads a binary that then gets loaded into the daemon's
// process, so the verification failure modes matter as much as the happy path.
//
// A local HTTP server stands in for the release host (CLAUDE_MICRO_VENDOR_BASE_URL),
// and the scratch plugin gets a stub start script so a passing test never
// launches a real daemon against the hardware.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = "claude-micro-vendor-darwin-arm64.tar.gz";

/** Builds a real bundle from the workspace's own node-hid, as CI does. */
function buildBundle(directory: string): string {
  const stage = path.join(directory, "stage", "node_modules");
  fs.mkdirSync(stage, { recursive: true });
  const nodeHid = fs.realpathSync(path.join(root, "node_modules", "node-hid"));
  fs.cpSync(nodeHid, path.join(stage, "node-hid"), { recursive: true });
  for (const dependency of ["pkg-prebuilds", "node-addon-api"]) {
    const resolved = fs.realpathSync(path.join(nodeHid, "..", dependency));
    fs.cpSync(resolved, path.join(stage, dependency), { recursive: true });
  }
  // Keep only this machine's prebuild, matching the release layout.
  const prebuilds = path.join(stage, "node-hid", "prebuilds");
  const keep = process.arch === "arm64" ? "HID-darwin-arm64" : "HID-darwin-x64";
  for (const entry of fs.readdirSync(prebuilds)) {
    if (entry !== keep) fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
  }
  const asset = path.join(directory, ASSET);
  execFileSync("tar", ["-czf", asset, "-C", path.join(directory, "stage"), "node_modules"]);
  return asset;
}

// node-hid is ~6 MB, so build the bundle once and share it: doing it per test
// dominated the runtime.
let cachedBundle: string | undefined;
let cachedBundleDirectory: string | undefined;
function sharedBundle(): string {
  if (!cachedBundle) {
    cachedBundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-bundle-"));
    cachedBundle = buildBundle(cachedBundleDirectory);
  }
  return cachedBundle;
}
after(() => {
  if (cachedBundleDirectory) fs.rmSync(cachedBundleDirectory, { recursive: true, force: true });
});

/** Serves the release assets, with hooks to corrupt or withhold them. */
async function startReleaseServer(assetPath: string, options: { tamper?: boolean; withholdChecksum?: boolean } = {}) {
  const bytes = fs.readFileSync(assetPath);
  const served = options.tamper ? Buffer.concat([bytes, Buffer.from("tampered")]) : bytes;
  const checksum = `${crypto.createHash("sha256").update(bytes).digest("hex")}  ${ASSET}\n`;
  // Exact paths, not suffixes: a suffix match would also serve requests for a
  // wrong release path, which is precisely what the missing-release case tests.
  const server = http.createServer((request, response) => {
    if (request.url === `/${ASSET}.sha256`) {
      if (options.withholdChecksum) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200).end(checksum);
      return;
    }
    if (request.url === `/${ASSET}`) {
      response.writeHead(200).end(served);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    // close() alone only stops accepting: curl's keep-alive sockets stay open
    // and hold the event loop, so the test process never exits. Drop them and
    // unref so a stray handle can never wedge the run.
    close: () => {
      server.closeAllConnections();
      server.close();
      server.unref();
    },
  };
}

/** A plugin checkout with no node_modules, and a start script that cannot launch a daemon. */
function scratchPlugin(directory: string): string {
  const bridge = path.join(directory, "plugin", "packages", "bridge");
  fs.mkdirSync(bridge, { recursive: true });
  fs.cpSync(path.join(root, "src"), path.join(bridge, "src"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(bridge, "package.json"));
  fs.writeFileSync(
    path.join(bridge, "src", "tmux-start-bridge.sh"),
    `#!/bin/zsh\nprint started > '${path.join(directory, "started")}'\n`,
    { mode: 0o755 },
  );
  return bridge;
}

/**
 * Runs the provisioner and returns its output.
 *
 * Asynchronous on purpose. The release server under test runs in THIS process,
 * so a synchronous child (execFileSync/spawnSync) would block the event loop
 * and the server could never answer curl — the run deadlocks until curl's own
 * timeout, which is far longer than anyone waits for a test suite.
 */
function provision(bridge: string, baseUrl: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const sandbox = path.join(bridge, "..", "..", "..");
  return new Promise((resolve, reject) => {
    const child = spawn("zsh", [path.join(bridge, "src", "vendor-deps.sh")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_MICRO_VENDOR_BASE_URL: baseUrl,
        // Isolate the mutex so a test can never collide with a real run.
        TMPDIR: sandbox,
        ...extraEnv,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`provisioner exited ${code}\n${output}`));
    });
  });
}

test("provisions the native dependency from a release", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory));
  context.after(() => server.close());
  const bridge = scratchPlugin(directory);

  const output = await provision(bridge, server.baseUrl);

  assert.match(output, /dependency installed/);
  assert.ok(fs.existsSync(path.join(bridge, "node_modules", "node-hid")), "node-hid installed");
  assert.ok(fs.existsSync(path.join(bridge, "node_modules", "pkg-prebuilds")), "loader installed");
  assert.equal(fs.readFileSync(path.join(directory, "started"), "utf8").trim(), "started", "bridge started after provisioning");
});

test("releases its lock so a later run is not blocked forever", async (context) => {
  // Regression: the success path ended in `exec`, which skips the EXIT trap, so
  // the mutex was never released and every subsequent attempt short-circuited.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-lock-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory));
  context.after(() => server.close());

  const first = scratchPlugin(directory);
  await provision(first, server.baseUrl);
  assert.ok(fs.existsSync(path.join(first, "node_modules", "node-hid")));

  // A second, independent checkout must still be able to provision.
  fs.rmSync(path.join(directory, "plugin"), { recursive: true, force: true });
  const second = scratchPlugin(directory);
  const output = await provision(second, server.baseUrl);
  assert.doesNotMatch(output, /another provisioning run is in progress/);
  assert.ok(fs.existsSync(path.join(second, "node_modules", "node-hid")), "second run provisioned");
});

test("refuses a tampered artifact", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-bad-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory), { tamper: true });
  context.after(() => server.close());
  const bridge = scratchPlugin(directory);

  await assert.rejects(() => provision(bridge, server.baseUrl), /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(bridge, "node_modules")), false, "nothing installed from a bad artifact");
  assert.equal(fs.existsSync(path.join(directory, "started")), false, "bridge not started");
});

test("refuses an artifact with no published checksum", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-nosum-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory), { withholdChecksum: true });
  context.after(() => server.close());
  const bridge = scratchPlugin(directory);

  await assert.rejects(() => provision(bridge, server.baseUrl), /provisioner exited/);
  assert.equal(fs.existsSync(path.join(bridge, "node_modules")), false, "unverified binaries are never installed");
});

test("reports a missing release without installing anything", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-404-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory));
  context.after(() => server.close());
  const bridge = scratchPlugin(directory);

  await assert.rejects(() => provision(bridge, `${server.baseUrl}/absent`), /provisioner exited/);
  assert.equal(fs.existsSync(path.join(bridge, "node_modules")), false);
});

test("does nothing when the dependency is already present", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-vendor-noop-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = await startReleaseServer(buildBundle(directory));
  context.after(() => server.close());
  const bridge = scratchPlugin(directory);
  fs.mkdirSync(path.join(bridge, "node_modules", "node-hid"), { recursive: true });

  const output = await provision(bridge, server.baseUrl);
  assert.match(output, /already present/);
  assert.equal(fs.existsSync(path.join(directory, "started")), false, "no redundant restart");
});
