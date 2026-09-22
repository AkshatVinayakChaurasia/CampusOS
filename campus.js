#!/usr/bin/env node
'use strict';
/**
 * Intelligent Digital Campus Ecosystem — terminal shell.
 *
 * An Operating Systems course project. Everything printed here is read from
 * the machine this process is running on: the kernel's own process table,
 * its CPU tick counters, its memory accounting, its inodes.
 *
 * Zero dependencies.  Run with:  node campus.js
 * One-shot mode:               node campus.js ps
 */
const readline = require('readline');
const path = require('path');

const metrics = require('./lib/metrics');
const procs = require('./lib/processes');
const files = require('./lib/files');
const { c, table, bar, bytes, duration, pct, heading, fields } = require('./lib/render');

const PLAT = process.platform;

/* Current directory inside the campus-data sandbox, as a relative path. */
let cwd = '';

/* ------------------------------------------------------------------ *
 * Sampling helpers
 *
 * CPU percentages are deltas between two readings, so a single reading has
 * nothing to compare against. Both of these take a throwaway first sample,
 * wait, then return the second — otherwise the first command of a session
 * would print zeros and dashes.
 * ------------------------------------------------------------------ */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function twoPassSnapshot() {
  metrics.snapshot();
  await wait(350);
  return metrics.snapshot();
}

async function twoPassProcesses() {
  const first = await procs.list();
  const at = Date.now();
  await wait(350);
  const second = await procs.list();

  /* macOS and Windows report accumulated CPU time, not a percentage. Turn it
     into one the same way the kernel does: time on the CPU over wall time. */
  const before = new Map(first.map((p) => [p.pid, p.cpuSeconds]));
  const dt = (Date.now() - at) / 1000;
  for (const p of second) {
    if (p.cpuPct === null && dt > 0 && before.has(p.pid) && Number.isFinite(p.cpuSeconds)) {
      p.cpuPct = Math.max(0, ((p.cpuSeconds - before.get(p.pid)) / dt) * 100);
    }
  }
  return second;
}

/* ------------------------------------------------------------------ *
 * Module 1 — System information
 * ------------------------------------------------------------------ */
function cmdSys() {
  const s = metrics.systemInfo();
  console.log(heading('System information'));
  console.log(fields([
    ['Hostname', c.bold(s.hostname)],
    ['Operating system', s.type + ' ' + s.release + '  (' + s.platform + '/' + s.arch + ')'],
    ['CPU', s.cpuModel],
    ['Logical cores', String(s.cores) + (s.speedMhz ? c.grey('  @ ' + s.speedMhz + ' MHz') : '')],
    ['Physical memory', bytes(s.totalmem)],
    ['Uptime', duration(s.uptimeSec)],
    ['Booted at', new Date(s.bootTime).toLocaleString()],
    ['Logged in as', s.user],
    ['Home directory', s.homedir],
    ['Node runtime', s.nodeVersion],
    ['This shell PID', String(s.shellPid)]
  ]));
  console.log('');
}

/* ------------------------------------------------------------------ *
 * Module 1 — Live snapshot
 * ------------------------------------------------------------------ */
function renderSnapshot(s) {
  const lines = [];
  lines.push(heading('Live snapshot  ' + c.grey(new Date(s.at).toLocaleTimeString())));

  lines.push('');
  lines.push(c.bold('CPU') + '   ' + bar(s.cpu.overall) + '  ' + pct(s.cpu.overall));
  const cores = s.cpu.perCore.map((v, i) =>
    c.grey('cpu' + String(i).padStart(2, '0')) + ' ' + bar(v, 10) + ' ' + String(Math.round(v)).padStart(3) + '%'
  );
  for (let i = 0; i < cores.length; i += 2) lines.push('      ' + cores.slice(i, i + 2).join('   '));

  lines.push('');
  lines.push(c.bold('MEM') + '   ' + bar(s.mem.pct) + '  ' + pct(s.mem.pct) +
    c.grey('   ' + bytes(s.mem.used) + ' used of ' + bytes(s.mem.total) + ', ' + bytes(s.mem.free) + ' available'));

  lines.push('');
  const k = s.kernel;
  lines.push(fields([
    ['Load average', s.load.map((n) => n.toFixed(2)).join('  ') + c.grey('   (1m  5m  15m)')],
    ['Run queue', k.running === null ? null : k.running + ' runnable'],
    ['Blocked on I/O', k.blocked === null ? null : k.blocked + ' in uninterruptible sleep'],
    ['Context switches', k.ctxtRate === null ? null : k.ctxtRate.toLocaleString() + ' /s'],
    ['Uptime', duration(s.uptimeSec)]
  ]));

  if (k.running === null) {
    lines.push('');
    lines.push(c.grey('  Run queue, blocked count and context switch rate come from /proc/stat,'));
    lines.push(c.grey('  which exists on Linux only. They read as — on ' + PLAT + '.'));
  }
  return lines.join('\n');
}

async function cmdStat() {
  console.log(renderSnapshot(await twoPassSnapshot()));
  console.log('');
}

/** Redraw the snapshot on a timer until the user presses a key. */
async function cmdWatch(arg, rl) {
  const every = Math.max(1, Number(arg) || 2);
  if (!process.stdout.isTTY) {
    console.log(c.yellow('watch needs an interactive terminal. Showing one reading instead.'));
    return cmdStat();
  }

  metrics.snapshot();
  await wait(350);

  return new Promise((resolve) => {
    const draw = () => {
      console.clear();
      console.log(renderSnapshot(metrics.snapshot()));
      console.log('\n' + c.grey('refreshing every ' + every + 's — press any key to stop'));
    };

    const timer = setInterval(draw, every * 1000);
    draw();

    const stop = () => {
      clearInterval(timer);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      if (rl) rl.resume();
      console.log('');
      resolve();
    };

    if (rl) rl.pause();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.once('keypress', stop);
  });
}

/* ------------------------------------------------------------------ *
 * Module 2 — Process table
 * ------------------------------------------------------------------ */
const STATE_COLOUR = {
  'Running / Ready': 'green',
  Waiting: 'yellow',
  Suspended: 'magenta',
  Terminated: 'red'
};

async function cmdPs(args) {
  const flags = args.filter((a) => a.startsWith('-'));
  const filter = args.filter((a) => !a.startsWith('-')).join(' ').toLowerCase();
  const showAll = flags.includes('-a');
  const byCpu = flags.includes('-c');

  let list = await twoPassProcesses();
  if (!list.length) {
    console.log(c.yellow('\nCould not read the process table on this platform (' + PLAT + ').\n'));
    return;
  }

  const total = list.length;
  if (filter) list = list.filter((p) => p.name.toLowerCase().includes(filter) || String(p.pid) === filter);

  const matched = list.length;
  list.sort((a, b) => (byCpu ? (b.cpuPct || 0) - (a.cpuPct || 0) : (b.rss || 0) - (a.rss || 0)));
  const shown = showAll ? list : list.slice(0, 20);

  console.log(heading('Process table' + (filter ? c.grey('  filter: "' + filter + '"') : '')));
  console.log(table(
    [
      { key: 'pid', label: 'PID', align: 'right' },
      { key: 'ppid', label: 'PPID', align: 'right' },
      { key: 'name', label: 'NAME' },
      { key: 'state', label: 'STATE' },
      { key: 'cpu', label: 'CPU', align: 'right' },
      { key: 'mem', label: 'MEM', align: 'right' },
      { key: 'thr', label: 'THR', align: 'right' },
      { key: 'up', label: 'ELAPSED', align: 'right' }
    ],
    shown.map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name.length > 24 ? p.name.slice(0, 23) + '…' : p.name,
      state: c[STATE_COLOUR[p.state] || 'grey'](p.stateLabel),
      cpu: pct(p.cpuPct),
      mem: bytes(p.rss),
      thr: p.threads,
      up: duration(p.elapsedSec)
    }))
  ));

  const note = matched === total
    ? total + ' processes'
    : matched + ' of ' + total + ' processes match';
  console.log(c.grey('\n' + note + (shown.length < matched
    ? ', showing top ' + shown.length + ' by ' + (byCpu ? 'CPU' : 'memory') + ' — use `ps -a` for all'
    : '')));
  console.log(c.grey('sorted by ' + (byCpu ? 'CPU share' : 'resident memory') + '   `pid <n>` for one process in detail\n'));
}

async function cmdPid(arg) {
  const pid = Number(arg);
  if (!Number.isInteger(pid)) {
    console.log(c.red('\nGive a numeric PID, e.g. `pid 1`.\n'));
    return;
  }

  const list = await twoPassProcesses();
  const p = list.find((x) => x.pid === pid);
  if (!p) {
    console.log(c.red('\nPID ' + pid + ' is not in the process table.\n'));
    return;
  }

  const d = procs.detail(pid);
  console.log(heading('PID ' + p.pid + '  ' + p.name));
  console.log(fields([
    ['Parent PID', p.ppid],
    ['State', c[STATE_COLOUR[p.state] || 'grey'](p.stateLabel) + c.grey('  (' + p.stateRaw + ')')],
    ['Five-state model', p.state],
    ['Meaning', c.grey(p.stateNote)],
    ['CPU share', pct(p.cpuPct)],
    ['CPU time used', duration(p.cpuSeconds)],
    ['Resident memory', bytes(p.rss)],
    ['Virtual memory', bytes(p.vsize)],
    ['Threads', p.threads],
    ['Priority / nice', p.priority === null ? null : p.priority + ' / ' + p.nice],
    ['Started', p.startMs ? new Date(p.startMs).toLocaleString() : null],
    ['Elapsed', duration(p.elapsedSec)],
    ['Owner UID', p.uid === null || p.uid < 0 ? null : String(p.uid) + (p.owned ? c.grey('  (you)') : '')]
  ]));

  if (PLAT === 'linux') {
    console.log(heading('From /proc/' + pid));
    console.log(fields([
      ['Command line', d.cmdline],
      ['Working directory', d.cwd],
      ['Open file descriptors', d.openFds],
      ['Voluntary ctx switches', d.voluntaryCtxt],
      ['Involuntary ctx switches', d.involuntaryCtxt]
    ]));
  } else {
    console.log(c.grey('\n  Command line, open descriptors and per-process context switch counts'));
    console.log(c.grey('  are read from /proc, so they are Linux-only.'));
  }
  console.log('');
}

/* ------------------------------------------------------------------ *
 * Module 3 — File manager, sandboxed to campus-data/
 * ------------------------------------------------------------------ */
const here = () => (cwd ? 'campus-data/' + cwd : 'campus-data');

function resolveRel(arg) {
  if (!arg || arg === '.') return cwd;
  if (arg === '/') return '';
  if (arg.startsWith('/')) return arg.slice(1);
  return path.posix.normalize(path.posix.join(cwd || '.', arg)).replace(/^\.\/?/, '');
}

function cmdLs(arg) {
  const rel = resolveRel(arg);
  let res;
  try { res = files.list(rel); } catch (e) { return console.log(c.red('\n' + e.message + '\n')); }

  if (!res.children) {
    console.log(c.grey('\n' + res.entry.path + ' is a file, not a directory. Use `cat` to read it.\n'));
    return;
  }

  /* Heading names the directory that was listed, which is not always the
     one we are standing in — `ls Students` from the root, for instance. */
  const shownPath = res.entry.path && res.entry.path !== '.' ? 'campus-data/' + res.entry.path : 'campus-data';
  console.log(heading(shownPath));
  if (!res.children.length) {
    console.log(c.grey('(empty directory)\n'));
    return;
  }

  console.log(table(
    [
      { key: 'mode', label: 'MODE' },
      { key: 'links', label: 'LN', align: 'right' },
      { key: 'inode', label: 'INODE', align: 'right' },
      { key: 'size', label: 'SIZE', align: 'right' },
      { key: 'modified', label: 'MODIFIED' },
      { key: 'name', label: 'NAME' }
    ],
    res.children.map((e) => ({
      mode: c.grey(e.mode),
      links: e.links,
      inode: e.inode,
      size: e.type === 'folder' ? c.grey(e.contents.files + ' f') : bytes(e.size),
      modified: c.grey(new Date(e.modified).toLocaleString()),
      name: e.type === 'folder' ? c.blue(e.name + '/') : e.name
    }))
  ));

  const dirs = res.children.filter((e) => e.type === 'folder').length;
  console.log(c.grey('\n' + dirs + ' directories, ' + (res.children.length - dirs) +
    ' files — sizes, inodes and mode bits are from fs.stat\n'));
}

function cmdCd(arg) {
  if (!arg) { cwd = ''; return console.log(c.grey('\nnow at ' + here() + '\n')); }
  if (arg === '..') {
    cwd = cwd.includes('/') ? cwd.slice(0, cwd.lastIndexOf('/')) : '';
    return console.log(c.grey('\nnow at ' + here() + '\n'));
  }
  const rel = resolveRel(arg);
  try {
    const res = files.list(rel);
    if (!res.children) return console.log(c.red('\n' + res.entry.path + ' is a file.\n'));
    cwd = res.entry.path === '.' ? '' : res.entry.path;
    console.log(c.grey('\nnow at ' + here() + '\n'));
  } catch (e) {
    console.log(c.red('\n' + e.message + '\n'));
  }
}

function cmdCat(arg) {
  if (!arg) return console.log(c.red('\nUsage: cat <file>\n'));
  try {
    const r = files.read(resolveRel(arg));
    console.log(heading(r.entry.path + c.grey('  ' + bytes(r.entry.size) + ', inode ' + r.entry.inode)));
    if (r.binary) console.log(c.yellow('(binary file — not printed)'));
    else {
      console.log(r.content || c.grey('(empty file)'));
      if (r.truncated) console.log(c.yellow('\n… truncated'));
    }
    console.log('');
  } catch (e) {
    console.log(c.red('\n' + e.message + '\n'));
  }
}

function cmdCreate(kind, args) {
  const name = args[0];
  if (!name) {
    return console.log(c.red('\nUsage: ' + (kind === 'folder' ? 'mkdir <name>' : 'touch <name> [text…]') + '\n'));
  }
  /* "touch Reports/may.txt" has to land in Reports, not in the current
     directory — files.create() takes the parent and a bare name. */
  const rel = resolveRel(name);
  const cut = rel.lastIndexOf('/');
  const parent = cut < 0 ? cwd : rel.slice(0, cut);
  const base = cut < 0 ? rel : rel.slice(cut + 1);

  try {
    const e = files.create(parent, base, kind, args.slice(1).join(' '));
    console.log(c.green('\ncreated ') + e.path +
      c.grey('   inode ' + e.inode + ', mode ' + e.mode + ', ' + bytes(e.size) + '\n'));
  } catch (err) {
    console.log(c.red('\n' + err.message + '\n'));
  }
}

function cmdRm(arg) {
  if (!arg) return console.log(c.red('\nUsage: rm <name>\n'));
  try {
    const r = files.remove(resolveRel(arg));
    console.log(c.green('\nremoved ') + r.type + ' ' + r.removed + '\n');
  } catch (e) {
    console.log(c.red('\n' + e.message + '\n'));
  }
}

function cmdFind(args) {
  const q = args.join(' ');
  if (!q) return console.log(c.red('\nUsage: find <text>\n'));
  const hits = files.search(q);
  if (!hits.length) return console.log(c.grey('\nnothing under campus-data matches "' + q + '"\n'));

  console.log(heading(hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ' for "' + q + '"'));
  console.log(table(
    [
      { key: 'type', label: 'TYPE' },
      { key: 'size', label: 'SIZE', align: 'right' },
      { key: 'inode', label: 'INODE', align: 'right' },
      { key: 'path', label: 'PATH' }
    ],
    hits.map((e) => ({
      type: e.type === 'folder' ? c.blue('dir') : 'file',
      size: e.type === 'folder' ? null : bytes(e.size),
      inode: e.inode,
      path: e.path
    }))
  ));
  console.log('');
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */
const HELP = [
  ['System', [
    ['sys', 'hostname, CPU, cores, memory, uptime'],
    ['stat', 'one live reading: CPU, memory, load, run queue'],
    ['watch [s]', 'redraw that reading every s seconds (default 2)']
  ]],
  ['Processes', [
    ['ps [text]', 'process table, top 20 by memory; filter by name or PID'],
    ['ps -a', 'every process'],
    ['ps -c', 'sort by CPU share instead of memory'],
    ['pid <n>', 'one process in full detail']
  ]],
  ['Files', [
    ['ls [dir]', 'directory listing with real inode, mode bits and size'],
    ['cd <dir>', 'change directory; `cd ..` goes up, `cd /` to the root'],
    ['cat <file>', 'print a file'],
    ['mkdir <name>', 'create a directory'],
    ['touch <name> [text]', 'create a file, optionally with contents'],
    ['rm <name>', 'delete a file or directory'],
    ['find <text>', 'search the whole campus-data tree by name']
  ]],
  ['Shell', [
    ['help', 'this list'],
    ['clear', 'clear the screen'],
    ['exit', 'quit  (Ctrl+C also works)']
  ]]
];

function cmdHelp() {
  for (const [group, items] of HELP) {
    console.log(heading(group === 'Files' ? 'Files  (sandboxed to campus-data/)' : group));
    const w = Math.max(...items.map(([k]) => k.length));
    for (const [k, v] of items) console.log('  ' + c.cyan(k.padEnd(w)) + '  ' + c.grey(v));
  }
  console.log('');
}

function banner() {
  const s = metrics.systemInfo();
  console.log('');
  console.log(c.bold(c.cyan('  Intelligent Digital Campus Ecosystem')) + c.grey('  ·  terminal shell'));
  console.log(c.grey('  ' + s.hostname + '  ·  ' + s.cores + ' cores  ·  ' + bytes(s.totalmem) +
    '  ·  ' + s.type + ' ' + s.release));
  console.log(c.grey('  Everything below is read live from this machine. Type `help`.'));
  console.log('');
}

async function run(line, rl) {
  const parts = String(line).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const [cmd, ...args] = parts;

  switch (cmd) {
    case 'help': case '?': return cmdHelp();
    case 'sys': case 'system': return cmdSys();
    case 'stat': case 'snapshot': return cmdStat();
    case 'watch': return cmdWatch(args[0], rl);
    case 'ps': return cmdPs(args);
    case 'pid': case 'proc': return cmdPid(args[0]);
    case 'ls': case 'dir': return cmdLs(args[0]);
    case 'cd': return cmdCd(args[0]);
    case 'pwd': return console.log('\n' + here() + '\n');
    case 'cat': case 'read': return cmdCat(args[0]);
    case 'mkdir': return cmdCreate('folder', args);
    case 'touch': case 'new': return cmdCreate('file', args);
    case 'rm': case 'del': return cmdRm(args[0]);
    case 'find': case 'search': return cmdFind(args);
    case 'clear': return console.clear();
    case 'exit': case 'quit': return process.exit(0);
    default:
      console.log(c.red('\nUnknown command "' + cmd + '". Type `help`.\n'));
  }
}

const promptText = () => c.green('campus') + c.grey(':' + here()) + c.green('$ ');

async function main() {
  files.ensureRoot();
  const argv = process.argv.slice(2);

  /* One-shot mode: node campus.js ps chrome */
  if (argv.length) {
    await run(argv.join(' '), null);
    return;
  }

  banner();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText()
  });

  rl.prompt();
  rl.on('line', async (line) => {
    try { await run(line, rl); } catch (e) { console.log(c.red('\n' + e.message + '\n')); }
    rl.setPrompt(promptText());
    rl.prompt();
  });
  rl.on('close', () => { console.log(c.grey('\nbye\n')); process.exit(0); });
}

main();
