'use strict';
const { execFile } = require('child_process');

const PLAT = process.platform; // 'linux' | 'darwin' | 'win32'

function sh(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function ps1(script) {
  return sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

module.exports = { PLAT, sh, ps1, num };
