import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, IS_WIN } from "./helpers.mjs";

const scripts = ["install.ps1", "wdb.ps1", path.join("scripts", "package-skill.ps1")];

test("PowerShell scripts are safe for Windows PowerShell 5.1 encodings", () => {
  for (const name of scripts) {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const nonAscii = bytes.some(byte => byte > 0x7f);
    // 5.1 reads BOM-less files in the ANSI code page, which corrupts non-ASCII text.
    assert.ok(!nonAscii || hasBom, name + " contains non-ASCII text and must be saved as UTF-8 with BOM");
  }
  const installer = fs.readFileSync(path.join(ROOT, "install.ps1"));
  assert.ok(!installer.some(byte => byte > 0x7f), "install.ps1 must stay ASCII so `irm | iex` works on every code page");
});

test("PowerShell scripts parse without errors in Windows PowerShell 5.1", { skip: !IS_WIN }, () => {
  const ps = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  for (const name of scripts) {
    const file = path.join(ROOT, name).replace(/'/g, "''");
    const check = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + file + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }";
    const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", check], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, name + ": " + result.stdout + result.stderr);
  }
});

test("wdb help runs", { skip: !IS_WIN }, () => {
  const ps = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "wdb.ps1"), "help"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wdb start/);
});

test("skill has valid frontmatter", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "windows-developer-bridge", "SKILL.md"), "utf8");
  const match = skill.match(/^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: (.+)\r?\n---/);
  assert.ok(match, "SKILL.md needs name/description frontmatter");
  assert.equal(match[1], "windows-developer-bridge");
  assert.ok(match[2].length <= 1024, "description must be at most 1024 characters");
});
