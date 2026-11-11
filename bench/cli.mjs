import { deferSpeed, isSpeedEntry } from '../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('bench/cli.mjs')
)
  process.exit(0);
// Margo's benchmark tool. From the repository root after `npm run build:packages`:
//   npm run bench                         every suite
//   npm run bench -- render objects       some suites (or npm run bench:render)
//   npm run bench -- --list               suites, cases and options
// docs/benchmarking.md covers options, the result format, the quiet-machine rules and adding suites and scenes.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPages, browserSession, externalEngines, serve } from './lib/browser.mjs';
import { environment, mainRoot, root } from './lib/env.mjs';
import { lockDir } from '../scripts/gpu-lock.mjs';
import { openGate, settle } from './lib/gate.mjs';
import {
  SCHEMA,
  compare,
  dirs,
  resolveTarget,
  saveBaseline,
  saveRecord,
  saveReference,
  writeRun,
} from './lib/results.mjs';
import { metricRecord, partialMetrics } from './lib/stats.mjs';
import { SUITES, loadSuite } from './suites/index.mjs';
import { browserLabel } from '../scripts/lib/browser.mjs';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    list: { type: 'boolean' },
    runs: { type: 'string' },
    warmup: { type: 'string' },
    frames: { type: 'string' },
    noise: { type: 'string', default: '0.1' },
    threshold: { type: 'string', default: '0.05' },
    smoke: { type: 'boolean' },
    label: { type: 'string' },
    compare: { type: 'string' },
    'no-compare': { type: 'boolean' },
    baseline: { type: 'boolean' },
    'baseline-name': { type: 'string' },
    record: { type: 'boolean' },
    engines: { type: 'string', default: 'margo' },
    'engine-bench': { type: 'string', default: resolve(mainRoot, '../engine-bench') },
    cases: { type: 'string' },
    'no-gate': { type: 'boolean' },
    'quiet-max': { type: 'string', default: '20' },
    'quiet-hold': { type: 'string', default: '20' },
    'gpu-max': { type: 'string', default: '20' },
    timeout: { type: 'string', default: '1800' },
    browser: { type: 'string', default: browserLabel() },
    port: { type: 'string', default: '0' },
    'no-fail': { type: 'boolean' },
    'require-valid': { type: 'boolean' },
  },
});
const log = (...a) => console.error(...a);
const num = (v, name) => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw new RangeError(`--${name} must be a non-negative number, got ${v}`);
  return x;
};

const smoke = !!o.smoke;
const options = {
  runs: num(o.runs ?? (smoke ? 3 : 5), 'runs'),
  warmup: num(o.warmup ?? 1, 'warmup'),
  frames: num(o.frames ?? (smoke ? 120 : 300), 'frames'),
  noise: num(o.noise, 'noise'),
  threshold: num(o.threshold, 'threshold'),
};
if (options.runs < 1) throw new RangeError('--runs must be at least 1');
const label = o.label ?? (smoke ? 'smoke' : 'dev');
if (!['dev', 'smoke', 'official'].includes(label)) throw new RangeError('--label is dev, smoke or official');
const external = externalEngines(resolve(o['engine-bench']));
const engines = o.engines === 'all' ? ['margo', ...Object.keys(external)] : o.engines.split(',').filter(Boolean);
const filters = o.cases?.split(',').filter(Boolean);

const chosen = positionals.length && !positionals.includes('all') ? positionals : SUITES;
const suites = [];
for (const name of chosen) suites.push(await loadSuite(name));

if (o.list) {
  console.log('Suites (npm run bench -- <suite> ... or npm run bench:<suite>):');
  const ctx = { engines, external, options, root, harness: {}, browser: () => null };
  for (const s of suites) {
    const cases = s.stub ? [] : await s.cases(ctx);
    console.log(`\n${s.name.padEnd(8)} ${s.title}${s.stub ? ` (stub: ${s.stub})` : ''} [${s.uses}]`);
    for (const c of cases) console.log(`  ${c.id}`);
  }
  console.log(
    `\nEngines: margo${Object.keys(external).length ? `, ${Object.keys(external).join(', ')}` : ''} (from ${o['engine-bench']})`,
  );
  process.exit(0);
}

const env = environment(),
  start = new Date(),
  id = `${start.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${env.engine.commit}-${label}`;
const result = {
  schema: SCHEMA,
  id,
  label,
  date: start.toISOString(),
  valid: true,
  invalid: [],
  options: { ...options, engines, suites: suites.map((s) => s.name), cases: filters ?? null },
  env,
  gate: null,
  suites: {},
};

const needsGpu = suites.some((s) => s.uses === 'gpu' && !s.stub),
  timed = suites.some((s) => s.uses !== 'none' && !s.stub);
const gateOptions = {
  skip: !!o['no-gate'],
  quietMax: num(o['quiet-max'], 'quiet-max'),
  quietHold: num(o['quiet-hold'], 'quiet-hold'),
  gpuMax: num(o['gpu-max'], 'gpu-max'),
  timeout: num(o.timeout, 'timeout'),
  log,
};
let gate = { release: () => {} };
if (timed) {
  gate = await openGate({ ...gateOptions, needsGpu, owner: process.env.MARGO_BENCH_OWNER ?? 'margo-bench' });
  result.gate = gate.record;
  result.invalid.push(...gate.invalid);
  // Child processes a suite starts (scripts that take the GPU lock themselves) must not wait for this run's lock.
  process.env.MARGO_GPU_LOCK_NESTED ??= join(lockDir, 'nested');
  process.env.MARGO_GPU_LOCK_NESTED_MODE ??= 'exclusive';
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    gate.release();
    process.exit(130);
  });

let server, session;
const ctx = {
  root,
  engines,
  external,
  options,
  smoke,
  log,
  env,
  harness: {
    frames: options.frames,
    warmup: smoke ? 30 : 60,
    gpuFrames: smoke ? 30 : 60,
    serialFrames: smoke ? 15 : 30,
  },
  shots: join(dirs.runs, id),
  /** The browser runner, started on first use (builds the scene page and serves it). */
  browser() {
    if (!session)
      throw new Error('internal: ctx.browser() before the browser started (a gpu suite must declare uses: "gpu")');
    return session;
  },
};
const startBrowser = async () => {
  if (session) return;
  await buildPages({ engines, external, log });
  server = await serve({ port: num(o.port, 'port'), external });
  session = browserSession({ channel: o.browser, base: server.url, shots: ctx.shots, log });
};

let failed = false;
try {
  for (const suite of suites) {
    const t0 = Date.now(),
      record = { title: suite.title, uses: suite.uses, status: 'ok', cases: {} };
    result.suites[suite.name] = record;
    if (suite.note) record.note = suite.note;
    if (suite.stub) {
      record.status = 'stub';
      record.note = suite.stub;
      log(`\n${suite.name}: stub (${suite.stub})`);
      continue;
    }
    log(`\n== ${suite.name}: ${suite.title}`);
    try {
      if (suite.uses === 'gpu') await startBrowser();
      const runs = suite.deterministic ? 1 : options.runs,
        warmup = suite.deterministic ? 0 : options.warmup;
      const cases = (await suite.cases(ctx)).filter((c) => !filters || filters.some((f) => c.id.includes(f)));
      // Cases that share a group (the same scene in several engines) run interleaved: every repetition runs each
      // engine once, in one fixed order with a random first engine (A B A B ...), so drift hits all of them alike.
      const groups = [];
      for (const c of cases) {
        const g = c.group && groups.find((x) => x.key === c.group);
        if (g) g.cases.push(c);
        else groups.push({ key: c.group, cases: [c] });
      }
      for (const group of groups) {
        const live = [];
        const cpuBefore = suite.uses !== 'none' ? (await settle(gateOptions)).cpuLoadPercent : undefined;
        for (const c of group.cases) {
          const entry = { title: c.title, ...(c.engine ? { engine: c.engine } : {}), metrics: {} };
          if (cpuBefore !== undefined) entry.cpuBefore = cpuBefore;
          record.cases[c.id] = entry;
          try {
            await c.setup?.();
            live.push({ c, entry, samples: {}, info: undefined, done: false });
          } catch (error) {
            entry.error = String(error?.message ?? error);
            record.status = 'error';
            failed = true;
            log(`  ${c.id.padEnd(34)} ERROR ${entry.error.split('\n')[0]}`);
          }
        }
        const first = Math.floor(Math.random() * live.length),
          order = live.map((_, k) => live[(first + k) % live.length]);
        if (live.length > 1)
          for (const item of live)
            item.entry.interleaved = { order: order.map((x) => x.c.id), firstEngine: order[0].c.engine ?? null };
        // A case that repeats internally (a whole script per sample) may ask for fewer runs.
        const total = (item) => (item.c.warmup ?? warmup) + (item.c.runs ?? runs),
          rounds = Math.max(0, ...live.map(total));
        for (let i = 0; i < rounds; i++)
          for (const item of order) {
            if (item.done || i >= total(item)) continue;
            const w = item.c.warmup ?? warmup;
            try {
              const r = await item.c.run({ first: i === w, warmup: i < w, index: i - w });
              if (r.unsupported) {
                item.entry.unsupported = r.unsupported;
                item.done = true;
                continue;
              }
              if (i < w) continue;
              for (const [m, v] of Object.entries(r.values)) (item.samples[m] ??= []).push(v ?? Number.NaN);
              item.info = r.info ?? item.info;
            } catch (error) {
              item.entry.error = String(error?.message ?? error);
              item.done = true;
              record.status = 'error';
              failed = true;
            }
          }
        for (const { c, entry, samples, info } of live) {
          try {
            await c.teardown?.();
          } catch (error) {
            entry.error ??= `teardown: ${error?.message ?? error}`;
          }
          const partial = entry.unsupported ? [] : partialMetrics(Object.keys(c.metrics), samples, c.runs ?? runs);
          if (partial.length) {
            entry.error ??= `missing or non-finite samples in ${partial.join(', ')} (${c.runs ?? runs} runs declared)`;
            record.status = 'error';
            failed = true;
          }
          if (entry.error) {
            log(`  ${c.id.padEnd(34)} ERROR ${entry.error.split('\n')[0]}`);
            continue;
          }
          for (const [m, def] of Object.entries(c.metrics)) {
            if (!samples[m]?.some(Number.isFinite)) continue;
            entry.metrics[m] = metricRecord(def, samples[m], options.noise);
          }
          if (info) entry.info = info;
          const primary = Object.entries(entry.metrics).filter(([, m]) => m.primary);
          for (const [m, rec] of primary)
            if (rec.noisy) result.invalid.push(`${suite.name}/${c.id} ${m} spread ${(rec.spread * 100).toFixed(1)}%`);
          log(
            `  ${c.id.padEnd(34)} ${
              entry.unsupported
                ? `skipped: ${entry.unsupported}`
                : primary
                    .map(([m, r]) => `${m} ${r.median}${r.unit ? ` ${r.unit}` : ''}${r.noisy ? ' (noisy)' : ''}`)
                    .join(', ') || `${Object.keys(entry.metrics).length} metrics`
            }`,
          );
        }
      }
    } catch (error) {
      record.status = 'error';
      record.error = String(error?.stack ?? error);
      failed = true;
      log(`${suite.name}: ERROR ${record.error}`);
    } finally {
      await suite.dispose?.();
    }
    record.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    log(`  ${suite.name} done in ${record.seconds} s`);
  }
} finally {
  await session?.close();
  server?.close();
  gate.release();
}

if (session?.hardware) env.browser = session.hardware;
// The conditions every engine ran under, recorded once for all of them (docs/benchmarking.md "Comparing engines").
if (session)
  result.settings = {
    browser: env.browser?.browser ?? { channel: o.browser },
    canvas: [1280, 720],
    dpr: 1,
    flags: [
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ],
    serving: 'production bundles, no compression, no cache, cross-origin isolated',
    assets: 'examples/assets (the same files for every engine)',
    frames: ctx.harness,
    runs: options.runs,
    warmupRuns: options.warmup,
    interleaved: engines.length > 1,
    engines: Object.fromEntries(
      engines.map((e) => [
        e,
        e === 'margo'
          ? { version: env.engine.version, commit: env.engine.commit }
          : { version: external[e]?.version ?? null, package: external[e]?.package ?? null },
      ]),
    ),
  };
if (label === 'official') {
  const defaults = options.runs >= 5 && options.frames >= 300 && !filters && !o['no-gate'];
  if (!defaults) result.invalid.push('official runs need the defaults: 5+ runs, 300+ frames, every case, the gate on');
}
result.valid = result.invalid.length === 0;
result.seconds = +((Date.now() - start) / 1000).toFixed(1);

const target = o['no-compare'] ? null : (o.compare ?? 'baseline'),
  base = target && resolveTarget(target, { machine: env.machine, exclude: id });
if (o.compare && !base) log(`bench: --compare ${o.compare}: no such run, commit or file`);
if (base) result.compare = compare(result, base, { threshold: options.threshold });

const files = writeRun(result);
if (o.baseline) log(`bench: baseline ${saveBaseline(result, o['baseline-name'])}`);
if (o.record) {
  log(`bench: record ${saveRecord(result)}`);
  const reference = saveReference(result);
  if (reference) log(`bench: in-browser reference ${reference}`);
}

// Regressions fail the run: byte and count metrics always, timings only from a valid run on the same machine.
const regressions = (result.compare?.rows ?? []).filter(
  (r) => r.status === 'regression' && (result.valid || result.suites[r.suite]?.cases[r.case]?.metrics[r.metric]?.exact),
);
log(`\n${result.valid ? 'VALID' : `INVALID (${result.invalid.join('; ')})`} run ${id} in ${result.seconds} s`);
if (result.compare)
  log(
    `compared with ${result.compare.against}: ${regressions.length} regressions${regressions.length ? `:\n${regressions.map((r) => `  ${r.suite}/${r.case} ${r.metric} ${r.before} -> ${r.after}`).join('\n')}` : ''}`,
  );
log(`report ${files.md}\n       ${files.html}\njson   ${files.json}`);
if (failed) process.exitCode = 1;
if (regressions.length && !o['no-fail']) process.exitCode = 1;
if (!result.valid && o['require-valid']) process.exitCode = process.exitCode || 2;
