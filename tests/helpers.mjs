import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BRIDGE = path.join(ROOT, "bridge.mjs");
export const IS_WIN = process.platform === "win32";

// Starts bridge.mjs over stdio and exposes an id-correlated JSON-RPC client.
export async function startBridge({ unlocked = true, env = {}, dataDir } = {}) {
  const ownsDataDir = !dataDir;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "wdb-test-data-"));
  if (ownsDataDir && unlocked) fs.writeFileSync(path.join(dir, "FULL_ACCESS_ENABLED"), "explicit test-only unlock");
  const child = spawn(process.execPath, [BRIDGE], { cwd: ROOT, env: { ...process.env, WDB_DATA_DIR: dir, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let nextId = 1, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout waiting for " + method + "\n" + stderr)); }, 120000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
  });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  return {
    dataDir: dir,
    request,
    // Returns the raw MCP tool result ({ content, structuredContent, isError }).
    async call(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      if (response.error) throw new Error("JSON-RPC error " + response.error.code + ": " + response.error.message);
      return response.result;
    },
    // Returns structuredContent and fails the test if the tool reported an error.
    async tool(name, args = {}) {
      const result = await this.call(name, args);
      if (result.isError) throw new Error(name + " failed: " + result.content[0].text);
      return result.structuredContent;
    },
    async close() {
      child.stdin.end();
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill();
      // Antivirus on CI runners can hold freshly written job logs for a while; temp cleanup
      // failures are not what these tests verify.
      if (ownsDataDir) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); } catch (error) { process.stderr.write("warning: could not remove " + dir + ": " + error.message + "\n"); }
    },
  };
}

export function tempDir(prefix = "wdb-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function waitFor(fn, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
