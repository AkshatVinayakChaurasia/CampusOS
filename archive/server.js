'use strict';
/**
 * Intelligent Digital Campus Ecosystem — local OS telemetry server.
 *
 * Zero dependencies. Run with:  node server.js
 * Everything it serves is read from the machine it runs on.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const metrics = require('./lib/metrics');
const procs = require('./lib/processes');
const files = require('./lib/files');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

/* ---------------- shared live state ---------------- */
const clients = new Set();
const events = [];          // real kernel events, newest first
let lastSnapshot = null;
let lastProcIndex = new Map();
let lastAlertAt = { cpu: 0, mem: 0, disk: 0 };

function pushEvent(text, tone, icon) {
  events.unshift({ text, tone, icon, at: Date.now() });
  if (events.length > 60) events.length = 60;
}

function broadcast(type, data) {
  const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

/* Detect real process births and deaths between polls */
function diffProcesses(list) {
  const index = new Map(list.map((p) => [p.pid, p]));
  if (lastProcIndex.size) {
    let started = 0, ended = 0;
    for (const [pid, p] of index) {
      if (!lastProcIndex.has(pid)) {
        started++;
        if (started <= 3) pushEvent(`${p.name} (PID ${pid}) entered the process table`, 'grn', 'plus');
      }
    }
    for (const [pid, p] of lastProcIndex) {
      if (!index.has(pid)) {
        ended++;
        if (ended <= 3) pushEvent(`${p.name} (PID ${pid}) exited and released its memory`, 'rose', 'stop');
      }
    }
    if (started > 3) pushEvent(`${started - 3} more processes were created in this interval`, 'signal', 'list');
    if (ended > 3) pushEvent(`${ended - 3} more processes terminated in this interval`, 'mute', 'list');
  }
  lastProcIndex = index;
}

function checkAlerts(snap) {
  const now = Date.now();
  const gap = 20000;
  const out = [];
  if (snap.cpu.overall > 85 && now - lastAlertAt.cpu > gap) {
    lastAlertAt.cpu = now;
    out.push({ level: 'critical', text: `CPU at ${snap.cpu.overall.toFixed(0)}% across ${snap.cpu.perCore.length} cores — the run queue is saturated.`, at: now });
  }
  if (snap.mem.pct > 85 && now - lastAlertAt.mem > gap) {
    lastAlertAt.mem = now;
    out.push({ level: 'warning', text: `Memory at ${snap.mem.pct.toFixed(0)}% — only ${(snap.mem.free / 1073741824).toFixed(2)} GB available.`, at: now });
  }
  const full = (snap.disks || []).find((d) => d.pct > 90);
  if (full && now - lastAlertAt.disk > 60000) {
    lastAlertAt.disk = now;
    out.push({ level: 'warning', text: `Disk ${full.mount} is ${full.pct.toFixed(0)}% full.`, at: now });
  }
  for (const a of out) pushEvent(a.text, a.level === 'critical' ? 'rose' : 'amber', 'alert');
  return out;
}

const alerts = [];

/* ---------------- sampling loop ---------------- */
async function tick() {
  try {
    const [snap, list] = await Promise.all([metrics.snapshot(), procs.list()]);
    lastSnapshot = snap;
    diffProcesses(list);
    for (const a of checkAlerts(snap)) {
      alerts.unshift(a);
      if (alerts.length > 20) alerts.length = 20;
    }
    const top = [...list]
      .sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.rss - a.rss)
      .slice(0, 12)
      .map((p) => ({ pid: p.pid, name: p.name, cpuPct: p.cpuPct, rss: p.rss, state: p.state, stateRaw: p.stateRaw }));

    broadcast('metrics', {
      at: snap.at,
      cpu: snap.cpu,
      mem: snap.mem,
      kernel: snap.kernel,
      load: snap.load,
      uptimeSec: snap.uptimeSec,
      net: snap.net,
      disks: snap.disks,
      users: snap.users,
      processCount: list.length,
      byState: list.reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {}),
      top,
      events: events.slice(0, 12),
      alerts: alerts.slice(0, 6)
    });
  } catch (err) {
    console.error('[sampler]', err.message);
  }
}

/* ---------------- tiny router ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const q = parsed.query;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    /* --- live metric stream (Server-Sent Events) --- */
    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      if (lastSnapshot) await tick();
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/system') {
      return sendJson(res, 200, {
        ...metrics.systemInfo(),
        sandbox: files.ROOT,
        capabilities: {
          perProcessCpu: process.platform !== 'win32',
          suspendResume: process.platform !== 'win32',
          contextSwitches: process.platform === 'linux',
          runQueue: process.platform === 'linux',
          perProcessDetail: process.platform === 'linux'
        }
      });
    }

    if (p === '/api/metrics') {
      const snap = lastSnapshot || (await metrics.snapshot());
      return sendJson(res, 200, snap);
    }

    if (p === '/api/processes') {
      const list = await procs.list();
      const sort = q.sort || 'cpu';
      list.sort((a, b) =>
        sort === 'mem' ? b.rss - a.rss
        : sort === 'pid' ? a.pid - b.pid
        : (b.cpuPct || 0) - (a.cpuPct || 0) || b.rss - a.rss);
      const limit = Math.min(500, Number(q.limit) || 60);
      return sendJson(res, 200, { at: Date.now(), total: list.length, processes: list.slice(0, limit) });
    }

    if (p.startsWith('/api/process/')) {
      const pid = Number(p.split('/')[3]);
      if (req.method === 'POST') {
        const body = await readBody(req);
        const out = await procs.signal(pid, body.action);
        if (out.ok) pushEvent(`${out.signal} sent to ${out.name} (PID ${out.pid}) from the campus console`, 'amber', 'zap');
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      return sendJson(res, 200, procs.detail(pid));
    }

    if (p === '/api/files') {
      if (req.method === 'GET') return sendJson(res, 200, files.list(q.path || ''));
      if (req.method === 'POST') {
        const b = await readBody(req);
        const e = files.create(b.path || '', b.name, b.kind, b.content);
        pushEvent(`${b.kind === 'folder' ? 'Directory' : 'File'} "${e.name}" created on disk (inode ${e.inode})`, 'signal', 'folder');
        return sendJson(res, 200, e);
      }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const e = files.rename(b.path, b.name);
        pushEvent(`Renamed to "${e.name}" on disk`, 'amber', 'pencil');
        return sendJson(res, 200, e);
      }
      if (req.method === 'DELETE') {
        const b = await readBody(req);
        const out = files.remove(b.path);
        pushEvent(`"${out.removed}" unlinked from the file system`, 'rose', 'trash');
        return sendJson(res, 200, out);
      }
    }

    if (p === '/api/files/search') return sendJson(res, 200, { results: files.search(q.q) });
    if (p === '/api/files/read') return sendJson(res, 200, files.read(q.path));
    if (p === '/api/files/write' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, 200, files.write(b.path, b.content));
    }

    if (p === '/api/events') return sendJson(res, 200, { events, alerts });

    return sendJson(res, 404, { error: 'No such endpoint: ' + p });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

files.ensureRoot();
setInterval(tick, 1000);
tick();

server.listen(PORT, HOST, () => {
  const info = metrics.systemInfo();
  console.log('');
  console.log('  Intelligent Digital Campus Ecosystem');
  console.log('  ------------------------------------');
  console.log('  Open       http://' + HOST + ':' + PORT);
  console.log('  Host       ' + info.hostname + '  (' + info.type + ' ' + info.release + ', ' + info.arch + ')');
  console.log('  CPU        ' + info.cpuModel + '  x' + info.cores);
  console.log('  Memory     ' + (info.totalmem / 1073741824).toFixed(1) + ' GB');
  console.log('  Files      ' + files.ROOT);
  console.log('');
  console.log('  Reading live data from this machine. Press Ctrl+C to stop.');
  console.log('');
});
