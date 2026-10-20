// Native applier for the Codex/OpenAI "apply_patch" envelope format:
//
//   *** Begin Patch
//   *** Add File: path        (every following line starts with "+")
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: new/path     (optional, directly after Update File)
//   @@ optional context line  (seeks to that line before matching the hunk)
//    context / -removed / +added lines
//   *** End of File           (optional, anchors the hunk at the end of the file)
//   *** End Patch
//
// Every hunk is resolved against the original files before anything is written,
// so a patch that does not apply leaves the tree untouched.
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const BEGIN = "*** Begin Patch", END = "*** End Patch";
const ADD = "*** Add File: ", DEL = "*** Delete File: ", UPD = "*** Update File: ", MOVE = "*** Move to: ", EOF_MARK = "*** End of File";

export function isCodexPatch(text) {
  return typeof text === "string" && /^\s*\*\*\* Begin Patch\s*$/m.test(text);
}

class PatchError extends Error {
  constructor(message) { super(message); this.code = "PATCH_FAILED"; }
}

export function parseCodexPatch(text) {
  const all = String(text).replace(/\r\n/g, "\n").split("\n");
  const start = all.findIndex(line => line.trim() === BEGIN);
  if (start < 0) throw new PatchError("Patch must contain a '*** Begin Patch' line");
  let end = -1;
  for (let i = all.length - 1; i > start; i--) if (all[i].trim() === END) { end = i; break; }
  if (end < 0) throw new PatchError("Patch must end with a '*** End Patch' line");
  const lines = all.slice(start + 1, end), ops = [];
  let i = 0;
  const isHeader = line => line.startsWith(ADD) || line.startsWith(DEL) || line.startsWith(UPD);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith(ADD)) {
      const file = line.slice(ADD.length).trim(), content = [];
      i++;
      while (i < lines.length && !isHeader(lines[i])) {
        if (lines[i].startsWith("+")) content.push(lines[i].slice(1));
        else if (lines[i].trim()) throw new PatchError("Add File lines must start with '+': " + JSON.stringify(lines[i]));
        i++;
      }
      ops.push({ type: "add", file, content });
    } else if (line.startsWith(DEL)) {
      ops.push({ type: "delete", file: line.slice(DEL.length).trim() });
      i++;
    } else if (line.startsWith(UPD)) {
      const file = line.slice(UPD.length).trim();
      let moveTo = null, chunks = [], chunk = null;
      i++;
      if (i < lines.length && lines[i].startsWith(MOVE)) { moveTo = lines[i].slice(MOVE.length).trim(); i++; }
      const newChunk = context => { chunk = { context, oldLines: [], newLines: [], eof: false }; chunks.push(chunk); };
      while (i < lines.length && !isHeader(lines[i])) {
        const l = lines[i];
        if (l.startsWith("@@")) newChunk(l.slice(2).trim() || null);
        else if (l.trim() === EOF_MARK) { if (!chunk) newChunk(null); chunk.eof = true; }
        else {
          if (!chunk) newChunk(null);
          const tag = l[0], body = l.slice(1);
          if (tag === " " || l === "") { chunk.oldLines.push(l === "" ? "" : body); chunk.newLines.push(l === "" ? "" : body); }
          else if (tag === "-") chunk.oldLines.push(body);
          else if (tag === "+") chunk.newLines.push(body);
          else throw new PatchError("Unexpected line in Update File hunk for " + file + ": " + JSON.stringify(l));
        }
        i++;
      }
      chunks = chunks.filter(c => c.oldLines.length || c.newLines.length);
      if (!chunks.length && !moveTo) throw new PatchError("Update File " + file + " has no hunks");
      ops.push({ type: "update", file, moveTo, chunks });
    } else {
      throw new PatchError("Unexpected line outside a file section: " + JSON.stringify(line));
    }
  }
  if (!ops.length) throw new PatchError("Patch contains no file operations");
  for (const op of ops) if (!op.file) throw new PatchError("File operation is missing a path");
  return ops;
}

// Same fallbacks as Codex: exact, then trailing-whitespace-insensitive, then trimmed, then
// typographic punctuation normalised.
const normalisers = [
  s => s,
  s => s.trimEnd(),
  s => s.trim(),
  s => s.trim().replace(/[‐-―−]/g, "-").replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, "\"").replace(/[  -   　]/g, " "),
];
function seek(lines, pattern, from, eof) {
  if (!pattern.length) return from;
  if (pattern.length > lines.length) return -1;
  const last = lines.length - pattern.length;
  for (const norm of normalisers) {
    const want = pattern.map(norm);
    const match = idx => want.every((p, k) => norm(lines[idx + k]) === p);
    if (eof && last >= from && match(last)) return last;
    for (let idx = from; idx <= last; idx++) if (match(idx)) return idx;
  }
  return -1;
}

function applyChunks(original, chunks, label) {
  const lines = original.slice(), replacements = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== null) {
      const at = seek(lines, [chunk.context], cursor, false);
      if (at < 0) throw new PatchError(label + ": context line not found: " + JSON.stringify(chunk.context));
      cursor = at + 1;
    }
    if (!chunk.oldLines.length) {
      const at = chunk.context !== null && !chunk.eof ? cursor : lines.length;
      replacements.push([at, 0, chunk.newLines]);
      continue;
    }
    let oldLines = chunk.oldLines, newLines = chunk.newLines;
    let at = seek(lines, oldLines, cursor, chunk.eof);
    if (at < 0 && oldLines[oldLines.length - 1] === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
      at = seek(lines, oldLines, cursor, chunk.eof);
    }
    if (at < 0) throw new PatchError(label + ": hunk did not match the file. Expected lines:\n" + chunk.oldLines.join("\n"));
    replacements.push([at, oldLines.length, newLines]);
    cursor = at + oldLines.length;
  }
  replacements.sort((a, b) => b[0] - a[0]);
  for (const [at, count, add] of replacements) lines.splice(at, count, ...add);
  return lines;
}

function splitText(text) {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { bom, eol, lines };
}

async function exists(file) {
  try { await fsp.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function atomicWrite(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
  try { await fsp.writeFile(tmp, content, "utf8"); await fsp.rename(tmp, file); }
  catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
}

export async function applyCodexPatch(text, { cwd, checkOnly = false } = {}) {
  const ops = parseCodexPatch(text);
  const resolve = file => path.resolve(cwd, file);
  const plan = [], summary = [];
  // Track files created/deleted earlier in the same patch so later sections see them.
  const virtual = new Map();
  const readCurrent = async file => {
    if (virtual.has(file)) return virtual.get(file);
    if (!(await exists(file))) return null;
    return await fsp.readFile(file, "utf8");
  };
  for (const op of ops) {
    const file = resolve(op.file);
    if (op.type === "add") {
      if ((await readCurrent(file)) !== null) throw new PatchError("Add File target already exists: " + op.file);
      const content = op.content.length ? op.content.join("\n") + "\n" : "";
      virtual.set(file, content);
      plan.push({ write: file, content });
      summary.push({ action: "add", path: file, linesAdded: op.content.length, linesRemoved: 0 });
    } else if (op.type === "delete") {
      const current = await readCurrent(file);
      if (current === null) throw new PatchError("Delete File target does not exist: " + op.file);
      virtual.set(file, null);
      plan.push({ remove: file });
      summary.push({ action: "delete", path: file, linesAdded: 0, linesRemoved: splitText(current).lines.length });
    } else {
      const current = await readCurrent(file);
      if (current === null) throw new PatchError("Update File target does not exist: " + op.file);
      const { bom, eol, lines } = splitText(current);
      const updated = applyChunks(lines, op.chunks, op.file);
      const content = bom + updated.join(eol) + (updated.length ? eol : "");
      const added = op.chunks.reduce((n, c) => n + c.newLines.length, 0), removed = op.chunks.reduce((n, c) => n + c.oldLines.length, 0);
      const target = op.moveTo ? resolve(op.moveTo) : file;
      if (op.moveTo && target !== file && (await readCurrent(target)) !== null) throw new PatchError("Move to target already exists: " + op.moveTo);
      virtual.set(target, content);
      plan.push({ write: target, content });
      if (target !== file) { virtual.set(file, null); plan.push({ remove: file }); }
      summary.push({ action: op.moveTo ? "move" : "update", path: file, ...(op.moveTo ? { movedTo: target } : {}), hunks: op.chunks.length, linesAdded: added, linesRemoved: removed });
    }
  }
  if (!checkOnly) {
    for (const step of plan) {
      if (step.write) await atomicWrite(step.write, step.content);
      else await fsp.rm(step.remove, { force: true });
    }
  }
  return { format: "codex", cwd, checkOnly, applied: !checkOnly, files: summary };
}
