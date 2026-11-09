// Frozen-evidence diagnostic only. No transcoder, fitting, bar change or GPU use.
// Run from the repository root. Private licensed inputs remain in their evidence folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePNG } from '../../packages/decoders/dist/png.js';

assert.ok(
  process.argv[2],
  'Usage: node scripts/measure/scalar-ideal-bound.mjs <retained-evidence-directory> [output.json]',
);
const root = pathToFileURL(`${resolve(process.argv[2])}/`);
const output = resolve(process.argv[3] ?? 'docs/whitepaper/results/batch-134-scalar-ideal-bound.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pins = new Map();
function bytes(name) {
  const b = readFileSync(new URL(name, root));
  pins.set(name, sha(b));
  return b;
}
const json = (name) => JSON.parse(bytes(name));
const { pixels, areaReference, errorMetrics, channelsFor } = await import(new URL('quality-pixels.mjs', root));
const { activeRecords } = await import(new URL('comparison-corpus.mjs', root));
for (const name of [
  'quality-pixels.mjs',
  'quality-etc.mjs',
  'quality-astc.mjs',
  'quality-hdr.mjs',
  'comparison-corpus.mjs',
])
  bytes(name);
const frozen = json('scalar-quality-report17.json');
const published = JSON.parse(
  readFileSync(new URL('../../docs/whitepaper/results/batch-134-scalar-rational.json', import.meta.url)),
).quality;
// The published wrapper adds descriptive metadata. Every original control field must be identical.
for (const field of Object.keys(frozen)) {
  assert.deepEqual(frozen[field], published[field], `Frozen report17 field: ${field}`);
}
const layers = json('quality/layer-source-images.json');
const primary = activeRecords();
const supplementary = json('independent-cc0/comparison.json').records;
const records = [];
let oldControls = 0;
const classes = { untouched: 0, oldRgbaReference: 0, resampled: 0 };
const key = (im) => `${im.level}/${im.layer ?? im.image}/${im.face ?? 0}`;
function residualCorrelation(actual, ideal, reference, destination, observed, source) {
  let sx = 0,
    sy = 0,
    xx = 0,
    yy = 0,
    xy = 0;
  const count = actual.length / 4;
  for (let p = 0; p < actual.length; p += 4) {
    const x = actual[p + destination] - ideal[p + observed];
    const y = ideal[p + observed] - reference[p + source];
    sx += x;
    sy += y;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const denominator = Math.sqrt((xx - (sx * sx) / count) * (yy - (sy * sy) / count));
  return denominator ? (xy - (sx * sy) / count) / denominator : null;
}
const metricsEqual = (a, b) => {
  for (const k of ['sse', 'perChannelSse', 'sampleCount']) assert.deepEqual(a[k], b[k], k);
};
for (const prior of frozen.records) {
  const supplement = prior.scope === 'supplementary';
  const replacement = prior.file.startsWith('cc0-');
  const record = (supplement ? supplementary : primary).find((r) => r.file === prior.file);
  assert.ok(record, prior.file);
  const target = record.targets.find((t) => t.id === prior.target);
  const rgba = record.targets.find((t) => t.id === 13);
  assert.ok(target && rgba);
  const dir = supplement ? 'independent-cc0' : replacement ? 'replacements' : 'quality';
  const sourceCache = new Map();
  const mipCache = new Map();
  const row = { scope: prior.scope, file: prior.file, target: prior.target, images: [] };
  for (const im of prior.images) {
    const control = target.images.find((x) => key(x) === key(im));
    const rgbaControl = rgba.images.find((x) => key(x) === key(im));
    assert.ok(control && rgbaControl);
    const suffix = supplement ? `${im.level}` : `${im.level}-${im.layer}-${im.face}`;
    const oldBytes = bytes(`${dir}/outputs/${prior.file}/${prior.target}-${suffix}.bin`);
    const ideal = bytes(`${dir}/outputs/${prior.file}/13-${suffix}.bin`);
    assert.equal(sha(oldBytes), control.sha256);
    assert.equal(sha(ideal), rgbaControl.sha256);
    assert.equal(ideal.length, im.width * im.height * 4);
    assert.equal(oldBytes.length, control.bytes);
    if (!sourceCache.has(im.source)) {
      const sourcePath = supplement
        ? `independent-cc0/${im.source}`
        : replacement
          ? `replacements/${im.source}`
          : existsSync(new URL(`corpus/${im.source}`, root))
            ? `corpus/${im.source}`
            : `quality/sources/${im.source}`;
      const sourceBytes = bytes(sourcePath);
      assert.equal(sha(sourceBytes), im.sourceSha256);
      const binary = replacement
        ? { width: record.width, height: record.height }
        : layers.find((x) => x.file === im.source);
      sourceCache.set(im.source, binary ? { ...binary, data: sourceBytes } : decodePNG(sourceBytes));
    }
    const source = sourceCache.get(im.source);
    const mipKey = `${im.source}/${im.width}/${im.height}`;
    if (!mipCache.has(mipKey)) mipCache.set(mipKey, areaReference(source, im.width, im.height));
    const reference = mipCache.get(mipKey);
    const kind = layers.some((x) => x.file === im.source)
      ? 'oldRgbaReference'
      : source.width === im.width && source.height === im.height
        ? 'untouched'
        : 'resampled';
    classes[kind]++;
    const oldPixels = pixels(prior.target, oldBytes, im.width, im.height);
    const observed = prior.target === 5 ? [0, 3] : [0];
    const mappedIdeal = new Uint8Array(ideal); // BC5 stores decoded R and alpha, as the frozen control does.
    if (prior.target === 5) for (let p = 0; p < ideal.length; p += 4) mappedIdeal[p + 1] = ideal[p + 3];
    const old = errorMetrics(oldPixels, reference, channelsFor(prior.target));
    assert.equal(old.sse, im.oldSse);
    const idealMetrics = errorMetrics(mappedIdeal, reference, channelsFor(prior.target));
    const detail = {
      level: im.level,
      layer: im.layer,
      face: im.face,
      width: im.width,
      height: im.height,
      source: im.source,
      sourceSha256: im.sourceSha256,
      kind,
      oldSse: old.sse,
      idealSse: idealMetrics.sse,
    };
    if (prior.target === 5) {
      const oldMapped = errorMetrics(oldPixels, reference, [0, 1], observed);
      metricsEqual(oldMapped, im.redAlphaContract.old);
      detail.oldRedAlphaSse = oldMapped.sse;
      detail.idealRedAlphaSse = errorMetrics(mappedIdeal, reference, [0, 1], observed).sse;
      detail.alphaResidualCorrelation = residualCorrelation(oldPixels, ideal, reference, 1, 3, 3);
    }
    oldControls++;
    row.images.push(detail);
  }
  const aggregate = (images) => {
    const sum = (field) => images.reduce((n, im) => n + (im[field] ?? 0), 0);
    const oldSse = sum('oldSse'),
      idealSse = sum('idealSse');
    const oldRedAlphaSse = sum('oldRedAlphaSse'),
      idealRedAlphaSse = sum('idealRedAlphaSse');
    return {
      images: images.length,
      oldSse,
      idealSse,
      conventionalIncreasePercent: (100 * (idealSse - oldSse)) / oldSse,
      ...(prior.target === 5
        ? {
            oldRedAlphaSse,
            idealRedAlphaSse,
            mappedIncreasePercent: (100 * (idealRedAlphaSse - oldRedAlphaSse)) / oldRedAlphaSse,
          }
        : {}),
      noWorse: idealSse <= oldSse && (prior.target !== 5 || idealRedAlphaSse <= oldRedAlphaSse),
    };
  };
  row.all = aggregate(row.images);
  row.untouched = aggregate(row.images.filter((im) => im.kind === 'untouched'));
  assert.equal(row.all.oldSse, prior.oldSse);
  if (prior.target === 5) assert.equal(row.all.oldRedAlphaSse, prior.oldRedAlphaSse);
  records.push(row);
}
const allLosses = records.filter((r) => !r.all.noWorse);
const untouched = records.filter((r) => r.untouched.images);
const untouchedLosses = untouched.filter((r) => !r.untouched.noWorse);
assert.equal(oldControls, 1296);
assert.deepEqual(classes, { untouched: 130, oldRgbaReference: 234, resampled: 932 });
assert.equal(records.length, 98);
assert.equal(allLosses.length, 17);
assert.equal(untouched.length, 82);
assert.equal(untouchedLosses.length, 3);
const result = {
  status: 'reproduced-ideal-fidelity-diagnostic',
  scope:
    'Frozen prebuilt RGBA8 with zero added reconstruction error, channel-mapped as BC4/BC5. This is not an encoded BC payload or a lower bound on original-source error for all possible encoders. No acceptance bar changed; scalar ruling pending.',
  files: new Set(records.map((r) => r.file)).size,
  pairs: records.length,
  images: oldControls,
  oldControls,
  classes,
  allFailingPairs: allLosses.length,
  untouchedPairs: untouched.length,
  untouchedFailingPairs: untouchedLosses.length,
  allLosses: allLosses.map(({ file, target, all }) => ({ file, target, ...all })),
  untouchedLosses: untouchedLosses.map(({ file, target, untouched: a }) => ({ file, target, ...a })),
  pins: [...pins].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 })),
  records,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.table(result.allLosses);
console.log(
  JSON.stringify({
    pairs: result.pairs,
    failing: result.allFailingPairs,
    untouchedPairs: result.untouchedPairs,
    untouchedFailing: result.untouchedFailingPairs,
    images: result.images,
    classes,
    output,
  }),
);
