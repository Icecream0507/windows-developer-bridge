#!/usr/bin/env node
// SSH 反向隧道守护进程（WDB_TUNNEL=ssh）：在你自己的服务器上把 127.0.0.1:<远端端口> 转发到本机 HTTP 服务，
// 服务器上的 HTTPS 反代（scripts/server/setup-wdb-proxy.sh）再把固定域名指向这个端口。
// 断网、睡眠唤醒、服务器重启后自动重连。由 `wdb start` 后台启动，输出写入 logs/tunnel.log。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfigEnv } from "./config.mjs";

const COMMON_OPTIONS = [
  "-o", "BatchMode=yes", // 后台运行，不能停下来问密码，只用密钥登录
  "-o", "ConnectTimeout=15",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=15", // 45 秒收不到服务器回应就判定断线并重连
  "-o", "ServerAliveCountMax=3",
];
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const STABLE_MS = 60000;
const PORT_BUSY_DELAY_MS = 5000;

export function sshBinary(env = process.env) {
  if (env.WDB_SSH_BIN) return env.WDB_SSH_BIN;
  if (process.platform === "win32") {
    const builtin = path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (fs.existsSync(builtin)) return builtin;
  }
  return "ssh";
}

export function tunnelArgs({ host, remotePort, localPort }) {
  return ["-N", "-T", "-v", ...COMMON_OPTIONS, "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host];
}

// 把 ssh -v 的输出归类：只把有用的行写进日志，并识别端口转发建立 / 失败
export function classifySshLine(line) {
  const text = String(line).trim();
  if (!text) return null;
  if (/remote forward success for: listen/i.test(text)) return { kind: "connected" };
  if (/remote port forwarding failed/i.test(text)) return { kind: "error", text };
  if (/^(debug1: )?Authenticated to /i.test(text)) return { kind: "info", text: text.replace(/^debug1: /i, "") };
  if (/^debug\d?:/i.test(text) || /^OpenSSH_/i.test(text) || /^(Transferred|Bytes per second):/i.test(text)) return null;
  return { kind: "error", text };
}

export function nextDelay(previous, upForMs) {
  if (upForMs >= STABLE_MS) return MIN_DELAY_MS;
  return Math.min(Math.max(MIN_DELAY_MS, previous * 2), MAX_DELAY_MS);
}

function runSsh(run, ssh, args, onLine) {
  return new Promise(resolve => {
    let child;
    try { child = run(ssh, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { resolve({ code: null, error }); return; }
    let done = false;
    const finish = result => { if (!done) { done = true; resolve(result); } };
    for (const stream of [child.stdout, child.stderr]) if (stream) readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
    child.on("error", error => finish({ code: null, error }));
    child.on("close", code => finish({ code }));
  });
}

export async function superviseTunnel({ host, remotePort, localPort, ssh = sshBinary() }, deps = {}) {
  const run = deps.spawn || spawn;
  const log = deps.log || (line => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const shouldStop = deps.shouldStop || (() => false);
  log(`ssh tunnel: ${host} 127.0.0.1:${remotePort} -> 127.0.0.1:${localPort} (${ssh})`);
  let delay = 0;
  while (!shouldStop()) {
    if (delay) {
      log(`retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      if (shouldStop()) break;
    }
    const started = now();
    let connected = false, reason = "";
    const result = await runSsh(run, ssh, tunnelArgs({ host, remotePort, localPort }), line => {
      const entry = classifySshLine(line);
      if (!entry) return;
      if (entry.kind === "connected") {
        if (!connected) { connected = true; log(`connected: ${host} 127.0.0.1:${remotePort} -> 127.0.0.1:${localPort}`); }
        return;
      }
      if (entry.kind === "error") reason = entry.text;
      log(entry.text);
    });
    // Windows 上被强制结束的进程退出码是无符号的 0xFFFFFFFF
    const code = result.code > 0x7fffffff ? result.code - 0x100000000 : result.code;
    const why = result.error ? result.error.message : reason || `ssh exited with code ${code}`;
    log(`disconnected: ${why}`);
    // 断网前的旧会话还占着服务器端口：服务器 sshd 开了 ClientAliveInterval（wdb tunnel setup 会配置）时约 1 分钟内释放。
    // 这时服务器是通的，重试代价很低，固定 5 秒一次，端口一释放就能接上
    if (/remote port forwarding failed/i.test(why)) {
      log(`remote port ${remotePort} is still held by a previous session on ${host}; it is released once the server drops that dead connection`);
      delay = PORT_BUSY_DELAY_MS;
    } else {
      delay = nextDelay(delay, connected ? now() - started : 0);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadConfigEnv();
  const host = (process.env.WDB_SSH_HOST || "").trim();
  const remotePort = Number(process.env.WDB_SSH_REMOTE_PORT || 18787);
  const localPort = Number(process.env.WDB_HTTP_PORT || 8787);
  const stamp = line => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  if (!host || host.startsWith("-") || /\s/.test(host)) { stamp("disconnected: WDB_SSH_HOST is not set (wdb tunnel ssh <host> <public-url>)"); process.exit(78); }
  for (const [name, port] of [["WDB_SSH_REMOTE_PORT", remotePort], ["WDB_HTTP_PORT", localPort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { stamp(`disconnected: ${name} must be 1..65535`); process.exit(78); }
  }
  let current = null, stopping = false;
  const stop = () => { stopping = true; if (current) current.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const track = (command, args, options) => { current = spawn(command, args, options); return current; };
  await superviseTunnel({ host, remotePort, localPort }, { spawn: track, log: stamp, shouldStop: () => stopping });
}
