// Runs every *.proof.js, two at a time, and prints one row per proof. Results files are left alone (PROOFS_NO_WRITE).
//   npm run proofs                      every proof, pinned: its baseline ref against the commit where its claim was made
//   npm run proofs -- --current         the proofs of an ongoing guarantee, against the working tree
//   npm run proofs -- --only=post-ssr,splats
// A proof that can no longer run prints `HISTORICAL: <commit and reason>` and exits 0; it is reported, not failed.
// Run after `npm run build:packages` (proofs import @margoengine/core and some package builds from dist).
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

// Proofs whose claim is a standing guarantee ("feature off: identical GPU calls"); the others record a one-time change.
const ongoing = [
  'clustered-area-lights',
  'clustered-local-shadows',
  'color-output',
  'deformed-shadows',
  'environment-volumetric',
  'gltf-pro-lighting-hooks',
  'lines-perspective',
  'materials-uv-transform',
  'math-consolidation',
  'oit-detached',
  'post-ssr',
  'post-ssr-models',
  'post-stack',
  'quality-presets',
  'selection-xray-off',
];
const current = process.argv.includes('--current'),
  only = process.argv
    .find((arg) => arg.startsWith('--only='))
    ?.slice(7)
    .split(',');
const all = readdirSync(import.meta.dirname)
  .filter((file) => file.endsWith('.proof.js'))
  .map((file) => file.slice(0, -9));
const wanted = only ?? (current ? ongoing : all),
  names = all.filter((name) => wanted.includes(name) && (!current || ongoing.includes(name)));
const missing = wanted.filter((name) => !names.includes(name));
if (missing.length || !names.length)
  throw new Error(`No such proof${current ? ' with --current' : ''}: ${missing.join(', ') || '(none)'}`);

function run(name) {
  const start = performance.now();
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, `${name}.proof.js`), ...(current ? ['--current'] : [])],
      {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: { ...process.env, PROOFS_NO_WRITE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => {
      const short = (ref) => (ref === 'working tree' ? 'tree' : ref.replace(/^([0-9a-f]{7})[0-9a-f]{33}$/, '$1'));
      const pairs = [
        ...new Set(
          [...err.matchAll(/^\[proof\] .*?: (\S+) -> (.+)$/gm)].map(([, a, b]) => `${short(a)} -> ${short(b)}`),
        ),
      ];
      const historical = out.match(/^HISTORICAL: (.*)$/m)?.[1];
      const failure = code
        ? (err.match(/^(AssertionError|\w*Error)\b.*$/m)?.[0] ?? err.trim().split('\n').at(-1) ?? `exit ${code}`)
        : '';
      done({
        name,
        refs: pairs.join(', ') || '-',
        result: code ? 'FAIL' : historical ? 'HISTORICAL' : 'PASS',
        seconds: ((performance.now() - start) / 1000).toFixed(0),
        note: historical ?? failure.slice(0, 160),
        log: code ? err.slice(-4000) : '',
      });
    });
  });
}

// Two at a time: some proofs hold ~1 GB and time interleaved runs, and the machine is shared (HANDOFF: never all cores).
const queue = [...names],
  rows = [],
  width = Math.min(2, Math.max(1, availableParallelism() >> 1));
await Promise.all(
  Array.from({ length: width }, async () => {
    for (let name; (name = queue.shift()); ) {
      const row = await run(name);
      rows.push(row);
      console.error(`${row.result.padEnd(10)} ${name} (${row.seconds} s)`);
    }
  }),
);
rows.sort((a, b) => a.name.localeCompare(b.name));
for (const row of rows.filter((r) => r.log)) console.log(`\n--- ${row.name} ---\n${row.log}`);
const pad = (cells, sizes) => cells.map((cell, i) => String(cell).padEnd(sizes[i])).join('  ');
const head = ['proof', 'baseline -> candidate', 'result', 's', 'note'],
  sizes = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String([r.name, r.refs, r.result, r.seconds, ''][i]).length)),
  );
console.log(`\n${current ? 'Current tree (--current)' : 'Pinned'}: ${rows.length} proofs\n${pad(head, sizes)}`);
for (const r of rows) console.log(pad([r.name, r.refs, r.result, r.seconds, r.note], sizes));
const count = (result) => rows.filter((r) => r.result === result).length;
console.log(
  `\n${count('PASS')} pass, ${count('HISTORICAL')} historical, ${count('FAIL')} fail in ${(performance.now() / 60000).toFixed(1)} min`,
);
process.exitCode = count('FAIL') ? 1 : 0;
