import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ROOT } from "./helpers.mjs";
import { tunnelArgs, classifySshLine, nextDelay, superviseTunnel } from "../lib/ssh-tunnel.mjs";

test("ssh arguments forward the remote loopback port to the local bridge", () => {
  const args = tunnelArgs({ host: "my-server", remotePort: 18787, localPort: 8787 });
  assert.equal(args.at(-1), "my-server");
  assert.equal(args[args.indexOf("-R") + 1], "127.0.0.1:18787:127.0.0.1:8787");
  for (const option of ["BatchMode=yes", "ExitOnForwardFailure=yes", "ServerAliveInterval=15"]) assert.ok(args.includes(option), option);
  assert.ok(args.includes("-N"));
});

test("ssh -v output is reduced to useful log lines", () => {
  assert.deepEqual(classifySshLine("debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787"), { kind: "connected" });
  assert.equal(classifySshLine("Error: remote port forwarding failed for listen port 18787").kind, "error");
  assert.equal(classifySshLine("Authenticated to 1.2.3.4 ([1.2.3.4]:22) using \"publickey\".").kind, "info");
  assert.equal(classifySshLine("debug1: client_input_channel_open: ctype forwarded-tcpip rchan 3"), null);
  assert.equal(classifySshLine("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"), null);
  assert.equal(classifySshLine("Transferred: sent 3000, received 2000 bytes, in 1.0 seconds"), null);
  assert.equal(classifySshLine("ssh: connect to host 1.2.3.4 port 22: Connection timed out").kind, "error");
  assert.equal(classifySshLine("   "), null);
});

test("reconnect delay backs off and resets after a stable connection", () => {
  assert.equal(nextDelay(0, 0), 2000);
  assert.equal(nextDelay(2000, 0), 4000);
  assert.equal(nextDelay(16000, 0), 30000);
  assert.equal(nextDelay(30000, 0), 30000);
  assert.equal(nextDelay(30000, 120000), 2000);
});

// A scripted stand-in for ssh.exe: each tunnel attempt prints the given stderr lines, then exits.
function fakeSsh(attempts) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    calls.push(args.includes("-R") ? "tunnel" : "other");
    const lines = attempts.shift() || [];
    setImmediate(() => {
      for (const line of lines) child.stderr.write(line + "\n");
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit("close", 255));
    });
    return child;
  };
  return { spawn, calls };
}

test("supervisor reconnects and logs connection state", async () => {
  const { spawn, calls } = fakeSsh([
    ["Error: remote port forwarding failed for listen port 18787"],
    ["debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787", "Timeout, server my-server not responding."],
  ]);
  const logs = [], sleeps = [];
  await superviseTunnel({ host: "my-server", remotePort: 18787, localPort: 8787, ssh: "ssh" }, {
    spawn,
    log: line => logs.push(line),
    sleep: async ms => { sleeps.push(ms); },
    shouldStop: () => calls.filter(call => call === "tunnel").length >= 2,
  });
  assert.deepEqual(calls, ["tunnel", "tunnel"]);
  assert.deepEqual(sleeps, [5000]);
  assert.ok(logs.some(line => line === "disconnected: Error: remote port forwarding failed for listen port 18787"), logs.join("\n"));
  assert.ok(logs.some(line => line.startsWith("remote port 18787 is still held by a previous session")), logs.join("\n"));
  assert.ok(logs.some(line => line.startsWith("connected: my-server 127.0.0.1:18787 -> 127.0.0.1:8787")), logs.join("\n"));
  assert.ok(logs.some(line => line === "disconnected: Timeout, server my-server not responding."), logs.join("\n"));
});

test("server setup script keeps LF line endings", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "server", "setup-wdb-proxy.sh"), "utf8");
  assert.ok(script.startsWith("#!/usr/bin/env bash\n"));
  assert.ok(!script.includes("\r"), "setup-wdb-proxy.sh must not contain CR characters");
});
