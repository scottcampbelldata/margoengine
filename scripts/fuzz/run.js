// Fuzz runner: seeded, deterministic fuzzing for parsers of untrusted input (launch gate 11a). No dependencies.
//
//   npm run fuzz                         every target, 60 s each, seed 1, one process at a time
//   npm run fuzz -- --target=loaders/ply --seconds=300 --seed=7
//   npm run fuzz -- --short              the bounded run in test:release (a few seconds per target)
//   npm run fuzz -- --replay=<file> --target=<name>     run one saved input
//   npm run fuzz -- --minimize=<file> --target=<name>   shrink a saved input that still fails the same way
//   npm run fuzz -- --dump=<iteration> --target=<name> [--seed=<s>]   write one input (a killed hang) to a file
//
// Each target runs in its own Node child (`--jobs` at most 2: the laptop crashed once under an all-core burn), so a
// hang is killed and reported with the seed and iteration that reproduce it. Input i of seed s is always the same
// bytes: generators and mutators draw only from mulberry32(s * 1_000_003 + i). An input passes when the parser
// returns or throws a named error (the target's `named` test) within `timeMs` and without allocating more than the
// memory budget; anything else (an engine TypeError/RangeError from deep inside, a Wasm trap, a dead worker, a hang,
// a memory blowup) is a finding. Findings are deduplicated by signature and their first input is saved to
// test-results/fuzz/<target>/. Targets live in scripts/fuzz/targets-*.js (each default-exports an array).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, concat, input } from './harness.js';

const root = resolve(import.meta.dirname, '../..');

async function loadTargets() {
  const targets = [];
  for (const file of readdirSync(import.meta.dirname)
    .filter((f) => /^targets-.*\.js$/.test(f))
    .sort())
    targets.push(...(await import(pathToFileURL(join(import.meta.dirname, file)).href)).default);
  return targets;
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.includes('=') ? hit.slice(name.length + 3) : true;
};

/** Child: fuzz one target for `seconds` or `iterations`, streaming progress and findings as JSON lines. */
async function child() {
  const name = arg('target'),
    seed = Number(arg('seed', 1)),
    seconds = Number(arg('seconds', 60)),
    iterations = Number(arg('iterations', Infinity));
  const target = (await loadTargets()).find((t) => t.name === name);
  if (!target) throw new Error(`no fuzz target ${name}`);
  // stdout carries the JSON lines; what parsers print themselves (web-ifc logs every bad file) goes to stderr, capped.
  let printed = 0;
  console.log =
    console.info =
    console.warn =
    console.error =
      (...args) => {
        if (printed++ < 20) process.stderr.write(`[${name}] ${args.join(' ').slice(0, 200)}\n`);
      };
  await target.setup?.();
  const context = { seeds: await target.seeds(), text: !!target.text, nest: target.nest };
  let i = 0;
  process.on('unhandledRejection', (error) => {
    report({
      finding: { kind: 'unhandled', message: String(error?.stack ?? error).slice(0, 300), iteration: i, seed },
    });
  });
  const report = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const end = performance.now() + seconds * 1000,
    found = new Set(),
    dir = join(root, 'test-results/fuzz', name.replace(/\//g, '_'));
  for (const s of context.seeds) {
    const finding = await check(target, s);
    if (finding) report({ finding: { ...finding, seedFile: true, how: 'seed file' } });
  }
  for (; i < iterations && performance.now() < end; i++) {
    report({ at: i });
    const { bytes, how } = await input(target, context, seed, i),
      finding = await check(target, bytes);
    if (finding && !found.has(finding.signature)) {
      found.add(finding.signature);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}.bin`);
      writeFileSync(file, bytes);
      report({ finding: { ...finding, iteration: i, seed, how, file, size: bytes.length } });
    }
  }
  await target.teardown?.();
  report({ done: i });
}

/** Writes input `iteration` of `seed` for a target (to replay a hang the runner killed). */
async function dump() {
  const target = (await loadTargets()).find((t) => t.name === arg('target'));
  if (!target) throw new Error('dump needs --target=<name>');
  await target.setup?.();
  const context = { seeds: await target.seeds(), text: !!target.text, nest: target.nest },
    { bytes, how } = await input(target, context, Number(arg('seed', 1)), Number(arg('dump'))),
    out = join(root, 'test-results/fuzz', `${target.name.replace(/\//g, '_')}-${arg('seed', 1)}-${arg('dump')}.bin`);
  mkdirSync(join(root, 'test-results/fuzz'), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${how}: ${bytes.length} B -> ${out}`);
  await target.teardown?.();
}

async function replay(minimize) {
  const target = (await loadTargets()).find((t) => t.name === arg('target'));
  if (!target) throw new Error('replay needs --target=<name>');
  await target.setup?.();
  let bytes = new Uint8Array(readFileSync(minimize || arg('replay')));
  const first = await check(target, bytes);
  console.log(first ?? 'pass');
  if (!minimize || !first) return target.teardown?.();
  // Delta debugging: drop chunks (halving their size) while the same signature remains.
  for (let size = bytes.length >> 1; size >= 1; size >>= 1)
    for (let at = 0; at + size <= bytes.length; ) {
      const candidate = concat(bytes.subarray(0, at), bytes.subarray(at + size)),
        again = await check(target, candidate);
      if (again?.signature === first.signature) bytes = candidate;
      else at += size;
    }
  const out = `${minimize}.min`;
  writeFileSync(out, bytes);
  console.log(`minimized ${bytes.length} B -> ${out}`);
  await target.teardown?.();
}

/** Parent: run targets one (or `--jobs`, at most 2) at a time, each in a child with a hard time limit. */
async function main() {
  const short = arg('short', false),
    seed = Number(arg('seed', 1)),
    seconds = Number(arg('seconds', short ? 4 : 60)),
    jobs = Math.min(2, Math.max(1, Number(arg('jobs', 1)))),
    wanted = arg('target', null);
  const all = await loadTargets(),
    list = wanted ? all.filter((t) => String(wanted).split(',').includes(t.name)) : all;
  if (!list.length) throw new Error(`no fuzz target matches ${wanted}`);
  console.log(`fuzz: ${list.length} targets, seed ${seed}, ${seconds} s each, ${jobs} at a time`);
  const results = [];
  const runOne = (target) =>
    new Promise((done) => {
      const budget = seconds * (target.weight ?? 1),
        args = ['--expose-gc', '--max-old-space-size=3072', import.meta.filename, '--child'];
      args.push(`--target=${target.name}`, `--seed=${seed}`, `--seconds=${budget}`);
      const proc = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
      const result = { target: target.name, iterations: 0, findings: [], at: -1 };
      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        // A parser library that prints a huge line must not stall the runner (it would scan it again per chunk).
        if (buffer.length > 1 << 20 && buffer.indexOf('\n') < 0) buffer = '';
        for (let n = buffer.indexOf('\n'); n >= 0; n = buffer.indexOf('\n')) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          let data;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }
          if ('at' in data) result.at = data.at;
          if ('done' in data) result.iterations = data.done;
          if (data.finding) result.findings.push(data.finding);
        }
      });
      // A child past its budget plus the per-input limit is stuck in one input: that input is a hang.
      const limit = setTimeout(
        () => {
          result.findings.push({ kind: 'hang', iteration: result.at, seed, message: 'killed: no progress' });
          proc.kill('SIGKILL');
        },
        (budget + Number(process.env.FUZZ_GRACE ?? 60) + 2 * ((target.timeMs ?? 2000) / 1000)) * 1000,
      );
      proc.on('exit', (code, signal) => {
        clearTimeout(limit);
        if (!result.iterations) result.iterations = result.at + 1;
        if (code && !signal)
          result.findings.push({ kind: 'crash', iteration: result.at, seed, message: `exit ${code}` });
        results.push(result);
        const status = result.findings.length ? `${result.findings.length} FINDING(S)` : 'ok';
        console.log(
          `${target.name.padEnd(24)} seed ${seed}  ${String(result.iterations).padStart(7)} inputs  ${status}`,
        );
        for (const f of result.findings)
          console.log(
            `  ${f.kind} ${f.message}${f.iteration !== undefined ? ` (iteration ${f.iteration}, ${f.how ?? ''})` : ''}${f.file ? `\n    ${f.file}` : ''}${f.stack ? `\n    ${f.stack.join('\n    ')}` : ''}`,
          );
        done();
      });
    });
  const queue = [...list];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (queue.length) await runOne(queue.shift());
    }),
  );
  mkdirSync(join(root, 'test-results/fuzz'), { recursive: true });
  writeFileSync(
    join(root, 'test-results/fuzz/summary.json'),
    `${JSON.stringify({ seed, seconds, results }, null, 2)}\n`,
  );
  const total = results.reduce((n, r) => n + r.findings.length, 0);
  console.log(`fuzz: ${total} finding(s); summary in test-results/fuzz/summary.json`);
  process.exitCode = total ? 1 : 0;
}

if (arg('child', false)) await child();
else if (arg('dump', false)) await dump();
else if (arg('replay', false)) await replay(null);
else if (arg('minimize', false)) await replay(arg('minimize'));
else await main();
