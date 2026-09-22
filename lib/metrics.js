'use strict';
/**
 * Real system metrics. Every number here is read from the running kernel.
 * If a value cannot be obtained on this platform it is returned as null,
 * never as a placeholder.
 *
 * Phase 1 scope: CPU, memory, load average and the /proc/stat kernel counters.
 * Disk, network and session metrics belong to the Resource Management module,
 * which is not built yet.
 */
const os = require('os');
const fs = require('fs');
const { PLAT } = require('./platform');

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
    speedMhz: cpus[0] ? cpus[0].speed : null,
    totalmem: os.totalmem(),
    uptimeSec: os.uptime(),
    bootTime: Date.now() - os.uptime() * 1000,
    user: os.userInfo().username,
    homedir: os.homedir(),
    nodeVersion: process.version,
    shellPid: process.pid
  };
}

/** One coherent reading of the machine, taken at a single instant. */
function snapshot() {
  return {
    at: Date.now(),
    cpu: sampleCpu(),
    mem: sampleMem(),
    kernel: sampleKernel(),
    load: os.loadavg(),
    uptimeSec: os.uptime()
  };
}

module.exports = { snapshot, systemInfo, sampleCpu, sampleMem, sampleKernel };
