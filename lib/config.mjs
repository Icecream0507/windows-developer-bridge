import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function dataDir(env = process.env) {
  return env.WDB_DATA_DIR || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "WindowsDeveloperBridge") : path.join(os.homedir(), ".windows-developer-bridge"));
}

// `wdb` 把 token/端口/隧道等写在 <数据目录>/config.env；已存在的环境变量优先
export function loadConfigEnv(env = process.env) {
  let text;
  try { text = fs.readFileSync(path.join(dataDir(env), "config.env"), "utf8"); } catch { return; }
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].trim();
  }
}
