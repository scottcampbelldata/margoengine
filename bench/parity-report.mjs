// Turns a parity run (npm run bench -- parity --engines=margo,<three engines>) into docs/whitepaper/perf-vs-threejs.md:
// a verdict per row of docs/threejs-parity.md (Margo faster, equal or slower than the fastest three.js backend, or why
// there is no benchmark), the raw medians per scene and engine, how close the two images are, and the JavaScript each
// engine shipped for the feature. Usage: node bench/parity-report.mjs [run.json] [--out=docs/whitepaper/perf-vs-threejs.md]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { mainRoot, root } from './lib/env.mjs';
import { dirs } from './lib/results.mjs';
import { SCENES, caseId } from './scenes/catalog.js';
import { ROWS } from './scenes/parity.js';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'docs/whitepaper/perf-vs-threejs.md' },
    'engine-bench': { type: 'string', default: resolve(mainRoot, '../engine-bench') },
    threshold: { type: 'string', default: '0.05' },
    // --print: one line per scene in the run (verdict, primary medians, image match) and no document written.
    print: { type: 'boolean' },
    partial: { type: 'boolean' },
  },
});
const threshold = Number(o.threshold);

/** The newest run that has the parity suite, or the file given. */
function runFile() {
  if (positionals[0]) return resolve(positionals[0]);
  const runs = readdirSync(dirs.runs)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of runs) {
    const r = JSON.parse(readFileSync(join(dirs.runs, f), 'utf8'));
    if (r.suites?.parity) return join(dirs.runs, f);
  }
  throw new Error('no parity run in benchmarks/runs; run npm run bench:parity first');
}
const file = runFile(),
  run = JSON.parse(readFileSync(file, 'utf8')),
  cases = run.suites.parity.cases,
  engines = run.options.engines,
  threes = engines.filter((e) => e.startsWith('three'));

/** The parity matrix rows (section.row, feature, status) as numbered in docs/threejs-parity.md. */
function matrixRows() {
  const out = [];
  let section = 0,
    i = 0,
    on = false;
  for (const line of readFileSync(resolve(root, 'docs/threejs-parity.md'), 'utf8').split('\n')) {
    const h = /^### (\d+)\./.exec(line);
    if (h) {
      section = Number(h[1]);
      i = 0;
      on = true;
      continue;
    }
    if (/^## /.test(line)) on = false;
    if (!on || !line.startsWith('| ')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === 'three.js' || /^-+$/.test(cells[1])) continue;
    out.push({ id: `${section}.${++i}`, feature: cells[1], status: cells[2] });
  }
  return out;
}

// Perceptual difference of two screenshots: mean CIE76 delta E in Lab and the share of pixels with delta E over 10,
// plus SSIM of the luminance over 8 x 8 windows. Engines shade with different BRDF details, so the bar is "the same
// picture", not identical pixels: SSIM >= 0.9 and mean delta E <= 6 count as a match.
const lab = (r, g, b) => {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
    [R, G, B] = [lin(r), lin(g), lin(b)],
    f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116),
    x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047),
    y = f(0.2126 * R + 0.7152 * G + 0.0722 * B),
    z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
async function imageDiff(a, b) {
  const [A, B] = await Promise.all(
    [a, b].map((p) => sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true })),
  );
  if (A.info.width !== B.info.width || A.info.height !== B.info.height) return { error: 'sizes differ' };
  const w = A.info.width,
    h = A.info.height,
    la = new Float32Array(w * h),
    lb = new Float32Array(w * h);
  let sum = 0,
    over = 0;
  for (let i = 0; i < w * h; i++) {
    const p = lab(A.data[i * 3], A.data[i * 3 + 1], A.data[i * 3 + 2]),
      q = lab(B.data[i * 3], B.data[i * 3 + 1], B.data[i * 3 + 2]),
      d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    sum += d;
    if (d > 10) over++;
    la[i] = p[0];
    lb[i] = q[0];
  }
  let ssim = 0,
    n = 0;
  const c1 = (0.01 * 100) ** 2,
    c2 = (0.03 * 100) ** 2;
  for (let y = 0; y + 8 <= h; y += 8)
    for (let x = 0; x + 8 <= w; x += 8) {
      let ma = 0,
        mb = 0;
      for (let j = 0; j < 8; j++)
        for (let k = 0; k < 8; k++) (ma += la[(y + j) * w + x + k]), (mb += lb[(y + j) * w + x + k]);
      ma /= 64;
      mb /= 64;
      let va = 0,
        vb = 0,
        cov = 0;
      for (let j = 0; j < 8; j++)
        for (let k = 0; k < 8; k++) {
          const da = la[(y + j) * w + x + k] - ma,
            db = lb[(y + j) * w + x + k] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      ssim += ((2 * ma * mb + c1) * (2 * (cov / 63) + c2)) / ((ma * ma + mb * mb + c1) * (va / 63 + vb / 63 + c2));
      n++;
    }
  const meanDE = sum / (w * h),
    s = ssim / n;
  return {
    meanDeltaE: +meanDE.toFixed(2),
    over10: +((over / (w * h)) * 100).toFixed(1),
    ssim: +s.toFixed(3),
    match: s >= 0.9 && meanDE <= 6,
  };
}

/** gzip bytes of the scripts a case fetched that the other engine's page did not (the feature's own JavaScript). */
function featureBytes(entry, other) {
  const mine = entry?.info?.scripts ?? [],
    shared = new Set(other?.info?.scripts ?? []);
  let total = 0;
  for (const name of mine) {
    if (shared.has(name)) continue;
    const ext = /^\/ext\/([^/]+)\/(.*)$/.exec(name),
      path = ext
        ? join(o['engine-bench'], 'margo-bench', 'dist', ext[1], ext[2])
        : join(root, 'test-results/bench/dist', name.replace(/^\/bench\//, ''));
    if (existsSync(path)) total += gzipSync(readFileSync(path), { level: 9 }).length;
  }
  return total;
}

const med = (entry, m) => entry?.metrics?.[m]?.median;
// An engine that lacks a scene says so with an error naming it (three-parity.js: "not implemented", "unsupported:").
const unsupported = (e) => !!e && (!!e.unsupported || /unsupported:|not implemented/.test(e.error ?? ''));
const spread = (entry, m) => entry?.metrics?.[m]?.spread ?? 0;
/** -1 Margo better, 1 Margo worse, 0 within the threshold or the spread of either. */
function compareMetric(m, margo, three, better = 'lower') {
  const a = med(margo, m),
    b = med(three, m);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const rel = (better === 'lower' ? a - b : b - a) / Math.max(Math.abs(b), 1e-9),
    noise = Math.max(threshold, spread(margo, m), spread(three, m));
  return rel > noise ? 1 : rel < -noise ? -1 : 0;
}

const shots = join(dirs.runs, run.id);
const sceneResults = [];
for (const [key, entry] of Object.entries(cases)) {
  if (entry.engine && entry.engine !== 'margo') continue;
  // The case id is the scene id, then any non-default parameters: take the longest scene id it starts with.
  const scene =
    Object.keys(SCENES)
      .filter((s) => key === s || key.startsWith(`${s}-`))
      .sort((x, y) => y.length - x.length)[0] ?? key;
  const kind = SCENES[scene]?.kind === 'task' ? 'task' : 'frame',
    primary = kind === 'task' ? ['taskMs'] : ['cpuMs', 'gpuMs'];
  const others = threes
    .map((e) => ({ engine: e, entry: cases[`${key}@${e}`] }))
    .filter((x) => x.entry && !x.entry.error && !x.entry.unsupported);
  // The bar is the fastest three.js backend on the scene's first primary metric.
  const best = others.sort(
    (x, y) => (med(x.entry, primary[0]) ?? Infinity) - (med(y.entry, primary[0]) ?? Infinity),
  )[0];
  let verdict = 'not run';
  const why = [];
  if (unsupported(entry)) verdict = 'Margo missing';
  else if (entry.error) verdict = 'error';
  else if (!best)
    verdict = threes.length && threes.every((e) => unsupported(cases[`${key}@${e}`])) ? 'three missing' : 'not run';
  else {
    const votes = primary.map((m) => compareMetric(m, entry, best.entry)).filter((v) => v !== null);
    verdict = votes.includes(1) ? 'slower' : votes.includes(-1) ? 'faster' : votes.length ? 'equal' : 'not run';
  }
  let diff = null;
  if (kind === 'frame' && best) {
    const a = join(shots, `parity-${key}.png`),
      b = join(shots, `parity-${key}@${best.engine}.png`);
    if (existsSync(a) && existsSync(b)) diff = await imageDiff(a, b);
  }
  sceneResults.push({
    key,
    scene,
    kind,
    verdict,
    margo: entry,
    best,
    others,
    diff,
    bytes: best ? { margo: featureBytes(entry, best.entry), three: featureBytes(best.entry, entry) } : null,
    why,
  });
}
const f = (x, d = 2) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d)) : 'n/a');
if (o.print) {
  for (const r of sceneResults) {
    const m = r.kind === 'task' ? ['taskMs'] : ['cpuMs', 'gpuMs'],
      v = (e) => (e?.error ? `error ${e.error.slice(0, 100)}` : m.map((k) => f(med(e, k))).join('/'));
    const missing = threes
      .map(
        (e) =>
          `${e}: ${cases[`${r.key}@${e}`]?.error?.slice(0, 100) ?? (cases[`${r.key}@${e}`]?.unsupported ? 'unsupported' : 'missing')}`,
      )
      .join('; ');
    console.log(
      `${r.key.padEnd(26)} ${r.verdict.padEnd(13)} margo ${v(r.margo)}  ${r.best ? `${r.best.engine} ${v(r.best.entry)}` : missing}` +
        `${r.diff ? `  image ssim ${r.diff.ssim} dE ${r.diff.meanDeltaE}${r.diff.match ? '' : ' DIFFERS'}` : ''}` +
        `${r.kind === 'task' ? `  output margo ${JSON.stringify(r.margo.info?.output ?? null)} three ${JSON.stringify(r.best?.entry.info?.output ?? null)}` : ''}`,
    );
  }
  process.exit(0);
}

// Only a full matrix run enters the ledger: a smoke or partial run would freeze a first result nobody measured
// properly. --partial allows a run of some cases (each still enters once, as its first or a later result).
if ((run.options.cases || run.options.runs < 3) && !o.partial) {
  console.error(
    'parity report: this run has --cases or fewer than 3 runs; it is not added to the ledger (use --print, or --partial)',
  );
  process.exit(1);
}

// The ledger (Scott's transparency rule): every scene's first result is kept as it was measured, losses included, and
// never overwritten. Later runs are added after it, so a fixed row shows its before and after numbers side by side.
// It is committed next to the document; the document is rendered from it, not from this run alone.
const ledgerFile = resolve(root, o.out.replace(/\.md$/, '.json')),
  ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { scenes: {} };
const KEEP = [
  'cpuMs',
  'gpuMs',
  'fps',
  'firstFrameMs',
  'loadMs',
  'buildMs',
  'taskMs',
  'coldMs',
  'jsHeapMB',
  'gpuMB',
  'drawCalls',
];
const compact = (e) =>
  e &&
  Object.fromEntries(
    KEEP.filter((m) => e.metrics?.[m]).map((m) => [m, { median: e.metrics[m].median, spread: e.metrics[m].spread }]),
  );
const err = (e) => (e?.error ? e.error.slice(0, 200) : e?.unsupported ? `unsupported: ${e.unsupported}` : undefined);
for (const r of sceneResults) {
  const snap = {
    run: run.id,
    date: run.date,
    commit: run.env?.engine?.commit,
    label: run.label,
    valid: run.valid,
    kind: r.kind,
    verdict: r.verdict,
    margo: compact(r.margo),
    margoError: err(r.margo),
    three: r.best ? { engine: r.best.engine, metrics: compact(r.best.entry) } : null,
    others: threes
      .filter((e) => e !== r.best?.engine)
      .map((e) => ({ engine: e, metrics: compact(cases[`${r.key}@${e}`]), error: err(cases[`${r.key}@${e}`]) })),
    image: r.diff,
    bytes: r.bytes,
  };
  const slot = (ledger.scenes[r.key] ??= {});
  if (!slot.first) slot.first = snap;
  else if (slot.first.run !== snap.run && !(slot.later ?? []).some((x) => x.run === snap.run))
    (slot.later ??= []).push(snap);
}
ledger.engines = { ...(ledger.engines ?? {}), ...run.settings?.engines };
writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);

const latest = (slot) => slot?.later?.at(-1) ?? slot?.first;
const causes = existsSync(resolve(root, 'bench/parity-causes.json'))
  ? JSON.parse(readFileSync(resolve(root, 'bench/parity-causes.json'), 'utf8'))
  : {};
/** A row's verdict from its scenes' verdicts: slower if any is slower, faster if one is and none is worse. */
const combine = (v) =>
  !v.length
    ? 'not run'
    : v.includes('slower')
      ? 'slower'
      : v.every((x) => x === 'faster' || x === 'equal')
        ? v.includes('faster')
          ? 'faster'
          : 'equal'
        : v.find((x) => x !== 'equal' && x !== 'faster');
const rows = matrixRows().map((row) => {
  const map = ROWS[row.id] ?? { none: 'not mapped' };
  if (!map.scenes) {
    const verdict = map.noEquivalent
      ? 'no three.js equivalent'
      : map.margoMissing
        ? 'Margo missing'
        : map.blocked
          ? 'blocked'
          : 'no workload';
    return { ...row, first: verdict, now: verdict, note: map.none, keys: [] };
  }
  const keys = map.scenes.map((sc) => (typeof sc === 'string' ? caseId(sc) : caseId(sc.scene, sc.params)));
  return {
    ...row,
    keys,
    first: combine(keys.map((k) => ledger.scenes[k]?.first?.verdict ?? 'not run')),
    now: combine(keys.map((k) => latest(ledger.scenes[k])?.verdict ?? 'not run')),
    owner: map.owner,
  };
});

const tally = (pick) => {
  const c = {};
  for (const r of rows) c[pick(r)] = (c[pick(r)] ?? 0) + 1;
  return c;
};
const firstCounts = tally((r) => r.first),
  nowCounts = tally((r) => r.now);
const worseOf = (snap) => {
  const m = snap.kind === 'task' ? ['taskMs'] : ['cpuMs', 'gpuMs'];
  return Math.max(
    ...m.map((k) => (snap.margo?.[k]?.median ?? 0) / Math.max(snap.three?.metrics?.[k]?.median ?? Infinity, 1e-9)),
  );
};
const worst = Object.entries(ledger.scenes)
  .map(([key, slot]) => ({ key, snap: latest(slot) }))
  .filter((x) => x.snap.verdict === 'slower')
  .map((x) => ({ ...x, worse: worseOf(x.snap) }))
  .sort((a, b) => b.worse - a.worse);
const cell = (snap, metrics, error) =>
  error
    ? error.slice(0, 70).replace(/\|/g, '/')
    : !metrics
      ? 'n/a'
      : snap.kind === 'task'
        ? `${f(metrics.taskMs?.median)} / ${f(metrics.coldMs?.median)}`
        : `${f(metrics.cpuMs?.median)} / ${f(metrics.gpuMs?.median)} / ${f(metrics.fps?.median, 0)} / ${f(metrics.firstFrameMs?.median, 0)}`;
const describe = (snap) =>
  `margo ${cell(snap, snap.margo, snap.margoError)}; ${snap.three ? `${snap.three.engine} ${cell(snap, snap.three.metrics)}` : 'three n/a'}`;
// bench/parity-causes.json: row id -> "cause" or {cause, knownBug (anchor in docs/known-bugs.md), fixes: [{commit,
// tradeoff, rerun}]}.
const causeText = (id) => {
  const c = causes[id];
  if (!c) return undefined;
  if (typeof c === 'string') return c;
  const fixes = (c.fixes ?? [])
    .map(
      (x) =>
        `fixed in ${x.commit}${x.tradeoff ? ` (trade-off: ${x.tradeoff})` : ''}${x.rerun ? `, rerun \`${x.rerun}\`` : ''}`,
    )
    .join('; ');
  return [c.cause, c.knownBug ? `[known bug](../known-bugs.md#${c.knownBug})` : '', fixes].filter(Boolean).join('. ');
};
const firstRun = Object.values(ledger.scenes)
  .map((x) => x.first)
  .sort((a, b) => a.date.localeCompare(b.date))[0];

const lines = [];
lines.push(
  '# Margo against three.js, row by row',
  '',
  '**Diagnostic, busy machine, not for publication.** These numbers come from a shared PC that also runs builds and',
  'other agents. Public claims wait for the quiet-machine run (HANDOFF item 36).',
  '',
  'This page keeps every first-run result, losses included, and never overwrites one (Scott, 2026-10-25). When a row',
  'is fixed later, its after numbers appear next to the before, with the cause, the trade-off, the fix commit and the',
  'rerun command. Rows still slower stay listed and link to their known-bugs entry. `bench/parity-report.mjs` renders',
  'this page from the ledger `perf-vs-threejs.json` next to it, which every run adds to.',
  '',
  `First run: \`${firstRun?.run ?? 'none'}\`. Latest run added: \`${run.id}\` (${run.valid ? 'valid' : `invalid: ${run.invalid.slice(0, 3).join('; ')}`}). Engines: ${Object.entries(
    ledger.engines,
  )
    .map(([e, v]) => `\`${e}\` ${v?.version ?? ''}`)
    .join(
      ', ',
    )}. Machine: ${run.env?.machine?.cpu ?? ''}, ${run.env?.gpu?.name ?? ''}; browser ${run.env?.browser?.browser?.version ?? ''}. ${run.options.runs} runs per case (${run.options.warmup} warm-up), ${run.options.frames} frames, interleaved per scene. This run's matrix took ${f(run.suites.parity.seconds / 60, 1)} min.`,
  '',
  'Rerun:',
  '',
  '```sh',
  'npm run build:packages',
  'npm run bench:parity',
  '```',
  '',
  'How a row is judged: each scene runs the same job in Margo and in both three.js backends in `engine-bench`',
  '(`three-webgpu-parity`, `three-webgl-parity`), and Margo is compared with the faster one. Frame scenes compare CPU and',
  'GPU ms per frame, task scenes the ms per call. A metric is better or worse when it differs by more than 5% and more than',
  'the spread of either engine. A scene is slower if any metric is worse, faster if one is better and none is worse, and',
  'equal otherwise. A row is slower if any of its scenes is. Image match: SSIM of the luminance >= 0.9 and mean delta E',
  '<= 6 between the Margo and three.js screenshots. Feature JS is the gzip bytes of the scripts that only that engine',
  'fetched for the scene.',
  '',
  '## Counts',
  '',
  '| Verdict | First run | Now |',
  '| --- | --- | --- |',
  ...[...new Set([...Object.keys(firstCounts), ...Object.keys(nowCounts)])].map(
    (k) => `| ${k} | ${firstCounts[k] ?? 0} | ${nowCounts[k] ?? 0} |`,
  ),
  `| total | ${rows.length} | ${rows.length} |`,
  '',
  '## Worst gaps now',
  '',
  '| Scene | Rows | Margo / three (worst primary metric) | Cause |',
  '| --- | --- | --- | --- |',
  ...worst.slice(0, 15).map((x) => {
    const ids = rows.filter((r) => r.keys.includes(x.key)).map((r) => r.id);
    return `| \`${x.key}\` | ${ids.join(', ')} | ${f(x.worse)}x | ${ids.map(causeText).find(Boolean) ?? 'not diagnosed yet'} |`;
  }),
  '',
  '## Every row',
  '',
  '| Row | Feature | First run | Now | Scenes | Cause, fix or note |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.feature.replace(/\|/g, '/').slice(0, 80)} | ${r.first} | ${r.now} | ${r.keys.map((k) => `\`${k}\``).join(' ')} | ${(causeText(r.id) ?? r.note ?? (r.owner ? `measured by ${r.owner}` : '')).replace(/\|/g, '/')} |`,
  ),
  '',
  '## Raw results',
  '',
  'Medians over runs. Frame scenes: CPU ms / GPU ms / FPS / first frame ms; task scenes: ms per call / cold ms. "Later"',
  'is the newest run after the first, when there is one.',
  '',
  '| Scene | First run (run id) | Verdict | Later run | Verdict | Image (SSIM, mean dE) | Feature JS gzip (Margo / three) |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...Object.entries(ledger.scenes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, slot]) => {
      const a = slot.first,
        b = slot.later?.at(-1),
        img = (b ?? a).image,
        bytes = (b ?? a).bytes;
      return `| \`${key}\` | ${describe(a)} (\`${a.run}\`) | ${a.verdict} | ${b ? `${describe(b)} (\`${b.run}\`)` : ''} | ${b?.verdict ?? ''} | ${img ? (img.error ?? `${img.ssim}, ${img.meanDeltaE}${img.match ? '' : ' (differs)'}`) : ''} | ${bytes ? `${bytes.margo.toLocaleString('en-US')} / ${bytes.three.toLocaleString('en-US')}` : ''} |`;
    }),
  '',
);
writeFileSync(resolve(root, o.out), lines.join('\n'));
console.log(`parity report: ${o.out} and ${ledgerFile.slice(root.length + 1)} from ${file}`);
console.log(
  Object.entries(nowCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', '),
);
