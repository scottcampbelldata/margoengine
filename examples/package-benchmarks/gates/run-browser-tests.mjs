// Runs every real-browser test script once, serially, under the GPU lock and on AC power (HANDOFF item 0).
// From the repository root, after `npm run build:packages`:
//   node examples/package-benchmarks/gates/run-browser-tests.mjs [--only=substring,substring] [--label=browser-tests]
// Takes test-results/gpu.lock in the main checkout around each script (scripts that take it themselves run without it),
// checks AC power before and after each script and repeats a run that started or ended on battery. Writes
// examples/package-benchmarks/results/gates-<label>.json with pass/fail, duration and the output tail per script.
import {spawn, execFileSync} from 'node:child_process';
import {mkdir, rm, writeFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {acPower} from '../cad/power.mjs';

const root = resolve(import.meta.dirname, '../../..');
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const only = arg('only', '').split(',').filter(Boolean), label = arg('label', 'browser-tests');
const lock = process.env.MARGO_GPU_LOCK_NESTED ?? resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const selfLocking = new Set(['packages/staging/test/browser-check.mjs']);

const list = async (dir, test) => (await readdir(resolve(root, dir)).catch(() => [])).filter(test).map(f => `${dir}/${f}`);
const scripts = [
  ...await list('scripts', f => /^(modern|margo)-.*-tests\.js$/.test(f)),
  ...(await Promise.all((await readdir(resolve(root, 'packages'))).map(p => list(`packages/${p}/test`, f => /browser.*\.mjs$|-check\.mjs$/.test(f))))).flat(),
  ...await list('examples/gameplay-sandbox/test', f => f.endsWith('.browser.mjs')),
].filter((s, i, a) => a.indexOf(s) === i).filter(s => !only.length || only.some(o => s.includes(o)));

// Inputs some scripts read but do not build themselves (each command runs once, before the first script needing it).
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const starter = [npmCli, 'run', 'build', '--workspace', '@margoengine/starter-vite'];
const prepare = {
  'scripts/modern-usdz-tests.js': [['--test', 'packages/usdz/tests/usdz.test.js']],
  'scripts/modern-finalization-tests.js': [starter],
  'scripts/modern-browser-tests.js': [starter, [npmCli, 'run', 'build', '--workspace', '@margoengine/starter-next']],
};
const prepared = new Set();
async function takeLock() {for (;;) {try {await mkdir(lock); return;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('gpu.lock held, waiting'); await sleep(15_000);}}}
function run(script) {
  const args = Array.isArray(script) ? script : [script];
  return new Promise(done => {
    // npm_execpath: the package-consumer scripts pack workspaces with npm and insist on running under it.
    const started = Date.now(), child = spawn(process.execPath, args, {cwd: root, env: {...process.env, npm_execpath: npmCli}}); let out = '';
    const timer = setTimeout(() => {out += '\n[runner] timed out after 60 min'; child.kill();}, 60 * 60_000);
    child.stdout.on('data', d => {out += d; if (process.env.DEBUG) process.stdout.write(d);});
    child.stderr.on('data', d => {out += d; if (process.env.DEBUG) process.stderr.write(d);});
    child.on('close', code => {clearTimeout(timer); done({code, seconds: +((Date.now() - started) / 1000).toFixed(1), out});});
  });
}

await mkdir(dirname(lock), {recursive: true});
const report = {label, date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), results: [], discarded: 0};
for (const script of scripts) {
  for (const command of prepare[script] ?? []) {
    const key = command.join(' '); if (prepared.has(key)) continue; prepared.add(key);
    const r = await run(command); console.log(r.code === 0 ? 'prepared' : 'PREPARE FAILED', key); if (r.code !== 0) console.log(r.out.slice(-2000));
  }
  for (;;) {
    while (acPower() === false) {console.log('on battery, waiting for AC'); await sleep(30_000);}
    const locks = !selfLocking.has(script); if (locks) await takeLock();
    let r, before, after;
    try {before = acPower(); r = await run(script); after = acPower();} finally {if (locks) await rm(lock, {recursive: true, force: true});}
    if (before === false || after === false) {report.discarded++; console.log('discarded (battery)', script); continue;}
    const tail = r.out.trim().split('\n').slice(-25).join('\n');
    report.results.push({script, pass: r.code === 0, exitCode: r.code, seconds: r.seconds, acPowerBefore: before, acPowerAfter: after, tail});
    console.log(r.code === 0 ? 'PASS' : 'FAIL', script, `${r.seconds}s`); if (r.code !== 0) console.log(tail.split('\n').slice(-8).join('\n'));
    break;
  }
}
await mkdir(resolve(root, 'examples/package-benchmarks/results'), {recursive: true});
await writeFile(resolve(root, `examples/package-benchmarks/results/gates-${label}.json`), JSON.stringify(report, null, 1));
console.log(`${report.results.filter(r => r.pass).length}/${report.results.length} passed; wrote examples/package-benchmarks/results/gates-${label}.json`);
