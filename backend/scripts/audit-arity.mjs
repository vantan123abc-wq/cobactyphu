// Arity audit: for every function declared in backend/src, compare its
// declared parameter list against every call site's argument count.
// Motivated by two real bugs of exactly this shape in turnMachine.js
// (settleAuction, documented in-file; resolveLanding, found 2026-09-04).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js') && !f.endsWith('.test.js')) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// Split a parenthesised argument list on top-level commas.
function splitArgs(s) {
  const parts = [];
  let depth = 0, cur = '', str = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === str && s[i - 1] !== '\\') str = null;
      cur += c; continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function matchParen(src, openIdx) {
  let depth = 0, str = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === str && src[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const files = walk(new URL('../src', import.meta.url).pathname.replace(/^\//, ''));
const decls = new Map(); // name -> { file, required, total, params }

for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchParen(src, open);
    if (close === -1) continue;
    const params = splitArgs(src.slice(open + 1, close)).filter(Boolean);
    if (params.some((p) => p.startsWith('...'))) continue; // rest params: any arity is fine
    const required = params.filter((p) => !p.includes('=') && !p.startsWith('[') && !p.startsWith('{')).length;
    decls.set(m[1], { file, required, total: params.length, params });
  }
}

const findings = [];
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const [name, d] of decls) {
    const re = new RegExp('(?<![\\w$.])' + name + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (/function\s+$/.test(before) || /\bexport\s+$/.test(before)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchParen(src, open);
      if (close === -1) continue;
      const args = splitArgs(src.slice(open + 1, close)).filter(Boolean);
      if (args.length >= d.required && args.length <= d.total) continue;
      findings.push({
        file, line: lineOf(m.index), name,
        got: args.length, wantMin: d.required, wantMax: d.total,
        declaredIn: d.file, params: d.params.join(', '),
        src: raw.split('\n')[lineOf(m.index) - 1].trim().slice(0, 110),
      });
    }
  }
}

if (findings.length === 0) {
  console.log('No arity mismatches found across ' + files.length + ' files / ' + decls.size + ' declared functions.');
} else {
  console.log(findings.length + ' arity mismatch(es):\n');
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  ${f.name}(...) got ${f.got}, expects ${f.wantMin}${f.wantMax !== f.wantMin ? '-' + f.wantMax : ''}`);
    console.log(`    declared: ${f.name}(${f.params})  [${f.declaredIn}]`);
    console.log(`    call    : ${f.src}\n`);
  }
}
