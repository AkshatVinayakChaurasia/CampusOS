'use strict';
/**
 * Terminal formatting helpers. No dependencies — just ANSI escapes and
 * string padding. Colour is switched off automatically when stdout is not a
 * TTY (piped to a file, or NO_COLOR is set), so `campus ps > out.txt` stays
 * readable.
 */
const USE_COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;

const CODES = {
  reset: 0, bold: 1, dim: 2,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, grey: 90
};

function paint(name, text) {
  if (!USE_COLOUR || !(name in CODES)) return String(text);
  return '\u001b[' + CODES[name] + 'm' + text + '\u001b[0m';
}

const c = {};
for (const name of Object.keys(CODES)) c[name] = (t) => paint(name, t);

/** Visible width, ignoring the ANSI escapes paint() may have added. */
function width(s) {
  return String(s).replace(/\u001b\[\d+m/g, '').length;
}

function pad(s, n, align) {
  const gap = Math.max(0, n - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

/**
 * Render rows as an aligned table.
 * cols: [{ key, label, align }]
 */
function table(cols, rows) {
  const widths = cols.map((col) =>
    Math.max(width(col.label), ...rows.map((r) => width(r[col.key] === undefined || r[col.key] === null ? '—' : r[col.key])), 1)
  );

  const head = cols.map((col, i) => c.bold(pad(col.label, widths[i], col.align))).join('  ');
  const rule = c.grey(widths.map((w) => '─'.repeat(w)).join('──'));
  const body = rows.map((r) =>
    cols.map((col, i) => {
      const v = r[col.key];
      return pad(v === undefined || v === null ? c.grey('—') : String(v), widths[i], col.align);
    }).join('  ')
  );

  return [head, rule, ...body].join('\n');
}

/** A ratio drawn as a bar, coloured by how alarming it is. */
function bar(pct, cells = 24) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return c.grey('—');
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * cells);
  const tone = clamped >= 85 ? 'red' : clamped >= 60 ? 'yellow' : 'green';
  return c[tone]('█'.repeat(filled)) + c.grey('░'.repeat(cells - filled));
}

function bytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
}

function duration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function pct(n, digits = 1) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : n.toFixed(digits) + '%';
}

/** A section heading, so a screenful of output has visible seams. */
function heading(text) {
  return '\n' + c.bold(c.cyan(text)) + '\n' + c.grey('─'.repeat(Math.max(text.length, 40)));
}

/** key: value lines, keys aligned. */
function fields(pairs) {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) =>
    c.grey(pad(k, w)) + '  ' + (v === null || v === undefined ? c.grey('—') : v)
  ).join('\n');
}

module.exports = { c, table, bar, bytes, duration, pct, heading, fields, pad, width, USE_COLOUR };
