'use strict';
/**
 * Real file operations, confined to the campus-data directory next to the
 * server. Sizes, timestamps, inode numbers and permission bits all come from
 * the actual file system via fs.stat.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'campus-data');

const DEFAULT_DIRS = ['Students', 'Faculty', 'Attendance', 'Examination', 'Library', 'Hostel', 'Projects'];

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
  for (const d of DEFAULT_DIRS) {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p);
  }
}

/** Resolve a request path and refuse anything that escapes the sandbox. */
function resolve(rel) {
  const clean = String(rel || '').replace(/^[/\\]+/, '');
  const full = path.resolve(ROOT, clean);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error('Path is outside the campus-data sandbox.');
  }
  return full;
}

const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');

function modeString(mode, isDir) {
  const bits = ['r', 'w', 'x'];
  let s = isDir ? 'd' : '-';
  for (let g = 2; g >= 0; g--) {
    for (let b = 0; b < 3; b++) {
      s += (mode >> (g * 3 + (2 - b))) & 1 ? bits[b] : '-';
    }
  }
  return s;
}

function entry(full) {
  const st = fs.statSync(full);
  const isDir = st.isDirectory();
  return {
    name: path.basename(full),
    path: relOf(full),
    type: isDir ? 'folder' : 'file',
    ext: isDir ? null : (path.extname(full).slice(1).toLowerCase() || 'none'),
    size: st.size,
    blocks: st.blocks,
    blockSize: st.blksize,
    inode: st.ino,
    links: st.nlink,
    mode: modeString(st.mode, isDir),
    modeOctal: (st.mode & 0o777).toString(8),
    uid: st.uid,
    gid: st.gid,
    created: st.birthtimeMs || st.ctimeMs,
    modified: st.mtimeMs,
    accessed: st.atimeMs
  };
}

function dirSize(full) {
  let total = 0, files = 0, dirs = 0;
  const walk = (p) => {
    for (const n of fs.readdirSync(p)) {
      const c = path.join(p, n);
      let st;
      try { st = fs.statSync(c); } catch (_) { continue; }
      if (st.isDirectory()) { dirs++; walk(c); } else { files++; total += st.size; }
    }
  };
  walk(full);
  return { total, files, dirs };
}

function list(rel) {
  ensureRoot();
  const full = resolve(rel);
  const st = fs.statSync(full);
  if (!st.isDirectory()) return { entry: entry(full), children: null };
  const children = fs.readdirSync(full).map((n) => {
    try {
      const e = entry(path.join(full, n));
      if (e.type === 'folder') e.contents = dirSize(path.join(full, n));
      return e;
    } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  return { entry: entry(full), children };
}

function create(rel, name, kind, content) {
  ensureRoot();
  const dir = resolve(rel);
  const safe = path.basename(String(name || '').trim());
  if (!safe || safe === '.' || safe === '..') throw new Error('Give the file or folder a name.');
  const full = path.join(dir, safe);
  if (fs.existsSync(full)) throw new Error('"' + safe + '" already exists in this directory.');
  if (kind === 'folder') fs.mkdirSync(full);
  else fs.writeFileSync(full, content === undefined || content === null ? '' : String(content));
  return entry(full);
}

function rename(rel, newName) {
  const full = resolve(rel);
  const safe = path.basename(String(newName || '').trim());
  if (!safe) throw new Error('Give it a new name.');
  const target = path.join(path.dirname(full), safe);
  if (fs.existsSync(target)) throw new Error('"' + safe + '" already exists.');
  fs.renameSync(full, target);
  return entry(target);
}

function remove(rel) {
  const full = resolve(rel);
  if (full === ROOT) throw new Error('The campus root cannot be deleted.');
  const st = fs.statSync(full);
  if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
  else fs.unlinkSync(full);
  return { removed: relOf(full), type: st.isDirectory() ? 'folder' : 'file' };
}

function search(query) {
  ensureRoot();
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const hits = [];
  const walk = (p) => {
    for (const n of fs.readdirSync(p)) {
      const c = path.join(p, n);
      let st;
      try { st = fs.statSync(c); } catch (_) { continue; }
      if (n.toLowerCase().includes(q)) hits.push(entry(c));
      if (st.isDirectory() && hits.length < 200) walk(c);
    }
  };
  walk(ROOT);
  return hits;
}

function read(rel, limit = 20000) {
  const full = resolve(rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('That is a directory, not a file.');
  const buf = fs.readFileSync(full);
  const isText = !buf.slice(0, 2048).includes(0);
  return {
    entry: entry(full),
    binary: !isText,
    truncated: buf.length > limit,
    content: isText ? buf.slice(0, limit).toString('utf8') : null
  };
}

function write(rel, content) {
  const full = resolve(rel);
  fs.writeFileSync(full, String(content === undefined ? '' : content));
  return entry(full);
}

module.exports = { ROOT, ensureRoot, list, create, rename, remove, search, read, write, entry, dirSize };
