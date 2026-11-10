import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [variant, manifest, outputPrefix, artifact] = process.argv.slice(2);
assert.ok(
  ['draco', 'draco-full'].includes(variant) && manifest && outputPrefix && artifact,
  'usage: node scripts/acceptance/draco-resources.mjs <draco|draco-full> <manifest.json> <output-prefix> <frozen.wasm> [--resume]; MARGO_DRACO_ORACLE_ROOT points outside the repository',
);
const native = variant === 'draco' ? 'native-gltf' : 'native-full',
  inputs = JSON.parse(readFileSync(manifest)),
  out = outputPrefix + '.jsonl',
  summaryPath = outputPrefix + '-summary.json';
const resume = process.argv.includes('--resume');
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
      [resolve(import.meta.dirname, 'draco-resource-child.mjs'), side, path ?? '', resolve(artifact)],
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
  manifestSHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
  wasmSHA256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
};
const summary = resume
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
assert.deepEqual(summary.identities, identities, 'resume inputs must be unchanged');
if (resume) {
  const recorded = readFileSync(out, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  assert.equal(recorded.length, summary.completed, 'checkpoint must account for every recorded row');
  recorded.forEach((r, i) => assert.equal(r.sha256, inputs[i].sha256));
}
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
    const comparable = {
      ...candidate.output,
      attributes: candidate.output.attributes.map((a, i) => ({
        ...a,
        native: old.output.attributes[i].native === null ? null : a.native,
        float: old.output.attributes[i].float === null ? null : a.float,
      })),
    };
    assert.deepEqual(comparable, old.output, file.names[0]);
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
