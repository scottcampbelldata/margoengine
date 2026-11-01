// Biomes goal G1, measured so the result can be trusted: the committed revision (and the pre-J2 baseline) built from git
// objects, timed under the exclusive GPU lock after the AC, CPU and GPU quiet gate, with the machine settled between
// cases. Run from the repository root on a quiet machine: node packages/biomes/bench/placement-valid.mjs --runs=20
// It exits 1 when the lock, the gate, the repetition count, a case's spread (over 10%) or an input check fails. A valid
// run that misses a G1 target prints targetMet: false and exits 0: a measured miss, never a pass.
//
// Cases, each in its own Node process with GC between samples, on R16 tiles (40..47, 30) and the block (40..47, 40..47):
//   cpu       per sample a fresh world: relief heights of 8 tiles, fields with classification of 8 tiles, then (after
//             their neighbours are made, untimed) stored objects of the same 8 tiles. G1 one-thread = fields + objects.
//   workers   per sample a fresh world on 1 or 8 worker threads, warmed far from the block: the 8 x 8 block's fields,
//             classification and objects, wall time.
// Every sample's objects are hashed (every byte of each PlacedTile); samples of a case, and the two revisions, must agree.
// Options: --runs=<n> (20 or more), --baseline=<rev>|none (default the pre-J2 commit), --any-host (skip the A6000 check).
// Snapshots and the full result go to test-results/biomes-placement-valid/ (ignored by git).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');

/** Goal G1 (README): ms per km2 for fields plus objects on one thread, and the whole block on eight workers. */
export const TARGETS = Object.freeze({ oneThread: 400, eightWorkers: 70 });
/** The last commit before biomes J2 (band loading): the baseline the change is compared with. */
export const PRE_J2 = '14e4d813db33ec133fade6557a67d05da3f8a571';
export const MIN_RUNS = 20;
/** Largest allowed (max - min) / median of a case's samples. */
export const SPREAD_LIMIT = 0.1;
export const HOST = 'A6000';
export const GATE = Object.freeze({ quietMax: 20, quietHold: 20, gpuMax: 20, timeout: 1200 });
export const OWNER = 'biomes-placement-valid';
const TILE = 256,
  ROW = Object.freeze({ x: [40, 47], z: 30 }),
  BLOCK = Object.freeze({ x: 40, z: 40, side: 8 });
const km2 = (tiles) => (tiles * TILE * TILE) / 1e6;

/** Median, min, max and spread ((max - min) / median) of a list of numbers. */
export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b),
    n = s.length,
    median = n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : Number.NaN;
  return {
    n,
    median,
    min: s[0] ?? Number.NaN,
    max: s[n - 1] ?? Number.NaN,
    spread: n ? (s[n - 1] - s[0]) / median : Number.NaN,
  };
}

/** Why one measured case is not valid: too few samples, a sample that is not a positive time, a wide spread, or outputs that differ. */
export function caseFailures(id, c, { runs = MIN_RUNS, spreadLimit = SPREAD_LIMIT } = {}) {
  const out = [];
  if (!c || !Array.isArray(c.samples)) return [`${id}: no samples`];
  if (c.samples.length < Math.max(runs, MIN_RUNS))
    out.push(`${id}: ${c.samples.length} samples, need ${Math.max(runs, MIN_RUNS)}`);
  if (!c.samples.every((v) => Number.isFinite(v) && v > 0)) out.push(`${id}: a sample is not a positive finite time`);
  const { spread } = summarize(c.samples);
  if (!(spread <= spreadLimit))
    out.push(`${id}: spread ${(spread * 100).toFixed(1)}% over the ${(spreadLimit * 100).toFixed(0)}% limit`);
  if (c.digests && new Set(c.digests).size !== 1) out.push(`${id}: samples placed different objects`);
  return out;
}

/** Why the conditions of a run are not valid: battery, the lock not held by this process, the quiet gate, the host. */
export function conditionFailures({ gate, lockAtEnd, pid, owner = OWNER, host, anyHost = false, settles = [] }) {
  const out = [];
  if (!gate) return ['no gate record'];
  if (gate.ac === false) out.push('on battery');
  const ours = (l) =>
    l?.held === 'by the wrapping gpu-lock run' || (l?.mode === 'exclusive' && l.pid === pid && l.owner === owner);
  if (!ours(gate.lock)) out.push('the exclusive GPU lock was not held by this run when timing started');
  if (!ours(lockAtEnd)) out.push('the exclusive GPU lock was not held by this run when timing ended');
  if (!gate.quiet || gate.quiet.skipped) out.push('the CPU quiet gate did not run');
  else if (!(gate.quiet.cpuLoadPercent <= GATE.quietMax)) out.push(`CPU ${gate.quiet.cpuLoadPercent}% at the gate`);
  if (!gate.quiet?.gpu?.checked) out.push('the GPU quiet gate could not read GPU load');
  else if (gate.quiet.gpu.busy) out.push(`GPU busy at the gate (${gate.quiet.gpu.utilizationPercent.join(', ')}%)`);
  for (const s of settles) {
    if (s.ac === false) out.push(`on battery before ${s.case}`);
    if (!(s.cpuLoadPercent <= GATE.quietMax)) out.push(`CPU ${s.cpuLoadPercent}% before ${s.case}`);
  }
  if (!anyHost && !host?.gpu?.some((g) => String(g.name).includes(HOST))) out.push(`not the ${HOST} host`);
  return out;
}

/** G1 against its targets from a revision's cases (ms per km2 medians). */
export function g1(cases) {
  const oneThread =
      cases.fields && cases.placement
        ? summarize(cases.fields.samples).median + summarize(cases.placement.samples).median
        : Number.NaN,
    eight = cases.workers8 ? summarize(cases.workers8.samples).median : Number.NaN;
  return {
    oneThread,
    eightWorkers: eight,
    targets: TARGETS,
    targetMet: oneThread <= TARGETS.oneThread && eight <= TARGETS.eightWorkers,
  };
}

/** Every byte of a placed tile, as the placement output golden hashes it. */
function placedHash(t) {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      x: t.x,
      z: t.z,
      count: t.count,
      species: t.species,
      candidates: t.stats.candidates,
      accepted: t.stats.accepted,
      unresolved: t.stats.unresolved,
      rounds: [...t.stats.rounds],
      density: t.density.map((d) => [d.id, d.mesh, d.density]),
    }),
  );
  h.update(t.instances);
  h.update(t.canopy.data);
  h.update(t.exclusion.data);
  for (const d of t.density) h.update(d.data);
  return h.digest('hex');
}
const blockHash = (tiles) => createHash('sha256').update(tiles.map(placedHash).join()).digest('hex').slice(0, 16);

// ---- child: one case on one built package --------------------------------------------------------------------------

/** One case's samples (ms per km2) on the built package at `pkg`; run in a fresh `node --expose-gc` process. */
export async function measureCase(kind, pkg, runs, workers) {
  const dist = (entry) => pathToFileURL(join(pkg, 'dist', `${entry}.js`)).href,
    biomes = await import(dist('index')),
    { R16 } = await import(dist('presets')),
    { BiomePlacement } = await import(dist('placement')),
    create = (extra) =>
      biomes.BiomeWorld.create({
        seed: R16.seed,
        origin: R16.origin,
        size: R16.size,
        height: { relief: R16.relief },
        climate: R16.climate,
        ...extra,
      });
  const timed = async (fn) => {
    globalThis.gc?.();
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };
  if (kind === 'cpu') {
    const { createRelief } = await import(dist('relief')),
      relief = createRelief(R16.relief),
      heights = new Int32Array(TILE * TILE),
      row = Array.from({ length: ROW.x[1] - ROW.x[0] + 1 }, (_, i) => ROW.x[0] + i),
      out = { relief: { samples: [] }, fields: { samples: [] }, placement: { samples: [], digests: [] } };
    let check = 0;
    for (let i = -2; i < runs; i++) {
      const world = await create({ cache: 256 }),
        placement = BiomePlacement.attach(world);
      const r = await timed(() => {
        for (const x of row)
          for (let z = 0, k = 0; z < TILE; z++)
            for (let xi = 0; xi < TILE; xi++)
              heights[k++] = relief.height((x * TILE + xi) * 1000, (ROW.z * TILE + z) * 1000);
        check ^= heights[heights.length - 1];
      });
      const f = await timed(async () => {
        for (const x of row) await world.tile(x, ROW.z);
      });
      for (let z = ROW.z - 1; z <= ROW.z + 1; z++)
        for (let x = ROW.x[0] - 1; x <= ROW.x[1] + 1; x++) await world.tile(x, z);
      const placed = [];
      const p = await timed(async () => {
        for (const x of row) placed.push(await placement.tile(x, ROW.z));
      });
      placement.dispose();
      world.dispose();
      if (i < 0) continue;
      out.relief.samples.push(r / km2(row.length));
      out.fields.samples.push(f / km2(row.length));
      out.placement.samples.push(p / km2(row.length));
      out.placement.digests.push(blockHash(placed));
    }
    out.relief.check = check;
    return out;
  }
  const { ThreadWebWorker } = await import(pathToFileURL(join(pkg, 'tests', 'thread-worker.js')).href),
    c = { samples: [], digests: [] };
  for (let i = -1; i < runs; i++) {
    const world = await create({ workers, createWorker: () => new ThreadWebWorker() }),
      placement = BiomePlacement.attach(world);
    try {
      // Warm every worker on tiles far from the block.
      await Promise.all(
        Array.from({ length: 2 * workers }, (_, k) => placement.tile(4 + 4 * (k % 8), 4 + 8 * (k >> 3))),
      );
      let placed;
      const t = await timed(async () => {
        const jobs = [];
        for (let z = 0; z < BLOCK.side; z++)
          for (let x = 0; x < BLOCK.side; x++) jobs.push(placement.tile(BLOCK.x + x, BLOCK.z + z));
        placed = await Promise.all(jobs);
      });
      if (i < 0) continue;
      c.samples.push(t / km2(BLOCK.side * BLOCK.side));
      c.digests.push(blockHash(placed));
    } finally {
      placement.dispose();
      world.dispose();
    }
  }
  return { [`workers${workers}`]: c };
}

// ---- parent: snapshot, build, gate, run, validate ------------------------------------------------------------------

const git = (args, input) => {
  const r = spawnSync('git', ['-C', root, ...args], { input, maxBuffer: 1 << 28, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
};

/** Writes the files a build of `@margoengine/biomes` reads at `rev` from git objects (read only: no checkout, no worktree). */
export function snapshot(rev, dir) {
  const paths = [
    'packages/biomes/src',
    'packages/biomes/package.json',
    'packages/biomes/tsconfig.json',
    'packages/biomes/tests/thread-worker.js',
    'packages/shared',
    'packages/gltf/tsconfig.json',
  ];
  const entries = String(git(['ls-tree', '-r', '-z', rev, '--', ...paths]))
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { sha: meta.split(' ')[2], path };
    });
  const batch = git(['cat-file', '--batch'], entries.map((e) => e.sha).join('\n') + '\n');
  let at = 0;
  for (const e of entries) {
    const nl = batch.indexOf(10, at),
      size = Number(String(batch.subarray(at, nl)).split(' ')[2]),
      file = join(dir, e.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, batch.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return entries.length;
}

/** Builds the snapshot's package with the same Vite settings as scripts/build-optional.js (JavaScript only, no types). */
export async function buildSnapshot(pkg) {
  const { build } = await import('vite'),
    { buildWorkers } = await import(pathToFileURL(join(root, 'scripts', 'build-workers.js')).href),
    manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')),
    peers = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
    entries = {};
  for (const entry of Object.values(manifest.exports)) {
    const module = entry.import.slice('./dist/'.length, -'.js'.length);
    entries[module] = join(pkg, 'src', `${module}.ts`);
  }
  await build({
    root: pkg,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: join(pkg, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
      lib: { entry: entries, formats: ['es'], fileName: (_format, name) => `${name}.js` },
      rollupOptions: {
        external: (id) =>
          id.startsWith('node:') || [...peers, manifest.name].some((p) => id === p || id.startsWith(`${p}/`)),
      },
    },
  });
  await buildWorkers(pkg);
  const hash = (f) =>
    createHash('sha256')
      .update(readFileSync(join(pkg, 'dist', f)))
      .digest('hex')
      .slice(0, 16);
  return {
    'index.js': hash('index.js'),
    'placement.js': hash('placement.js'),
    'workers/biomes.js': hash('workers/biomes.js'),
  };
}

function runChild(kind, pkg, runs, workers) {
  const r = spawnSync(
    process.execPath,
    ['--expose-gc', import.meta.filename, `--child=${kind}`, `--pkg=${pkg}`, `--runs=${runs}`, `--workers=${workers}`],
    { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24, timeout: 25 * 60_000, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (r.status !== 0)
    throw new Error(`case ${kind}${kind === 'workers' ? workers : ''} exited ${r.status ?? r.signal}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

const round = (v) => Math.round(v * 10) / 10;
const brief = (c) => {
  const s = summarize(c.samples);
  return {
    median: round(s.median),
    min: round(s.min),
    max: round(s.max),
    spreadPercent: round(s.spread * 100),
    n: s.n,
  };
};

async function parent(argv) {
  const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runs = Number(opt('runs') ?? MIN_RUNS),
    baselineArg = opt('baseline') ?? PRE_J2,
    anyHost = argv.includes('--any-host'),
    failures = [],
    log = (m) => console.error(m);
  if (!Number.isInteger(runs) || runs < MIN_RUNS) failures.push(`--runs must be an integer of ${MIN_RUNS} or more`);
  const revision = String(git(['rev-parse', 'HEAD'])).trim(),
    dirty = String(
      git(['status', '--porcelain', '--untracked-files=no', '--', 'packages/biomes', 'packages/shared']),
    ).trim();
  if (dirty)
    failures.push('packages/biomes or packages/shared has uncommitted changes: commit them, the run measures HEAD');
  const baseline = baselineArg === 'none' ? null : String(git(['rev-parse', `${baselineArg}^{commit}`])).trim();
  const out = join(root, 'test-results', 'biomes-placement-valid'),
    revs = [{ name: 'current', rev: revision }, ...(baseline ? [{ name: 'baseline', rev: baseline }] : [])];
  const result = {
    suite: 'biomes-placement-valid',
    command: `node packages/biomes/bench/placement-valid.mjs ${argv.join(' ')}`.trim(),
    revision,
    baseline,
    runs,
    spreadLimit: SPREAD_LIMIT,
    targets: TARGETS,
    work: { row: ROW, block: BLOCK, tileMetres: TILE, world: 'R16' },
  };
  if (failures.length) return finish(result, failures, out);
  for (const r of revs) {
    r.pkg = join(out, r.rev.slice(0, 12), 'packages', 'biomes');
    rmSync(join(out, r.rev.slice(0, 12)), { recursive: true, force: true });
    r.files = snapshot(r.rev, join(out, r.rev.slice(0, 12)));
    r.build = await buildSnapshot(r.pkg);
  }
  const { environment } = await import(pathToFileURL(join(root, 'bench', 'lib', 'env.mjs')).href),
    { openGate, settle, acPower } = await import(pathToFileURL(join(root, 'bench', 'lib', 'gate.mjs')).href),
    { status } = await import(pathToFileURL(join(root, 'scripts', 'gpu-lock.mjs')).href);
  const env = environment();
  result.host = { ...env.host, gpu: env.gpu, machine: env.machine };
  const gate = await openGate({ needsGpu: true, skip: false, ...GATE, owner: OWNER, log });
  const settles = [];
  try {
    result.gate = gate.record;
    failures.push(...gate.invalid);
    const plan = [
      ['cpu', 1],
      ['workers', 1],
      ['workers', 8],
    ];
    for (const r of revs) r.cases = {};
    for (const [kind, workers] of plan)
      for (const r of revs) {
        const id = `${r.name}:${kind}${kind === 'workers' ? workers : ''}`,
          s = await settle({ skip: false, ...GATE, log });
        settles.push({ case: id, ac: acPower(), ...s });
        log(`placement-valid: ${id}`);
        Object.assign(r.cases, runChild(kind, r.pkg, runs, workers));
      }
    const nested = !!process.env.MARGO_GPU_LOCK_NESTED;
    result.lockAtEnd = nested ? { held: 'by the wrapping gpu-lock run' } : status();
  } finally {
    gate.release();
  }
  result.settles = settles;
  failures.push(
    ...conditionFailures({
      gate: result.gate,
      lockAtEnd: result.lockAtEnd,
      pid: process.pid,
      host: result.host,
      anyHost,
      settles,
    }),
  );
  const baselineFailures = [];
  for (const r of revs) {
    const list = r.name === 'current' ? failures : baselineFailures;
    for (const [id, c] of Object.entries(r.cases)) list.push(...caseFailures(`${r.name}:${id}`, c, { runs }));
    result[r.name] = {
      revision: r.rev,
      snapshotFiles: r.files,
      build: r.build,
      cases: Object.fromEntries(Object.entries(r.cases).map(([id, c]) => [id, brief(c)])),
      digests: Object.fromEntries(
        Object.entries(r.cases)
          .filter(([, c]) => c.digests)
          .map(([id, c]) => [id, c.digests[0]]),
      ),
      g1: g1(r.cases),
    };
  }
  if (baseline) {
    const [cur, base] = [result.current, result.baseline],
      same = Object.keys(cur.digests).every((id) => cur.digests[id] === base.digests[id]);
    // Different objects from the two revisions: band loading changed output bytes. That is a failure of the change.
    if (!same) failures.push('the current revision placed different objects from the baseline');
    result.comparison = baselineFailures.length
      ? { comparable: false, reasons: baselineFailures }
      : {
          comparable: same,
          sameObjects: same,
          currentOverBaseline: Object.fromEntries(
            Object.keys(cur.cases).map((id) => [
              id,
              Math.round((cur.cases[id].median / base.cases[id].median) * 1000) / 1000,
            ]),
          ),
        };
  }
  writeFileSync(
    join(out, `result-${revision.slice(0, 12)}.json`),
    JSON.stringify({ ...result, raw: Object.fromEntries(revs.map((r) => [r.name, r.cases])) }, null, 1),
  );
  return finish(result, failures, out);
}

function finish(result, failures, out) {
  result.valid = failures.length === 0;
  result.failures = failures;
  result.targetMet = result.valid && result.current ? result.current.g1.targetMet : false;
  result.saved = existsSync(out) ? 'test-results/biomes-placement-valid/' : undefined;
  console.log(JSON.stringify(result, null, 1));
  return result.valid ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2),
    kind = argv.find((a) => a.startsWith('--child='))?.slice(8);
  if (kind) {
    const get = (n) => argv.find((a) => a.startsWith(`--${n}=`)).slice(n.length + 3);
    console.log(JSON.stringify(await measureCase(kind, get('pkg'), Number(get('runs')), Number(get('workers')))));
  } else {
    try {
      process.exitCode = await parent(argv);
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            suite: 'biomes-placement-valid',
            valid: false,
            targetMet: false,
            failures: [String(error?.stack ?? error)],
          },
          null,
          1,
        ),
      );
      process.exitCode = 1;
    }
  }
}
