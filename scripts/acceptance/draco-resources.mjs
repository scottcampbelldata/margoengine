// Batch 133 fresh-process resource campaign: the prebuilt and the clean-room Draco decoder each decode every
// manifest input in a fresh process; lifetime peak RSS and linear memory are compared, output must match exactly.
//
// Usage: node scripts/acceptance/draco-resources.mjs <draco|draco-full> <manifest.json> <output-prefix> <frozen.wasm>
//   [--resume] [--outputs=api|float] [--paired=<rounds>]
//
// --outputs=api (default) asks each side for what Margo's public API returns; --outputs=float also converts
// point-cloud attributes to float32 on both sides, a like-for-like row with both conversion costs (see
// draco-resource-child.mjs).
//
// One-shot (default): one fresh process per side and input, prebuilt first; no repeats, minima or clocks. A repeat
// to obtain a pass is refused (the output file must not exist).
//
// Allowed paired check (--paired=<rounds>, bug sweep L5b 2026-11-11, KB4824a): re-measures only inputs that a
// recorded one-shot campaign lost by less than the spread of that run's own startup stage, where one sample per side
// cannot separate a loss from process-to-process noise. The round count (odd, 5 to 15) is fixed before the run. Each
// round starts both sides in fresh processes, taking turns (even rounds prebuilt first, odd rounds native first), and
// checks output equality every round; each side's figure is its per-round minimum peak RSS, and a native minimum above
// the prebuilt's is a loss. A paired run cannot resume and is never repeated to obtain a pass. It narrows nothing:
// every round's row is kept, and the one-shot record it follows stays as recorded.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [variant, manifest, outputPrefix, artifact] = process.argv.slice(2);
assert.ok(
  ['draco', 'draco-full'].includes(variant) && manifest && outputPrefix && artifact,
  'usage: node scripts/acceptance/draco-resources.mjs <draco|draco-full> <manifest.json> <output-prefix> <frozen.wasm> [--resume] [--outputs=api|float] [--paired=<rounds>]; MARGO_DRACO_ORACLE_ROOT points outside the repository',
);
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outputs = option('outputs', 'api'),
  paired = option('paired') === undefined ? 0 : Number(option('paired'));
assert.ok(['api', 'float'].includes(outputs), '--outputs must be api or float');
assert.ok(
  paired === 0 || (Number.isInteger(paired) && paired >= 5 && paired <= 15 && paired % 2 === 1),
  '--paired takes an odd round count from 5 to 15',
);
const native = variant === 'draco' ? 'native-gltf' : 'native-full',
  inputs = JSON.parse(readFileSync(manifest)),
  out = outputPrefix + '.jsonl',
  summaryPath = outputPrefix + '-summary.json';
const resume = process.argv.includes('--resume');
assert.ok(!(resume && paired), 'a paired check cannot resume; it is one complete run');
if (!resume) {
  assert.ok(!existsSync(out), 'Do not repeat measurements to obtain a pass');
  writeFileSync(out, '');
}
let activeChild;
const deadline = setTimeout(() => {
  if (activeChild?.pid)
    spawnSync('taskkill', ['/PID', String(activeChild.pid), '/T', '/F'], {
      timeout: 15000,
      windowsHide: true,
      stdio: 'ignore',
    });
  console.error('resource campaign hard limit: 40 minutes');
  process.exit(1);
}, 2400000);
deadline.unref();
async function child(side, path) {
  const p = (activeChild = spawn(
      process.execPath,
      [resolve(import.meta.dirname, 'draco-resource-child.mjs'), side, path ?? '', resolve(artifact), outputs],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )),
    chunks = [],
    errors = [];
  p.stdout.on('data', (b) => chunks.push(b));
  p.stderr.on('data', (b) => errors.push(b));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { timeout: 15000, windowsHide: true, stdio: 'ignore' });
  }, 30000);
  try {
    const code = await new Promise((resolve, reject) => {
      p.once('error', reject);
      p.once('close', resolve);
    });
    assert.ok(!timedOut, 'child hard timeout');
    assert.equal(code, 0, Buffer.concat(errors).toString());
    return JSON.parse(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    activeChild = undefined;
  }
}
const identities = {
  outputs,
  manifestSHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
  wasmSHA256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
};
// A paired check keeps its own record (pairedCheck); the one-shot summary and its startup stage are not taken.
const summary = paired
  ? { variant, identities }
  : resume
    ? JSON.parse(readFileSync(summaryPath))
    : {
        variant,
        identities,
        scope:
          'One fresh process per side and input, prebuilt first. No clocks, timing metrics, GC, repeats or minima. Process lifetime peakRSS is the target; all larger native values are losses, including startup. Output is retained until RSS capture. Work counts instrument public calls/copies only, not allocator internals. No OS file-cache cold claim.',
        environment: { node: process.version, platform: process.platform, host: hostname() },
        inputs: inputs.length,
        completed: 0,
        accepted: 0,
        exact: 0,
        rssLosses: 0,
        linearLosses: 0,
        maxOldRSS: 0,
        maxNativeRSS: 0,
        maxOldLinear: 0,
        maxNativeLinear: 0,
        startup: { old: await child(variant), native: await child(native) },
      };
assert.equal(summary.variant, variant, 'resume variant must be unchanged');
// Checkpoints recorded before --outputs existed converted point clouds to float on both sides.
assert.deepEqual({ outputs: 'float', ...summary.identities }, identities, 'resume inputs must be unchanged');
if (resume) {
  const recorded = readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  assert.equal(recorded.length, summary.completed, 'checkpoint must account for every recorded row');
  recorded.forEach((r, i) => assert.equal(r.sha256, inputs[i].sha256));
}
if (paired) await pairedCheck();
else await oneShot();
async function pairedCheck() {
  const record = {
    variant,
    identities,
    scope: `Allowed paired check: ${paired} rounds per input, both sides in fresh processes taking turns (even rounds prebuilt first, odd rounds native first), output equal every round; per-side minimum lifetime peakRSS decides. No clocks, timing metrics or GC.`,
    environment: { node: process.version, platform: process.platform, host: hostname() },
    rounds: paired,
    inputs: inputs.length,
    completed: 0,
    rssLosses: 0,
    linearLosses: 0,
    results: [],
  };
  for (const file of inputs) {
    assert.equal(
      createHash('sha256').update(readFileSync(file.path)).digest('hex'),
      file.sha256,
      'corpus bytes must match their identity',
    );
    const rows = [];
    for (let round = 0; round < paired; round++) {
      const order = round % 2 ? [native, variant] : [variant, native],
        got = {};
      for (const side of order) got[side] = await child(side, file.path);
      assert.ok(got[variant].ok && got[native].ok, file.names[0]);
      assert.deepEqual(comparable(got[native].output, got[variant].output), got[variant].output, file.names[0]);
      rows.push({ round, first: order[0] === variant ? 'old' : 'native', old: got[variant], native: got[native] });
      appendFileSync(out, JSON.stringify({ sha256: file.sha256, ...rows.at(-1) }) + '\n');
    }
    const min = (side, key) => Math.min(...rows.map((r) => r[side].final[key]));
    const result = {
      sha256: file.sha256,
      names: file.names,
      oldPeakRSSMin: min('old', 'peakRSSBytes'),
      nativePeakRSSMin: min('native', 'peakRSSBytes'),
      oldLinearMin: min('old', 'linearBytes'),
      nativeLinearMin: min('native', 'linearBytes'),
    };
    if (result.nativePeakRSSMin > result.oldPeakRSSMin) record.rssLosses++;
    if (result.nativeLinearMin > result.oldLinearMin) record.linearLosses++;
    record.results.push(result);
    record.completed++;
    writeFileSync(summaryPath, JSON.stringify(record, null, 2));
  }
  console.log(JSON.stringify(record));
  process.exitCode = record.rssLosses > 0 || record.linearLosses > 0 ? 1 : 0;
}
// The native output with each side's float or native arrays left out where the prebuilt left them out.
function comparable(candidate, old) {
  return {
    ...candidate,
    attributes: candidate.attributes.map((a, i) => ({
      ...a,
      native: old.attributes[i].native === null ? null : a.native,
      float: old.attributes[i].float === null ? null : a.float,
    })),
  };
}
async function oneShot() {
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  for (const file of inputs.slice(summary.completed)) {
    assert.equal(
      createHash('sha256').update(readFileSync(file.path)).digest('hex'),
      file.sha256,
      'corpus bytes must match their identity',
    );
    const pendingPath = outputPrefix + '-pending.json',
      pending = resume && existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath)) : undefined,
      old = pending?.sha256 === file.sha256 ? pending.old : await child(variant, file.path);
    writeFileSync(outputPrefix + '-pending.json', JSON.stringify({ sha256: file.sha256, old }));
    let candidate;
    if (old.ok) {
      candidate = await child(native, file.path);
      assert.ok(candidate.ok, file.names[0]);
      assert.deepEqual(comparable(candidate.output, old.output), old.output, file.names[0]);
      summary.accepted++;
      summary.exact++;
      if (candidate.final.peakRSSBytes > old.final.peakRSSBytes) summary.rssLosses++;
      if (candidate.final.linearBytes > old.final.linearBytes) summary.linearLosses++;
      summary.maxOldRSS = Math.max(summary.maxOldRSS, old.final.peakRSSBytes);
      summary.maxNativeRSS = Math.max(summary.maxNativeRSS, candidate.final.peakRSSBytes);
      summary.maxOldLinear = Math.max(summary.maxOldLinear, old.final.linearBytes);
      summary.maxNativeLinear = Math.max(summary.maxNativeLinear, candidate.final.linearBytes);
    }
    appendFileSync(
      out,
      JSON.stringify({ sha256: file.sha256, names: file.names, source: file.source, old, native: candidate }) + '\n',
    );
    summary.completed++;
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    if (summary.completed % 250 === 0)
      console.log(
        JSON.stringify({
          variant,
          completed: summary.completed,
          accepted: summary.accepted,
          rssLosses: summary.rssLosses,
        }),
      );
  }
  console.log(JSON.stringify(summary));
  process.exitCode =
    summary.rssLosses > 0 ||
    summary.linearLosses > 0 ||
    (summary.startup && summary.startup.native.final.peakRSSBytes > summary.startup.old.final.peakRSSBytes)
      ? 1
      : 0;
}
