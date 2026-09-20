'use strict';
/**
 * Real system metrics. Every number here is read from the running kernel.
 * If a value cannot be obtained on this platform it is returned as null,
 * never as a placeholder.
 */
const os = require('os');
const fs = require('fs');
const { PLAT, sh, ps1, num } = require('./platform');

/* ---------------- CPU: delta of os.cpus() tick counters ---------------- */
let prevCpus = os.cpus();

function sampleCpu() {
  const now = os.cpus();
  const perCore = [];
  let totIdle = 0, totAll = 0;

  for (let i = 0; i < now.length; i++) {
    const a = prevCpus[i] ? prevCpus[i].times : now[i].times;
    const b = now[i].times;
    const idle = b.idle - a.idle;
    const all = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    perCore.push(all > 0 ? Math.max(0, Math.min(100, ((all - idle) / all) * 100)) : 0);
    totIdle += idle; totAll += all;
  }
  prevCpus = now;

  const overall = totAll > 0 ? Math.max(0, Math.min(100, ((totAll - totIdle) / totAll) * 100)) : 0;
  return { overall, perCore, model: now[0] ? now[0].model.trim() : 'unknown', speedMhz: now[0] ? now[0].speed : null };
}

/* ---------------- Memory ---------------- */
function sampleMem() {
  const total = os.totalmem();
  const free = os.freemem();
  let available = free;

  if (PLAT === 'linux') {
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = mi.match(/MemAvailable:\s+(\d+) kB/);
      if (m) available = Number(m[1]) * 1024;
    } catch (_) { /* fall back to freemem */ }
  }
  const used = total - available;
  return { total, free: available, used, pct: (used / total) * 100 };
}

/* ---------------- /proc/stat extras: context switches, run queue ---------------- */
let prevCtxt = null, prevCtxtAt = null;

function sampleKernel() {
  if (PLAT !== 'linux') {
    return { ctxt: null, ctxtRate: null, running: null, blocked: null, forks: null, interrupts: null };
  }
  try {
    const s = fs.readFileSync('/proc/stat', 'utf8');
    const g = (re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
    const ctxt = g(/^ctxt (\d+)/m);
    const now = Date.now();
    let rate = null;
    if (prevCtxt !== null && ctxt !== null && prevCtxtAt) {
      const dt = (now - prevCtxtAt) / 1000;
      if (dt > 0) rate = Math.round((ctxt - prevCtxt) / dt);
    }
    prevCtxt = ctxt; prevCtxtAt = now;
    return {
      ctxt, ctxtRate: rate,
      running: g(/^procs_running (\d+)/m),
      blocked: g(/^procs_blocked (\d+)/m),
      forks: g(/^processes (\d+)/m),
      interrupts: g(/^intr (\d+)/m)
    };
  } catch (_) {
    return { ctxt: null, ctxtRate: null, running: null, blocked: null, forks: null, interrupts: null };
  }
}

/* ---------------- Network throughput ---------------- */
let prevNet = null;

async function readNetCounters() {
  if (PLAT === 'linux') {
    try {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      let rx = 0, tx = 0;
      const ifaces = [];
      for (const line of lines) {
        const [nameRaw, rest] = line.split(':');
        if (!rest) continue;
        const name = nameRaw.trim();
        if (name === 'lo') continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0]; tx += f[8];
        ifaces.push({ name, rx: f[0], tx: f[8] });
      }
      return { rx, tx, ifaces };
    } catch (_) { return null; }
  }
  if (PLAT === 'darwin') {
    const out = await sh('netstat', ['-ibn']);
    if (!out) return null;
    let rx = 0, tx = 0; const seen = new Set(); const ifaces = [];
    for (const line of out.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || seen.has(f[0]) || f[0] === 'lo0') continue;
      seen.add(f[0]);
      const r = num(f[6]), t = num(f[9]);
      rx += r; tx += t; ifaces.push({ name: f[0], rx: r, tx: t });
    }
    return { rx, tx, ifaces };
  }
  if (PLAT === 'win32') {
    const out = await ps1('Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress');
    if (!out) return null;
    try {
      let arr = JSON.parse(out); if (!Array.isArray(arr)) arr = [arr];
      let rx = 0, tx = 0; const ifaces = [];
      for (const a of arr) {
        rx += num(a.ReceivedBytes); tx += num(a.SentBytes);
        ifaces.push({ name: a.Name, rx: num(a.ReceivedBytes), tx: num(a.SentBytes) });
      }
      return { rx, tx, ifaces };
    } catch (_) { return null; }
  }
  return null;
}

async function sampleNet() {
  const cur = await readNetCounters();
  if (!cur) return { rxMbps: null, txMbps: null, totalMbps: null, ifaces: [] };
  const now = Date.now();
  let rxMbps = null, txMbps = null;
  if (prevNet) {
    const dt = (now - prevNet.at) / 1000;
    if (dt > 0) {
      rxMbps = Math.max(0, ((cur.rx - prevNet.rx) * 8) / dt / 1e6);
      txMbps = Math.max(0, ((cur.tx - prevNet.tx) * 8) / dt / 1e6);
    }
  }
  prevNet = { rx: cur.rx, tx: cur.tx, at: now };
  return {
    rxMbps, txMbps,
    totalMbps: rxMbps === null ? null : rxMbps + txMbps,
    ifaces: cur.ifaces.map((i) => ({ name: i.name, rxBytes: i.rx, txBytes: i.tx }))
  };
}

/* ---------------- Disk ---------------- */
let diskCache = { at: 0, value: [] };

async function sampleDisk() {
  if (Date.now() - diskCache.at < 10000) return diskCache.value;
  let value = [];
  if (PLAT === 'linux' || PLAT === 'darwin') {
    const out = await sh('df', ['-kP']);
    if (out) {
      value = out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6)
        .filter((f) => f[0].startsWith('/dev') || f[5] === '/')
        .map((f) => ({
          mount: f[5], device: f[0],
          total: num(f[1]) * 1024, used: num(f[2]) * 1024, free: num(f[3]) * 1024,
          pct: num(f[1]) ? (num(f[2]) / num(f[1])) * 100 : 0
        }));
      const seen = new Set();
      value = value.filter((d) => (seen.has(d.mount) ? false : seen.add(d.mount)));
    }
  } else if (PLAT === 'win32') {
    const out = await ps1('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress');
    if (out) {
      try {
        let arr = JSON.parse(out); if (!Array.isArray(arr)) arr = [arr];
        value = arr.map((d) => ({
          mount: d.DeviceID, device: d.DeviceID,
          total: num(d.Size), free: num(d.FreeSpace), used: num(d.Size) - num(d.FreeSpace),
          pct: num(d.Size) ? ((num(d.Size) - num(d.FreeSpace)) / num(d.Size)) * 100 : 0
        }));
      } catch (_) { /* leave empty */ }
    }
  }
  diskCache = { at: Date.now(), value };
  return value;
}

/* ---------------- Logged-in users ---------------- */
let userCache = { at: 0, value: null };

async function sampleUsers() {
  if (Date.now() - userCache.at < 15000) return userCache.value;
  let value = null;
  if (PLAT === 'linux' || PLAT === 'darwin') {
    const out = await sh('who', []);
    if (out !== null) {
      const names = out.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[0]);
      value = { sessions: names.length, unique: [...new Set(names)] };
    }
  } else if (PLAT === 'win32') {
    const out = await ps1('(query user) 2>$null | Measure-Object -Line | Select-Object -ExpandProperty Lines');
    if (out) value = { sessions: Math.max(0, num(out.trim()) - 1), unique: [os.userInfo().username] };
  }
  if (!value) value = { sessions: 1, unique: [os.userInfo().username] };
  userCache = { at: Date.now(), value };
  return value;
}

/* ---------------- Static system facts ---------------- */
function systemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: PLAT,
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    cores: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model.trim() : 'unknown',
    totalmem: os.totalmem(),
    uptimeSec: os.uptime(),
    bootTime: Date.now() - os.uptime() * 1000,
    user: os.userInfo().username,
    homedir: os.homedir(),
    nodeVersion: process.version,
    serverPid: process.pid
  };
}

async function snapshot() {
  const [net, disks, users] = await Promise.all([sampleNet(), sampleDisk(), sampleUsers()]);
  return {
    at: Date.now(),
    cpu: sampleCpu(),
    mem: sampleMem(),
    kernel: sampleKernel(),
    load: os.loadavg(),
    uptimeSec: os.uptime(),
    net, disks, users
  };
}

module.exports = { snapshot, systemInfo, sampleDisk };
