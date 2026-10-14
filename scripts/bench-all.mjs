// Every reproducible size, CPU, proof and (with --gpu) real-GPU benchmark, run serially into one dated folder.
// From the repository root after `npm run build:packages`:
//   npm run bench:all                      # size + CPU + proofs (no GPU needed)
//   npm run bench:all -- --gpu             # also every real-GPU benchmark (AC power, GPU lock; about an hour)
//   npm run bench:all -- --only=size,vs-threejs   # groups or step names
//   npm run bench:all -- --list
// Output: test-results/bench/<date>/ with one <step>.log per step, the result files each step wrote (moved out of the
// tree, then the committed versions restored, so a run never edits committed results) and manifest.json (commit,
// host, exit code, duration and AC power per step). The steps and what each proves: docs/whitepaper/reproduce.md.
import {execFileSync, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {cpus, totalmem} from 'node:os';
import {acPower} from '../examples/package-benchmarks/cad/power.mjs';

const git = (...a) => execFileSync('git', a, {encoding: 'utf8'}).trim();
const bench = 'examples/package-benchmarks', proofs = readdirSync(`${bench}/proofs`).filter(f => f.endsWith('.proof.js'));
const steps = [
  {group: 'size', name: 'core-stage', cmd: 'npm run measure:size'},
  {group: 'size', name: 'vs-threejs-size', cmd: 'npm run measure:threejs'},
  {group: 'size', name: 'demo-bytes', cmd: 'node scripts/measure-demo-bytes.js --json=OUT/demo-bytes.json'},
  {group: 'size', name: 'package-sizes', cmd: `node ${bench}/proofs/size.js`},
  {group: 'size', name: 'vfx-size', cmd: `node ${bench}/vfx-size.mjs`},
  {group: 'cpu', name: 'cad-kernel-node', cmd: `node ${bench}/cad/kernel-node.mjs`},
  {group: 'cpu', name: 'textured-instancing-mock', cmd: `node ${bench}/textured-instancing.mjs`},
  ...proofs.map(f => ({group: 'proofs', name: f.replace('.proof.js', ''), cmd: `node ${bench}/proofs/${f}`})),
  {group: 'gpu', name: 'vs-threejs', cmd: `node ${bench}/vs-threejs/run.mjs --out=OUT/vs-threejs.json`},
  {group: 'gpu', name: 'cad', cmd: `node ${bench}/cad/run.mjs --label=bench-all`},
  {group: 'gpu', name: 'cad-edges', cmd: `node ${bench}/cad/run.mjs --edges --sizes=50000 --label=bench-all-edges`},
  {group: 'gpu', name: 'cad-culling', cmd: `node ${bench}/cad/culling.mjs --label=bench-all-culling`},
  {group: 'gpu', name: 'post-stack', cmd: `node ${bench}/gates/post-stack.mjs`},
  {group: 'gpu', name: 'loaders-memory', cmd: `node ${bench}/gates/memory.mjs`},
  {group: 'gpu', name: 'shadow-shimmer', cmd: `node ${bench}/shadow-shimmer.mjs`},
  {group: 'gpu', name: 'textured-instancing-gpu', cmd: `node ${bench}/textured-instancing-gpu.mjs`},
  {group: 'gpu', name: 'atlas-vat', cmd: `node ${bench}/atlas-vat/check.mjs`, artifacts: ['test-results/atlas-vat-check.json']},
  {group: 'gpu', name: 'workers', cmd: `node ${bench}/workers/run.mjs`},
  {group: 'gpu', name: 'browser-tests', cmd: `node ${bench}/gates/run-browser-tests.mjs`},
];
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const chosen = steps.filter(s => only ? only.some(o => o === s.group || o === s.name) : s.group !== 'gpu' || process.argv.includes('--gpu'));
if (process.argv.includes('--list')) {for (const s of steps) console.log(`${s.group.padEnd(7)} ${s.name.padEnd(28)} ${s.cmd}`);process.exit(0);}

// Not git(): its trim() would eat the leading space of the first ' M path' line.
const changed = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', bench], {encoding: 'utf8'}).split('\n').filter(Boolean).map(l => [l.slice(0, 2), l.slice(3)]);
if (changed().length) throw new Error(`${bench} has uncommitted changes; commit or stash them first (this run restores committed results after each step).`);
const out = join('test-results', 'bench', new Date().toISOString().replace(/[:.]/g, '-'));mkdirSync(out, {recursive: true});
const lock = resolve(dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'test-results/gpu.lock');
const manifest = {date: new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain') !== '', host: {cpu: cpus()[0].model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), os: process.platform, node: process.version}, steps: []};
const save = () => writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));

for (const step of chosen) {
  const cmd = step.cmd.replaceAll('OUT', out.replaceAll('\\', '/')), entry = {name: step.name, group: step.group, cmd, acBefore: step.group === 'gpu' ? acPower() : undefined};
  // Real-GPU steps that do not take the lock themselves run inside it here (one wait loop, 60 s poll).
  const ownLock = step.group === 'gpu' && !readFileSync(cmd.split(' ')[1], 'utf8').includes('gpu.lock');
  if (ownLock) for (;;) {try {mkdirSync(lock);break;} catch (e) {if (e.code !== 'EEXIST') throw e;console.log('gpu.lock held, waiting 60 s');spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);}}
  if (entry.acBefore === false) {entry.skipped = 'on battery';manifest.steps.push(entry);save();if (ownLock) rmSync(lock, {recursive: true, force: true});continue;}
  console.log(`[${manifest.steps.length + 1}/${chosen.length}] ${cmd}`);
  const start = Date.now(), run = spawnSync(cmd, {shell: true, encoding: 'utf8', maxBuffer: 1 << 28});
  if (ownLock) rmSync(lock, {recursive: true, force: true});
  Object.assign(entry, {exit: run.status, seconds: +((Date.now() - start) / 1000).toFixed(1), acAfter: step.group === 'gpu' ? acPower() : undefined});
  writeFileSync(join(out, `${step.name}.log`), `${cmd}\n\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  // Keep what the step wrote, then put the committed results back.
  entry.files = [];
  for (const [status, path] of changed()) {
    cpSync(path, join(out, 'files', path));entry.files.push(path);
    if (status === '??') rmSync(path, {force: true});else git('checkout', '--', path);
  }
  for (const a of step.artifacts ?? []) if (existsSync(a)) {cpSync(a, join(out, 'files', a));entry.files.push(a);}
  manifest.steps.push(entry);save();
  console.log(`  exit ${run.status} in ${entry.seconds} s${entry.files.length ? `, ${entry.files.length} result file(s)` : ''}`);
}
save();
const failed = manifest.steps.filter(s => s.exit !== 0);
console.log(`\n${manifest.steps.length} steps, ${failed.length} failed or skipped${failed.length ? ': ' + failed.map(s => s.name).join(', ') : ''}. Results: ${out}`);
