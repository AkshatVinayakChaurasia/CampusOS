'use strict';
/**
 * Real process table. On Linux this is read straight out of /proc, so the
 * states, CPU times and RSS values are the kernel's own numbers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PLAT, sh, ps1, num } = require('./platform');

const HZ = 100; // USER_HZ on every mainstream Linux build
let btimeCache = null;
let prevCpuTimes = new Map();
let prevAt = null;

function btime() {
  if (btimeCache !== null) return btimeCache;
  try {
    const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m);
    btimeCache = m ? Number(m[1]) : Math.floor((Date.now() - os.uptime() * 1000) / 1000);
  } catch (_) {
    btimeCache = Math.floor((Date.now() - os.uptime() * 1000) / 1000);
  }
  return btimeCache;
}

/* Linux state letters, with the textbook meaning students are asked for */
const LINUX_STATE = {
  R: { label: 'Running', osState: 'Running / Ready', note: 'Runnable — on the CPU or waiting in the run queue' },
  S: { label: 'Sleeping', osState: 'Waiting', note: 'Interruptible sleep, waiting for an event or I/O' },
  D: { label: 'Blocked', osState: 'Waiting', note: 'Uninterruptible sleep — blocked on disk or device I/O' },
  T: { label: 'Stopped', osState: 'Suspended', note: 'Suspended by a signal (SIGSTOP)' },
  t: { label: 'Traced', osState: 'Suspended', note: 'Stopped by a debugger' },
  Z: { label: 'Zombie', osState: 'Terminated', note: 'Exited but the parent has not reaped it' },
  I: { label: 'Idle', osState: 'Waiting', note: 'Idle kernel thread' },
  X: { label: 'Dead', osState: 'Terminated', note: 'Dead' }
};

function decodeState(ch) {
  return LINUX_STATE[ch] || { label: ch, osState: 'Unknown', note: 'Reported by the OS as "' + ch + '"' };
}

/* ---------------- Linux via /proc ---------------- */
function readLinux() {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const pageSize = 4096;
  const now = Date.now();
  const dt = prevAt ? (now - prevAt) / 1000 : null;
  const nextTimes = new Map();
  const out = [];

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let stat, uid = -1;
    try {
      stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      uid = fs.statSync('/proc/' + pid).uid;
    } catch (_) { continue; } // process exited while we were reading — that is normal

    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < 0) continue;
    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).split(' ');

    const state = rest[0];
    const ppid = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const priority = Number(rest[15]);
    const nice = Number(rest[16]);
    const threads = Number(rest[17]);
    const starttime = Number(rest[19]);
    const vsize = Number(rest[20]);
    const rssPages = Number(rest[21]);

    const totalTicks = utime + stime;
    nextTimes.set(pid, totalTicks);

    let cpuPct = null;
    if (dt && prevCpuTimes.has(pid)) {
      cpuPct = Math.max(0, ((totalTicks - prevCpuTimes.get(pid)) / HZ / dt) * 100);
    }

    const startMs = (btime() + starttime / HZ) * 1000;
    const st = decodeState(state);

    out.push({
      pid, ppid, name: comm,
      stateRaw: state, state: st.osState, stateLabel: st.label, stateNote: st.note,
      cpuPct, cpuSeconds: totalTicks / HZ,
      rss: rssPages * pageSize, vsize,
      priority, nice, threads,
      startMs, elapsedSec: (Date.now() - startMs) / 1000,
      uid, owned: uid === myUid,
      cmd: null
    });
  }

  prevCpuTimes = nextTimes;
  prevAt = now;
  return out;
}

/* ---------------- macOS via ps ---------------- */
async function readDarwin() {
  const out = await sh('ps', ['-axo', 'pid=,ppid=,stat=,pcpu=,rss=,etime=,time=,uid=,comm=']);
  if (!out) return [];
  const myUid = process.getuid();
  return out.split('\n').filter(Boolean).map((line) => {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) return null;
    const [pid, ppid, stat, pcpu, rss, etime, time, uid] = f;
    const name = path.basename(f.slice(8).join(' '));
    const st = decodeState(stat[0]);
    const parseElapsed = (e) => {
      const parts = e.split('-');
      const days = parts.length > 1 ? Number(parts[0]) : 0;
      const hms = (parts[parts.length - 1] || '').split(':').map(Number).reverse();
      return days * 86400 + (hms[0] || 0) + (hms[1] || 0) * 60 + (hms[2] || 0) * 3600;
    };
    const parseCpuTime = (t) => {
      const p = t.split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : (p[0] || 0) * 60 + (p[1] || 0);
    };
    const elapsedSec = parseElapsed(etime);
    return {
      pid: num(pid), ppid: num(ppid), name,
      stateRaw: stat, state: st.osState, stateLabel: st.label, stateNote: st.note,
      cpuPct: num(pcpu), cpuSeconds: parseCpuTime(time),
      rss: num(rss) * 1024, vsize: null,
      priority: null, nice: null, threads: null,
      startMs: Date.now() - elapsedSec * 1000, elapsedSec,
      uid: num(uid), owned: num(uid) === myUid, cmd: null
    };
  }).filter(Boolean);
}

/* ---------------- Windows via PowerShell ---------------- */
async function readWin() {
  const script =
    'Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU,Responding,' +
    '@{n="Threads";e={$_.Threads.Count}},@{n="Start";e={if($_.StartTime){[Math]::Floor(($_.StartTime.ToUniversalTime()-(Get-Date "1970-01-01")).TotalMilliseconds)}else{0}}} | ConvertTo-Json -Compress';
  const out = await ps1(script);
  if (!out) return [];
  let arr;
  try { arr = JSON.parse(out); } catch (_) { return []; }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((p) => {
    const responding = p.Responding !== false;
    return {
      pid: num(p.Id), ppid: null, name: p.ProcessName,
      stateRaw: responding ? 'R' : 'D',
      state: responding ? 'Running / Ready' : 'Waiting',
      stateLabel: responding ? 'Responding' : 'Not responding',
      stateNote: responding ? 'The process is pumping its message queue' : 'The process is blocked and not responding',
      cpuPct: null, cpuSeconds: num(p.CPU),
      rss: num(p.WorkingSet64), vsize: null,
      priority: null, nice: null, threads: num(p.Threads),
      startMs: num(p.Start) || null,
      elapsedSec: p.Start ? (Date.now() - num(p.Start)) / 1000 : null,
      uid: null, owned: true, cmd: null
    };
  });
}

async function list() {
  if (PLAT === 'linux') return readLinux();
  if (PLAT === 'darwin') return readDarwin();
  if (PLAT === 'win32') return readWin();
  return [];
}

/* ---------------- Per-process detail (Linux) ---------------- */
function detail(pid) {
  const info = { pid };
  if (PLAT !== 'linux') return info;
  try {
    const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    const grab = (k) => { const m = status.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : null; };
    info.vmRss = grab('VmRSS');
    info.vmSize = grab('VmSize');
    info.threads = grab('Threads');
    info.voluntaryCtxt = grab('voluntary_ctxt_switches');
    info.involuntaryCtxt = grab('nonvoluntary_ctxt_switches');
    info.state = grab('State');
  } catch (_) { /* process may have exited */ }
  try { info.openFds = fs.readdirSync('/proc/' + pid + '/fd').length; } catch (_) { info.openFds = null; }
  try { info.cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ') || null; } catch (_) { info.cmdline = null; }
  try { info.cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (_) { info.cwd = null; }
  return info;
}

/* ---------------- Signals, with guards ---------------- */
const PROTECTED_NAMES = new Set(['systemd', 'init', 'kernel_task', 'launchd', 'kthreadd', 'System', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss']);

async function signal(pid, action) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'PID ' + pid + ' is reserved by the kernel and cannot be signalled.' };
  if (pid === process.pid) return { ok: false, error: 'That is this monitoring server itself. Signalling it would end the demo.' };

  const all = await list();
  const target = all.find((p) => p.pid === pid);
  if (!target) return { ok: false, error: 'PID ' + pid + ' is no longer in the process table.' };
  if (PROTECTED_NAMES.has(target.name)) return { ok: false, error: '"' + target.name + '" is a critical system process and is blocked by this server.' };
  if (target.owned === false) return { ok: false, error: '"' + target.name + '" belongs to another user. Only your own processes can be signalled.' };

  const sigs = { suspend: 'SIGSTOP', resume: 'SIGCONT', terminate: 'SIGTERM', kill: 'SIGKILL' };
  const sig = sigs[action];
  if (!sig) return { ok: false, error: 'Unknown action "' + action + '".' };
  if (PLAT === 'win32' && (action === 'suspend' || action === 'resume')) {
    return { ok: false, error: 'Windows has no SIGSTOP/SIGCONT. Suspend and resume are available on Linux and macOS.' };
  }

  try {
    process.kill(pid, PLAT === 'win32' ? undefined : sig);
    return { ok: true, pid, name: target.name, action, signal: PLAT === 'win32' ? 'TerminateProcess' : sig };
  } catch (e) {
    return { ok: false, error: e.code === 'EPERM' ? 'Permission denied by the kernel for PID ' + pid + '.' : String(e.message) };
  }
}

module.exports = { list, detail, signal, LINUX_STATE };
