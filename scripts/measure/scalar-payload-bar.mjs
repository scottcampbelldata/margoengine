// Scott 2026-11-09 scalar ruling. Original-source arithmetic/controls retained separately.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.ok(
  process.argv[2],
  'Usage: node scripts/measure/scalar-payload-bar.mjs <retained-evidence-directory> <scalar|eac|etc2> [output.json]',
);
const root = pathToFileURL(resolve(process.argv[2]) + '/');
const group = process.argv[3];
assert.ok(['scalar', 'eac', 'etc2'].includes(group));
const targets = group === 'scalar' ? [4, 5] : group === 'eac' ? [20, 21] : [1];
const { activeRecords } = await import(new URL('comparison-corpus.mjs', root));
const { DraftDecoder } = await import(new URL('../transcoder/ktx2.ts', root));
import { decodePNG } from '../../packages/decoders/dist/png.js';
const { pixels, areaReference, errorMetrics, channelsFor } = await import(new URL('quality-pixels.mjs', root));
import { scalarPayloadMetrics } from './scalar-payload-metrics.mjs';
const { frozenImageOrder } = await import(new URL('scalar-quality-order.mjs', root));
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  read = (n) => JSON.parse(readFileSync(new URL(n, root)));
const layers = read('quality/layer-source-images.json'),
  replacements = read('replacements/manifest.json').files;
const supplemental = read('independent-cc0/comparison.json'),
  suppQuality = read('independent-cc0/quality.json'),
  suppPins = read('independent-cc0/provenance.json').files;
const wasm = readFileSync(new URL('../transcoder/target/wasm32-unknown-unknown/release/margoengine_basis.wasm', root));
const d = new DraftDecoder((await WebAssembly.instantiate(wasm)).instance.exports),
  records = [],
  losses = [];
let exactHashes = 0,
  oldControls = 0,
  rgbaControls = 0;
const captures = new URL(`report22-${group}-payloads/`, root);
mkdirSync(captures, { recursive: true });
try {
  for (const [scope, inputs] of [
    ['primary', activeRecords()],
    ['supplementary', supplemental.records],
  ])
    for (const r of inputs
      .filter((r) => group === 'scalar' || (group === 'eac' ? r.metadata.uastc && !r.metadata.hdr : !r.metadata.uastc))
      .filter((r) => r.targets.some((t) => t.supported && targets.includes(t.id)))) {
      const supplement = scope === 'supplementary',
        replaced = r.file.startsWith('cc0-'),
        basis = r.file.endsWith('.basis');
      const input = readFileSync(
        new URL(`${supplement ? 'independent-cc0' : replaced ? 'replacements' : 'corpus'}/${r.file}`, root),
      );
      assert.equal(sha(input), supplement ? suppPins.find((x) => x.file === r.file).sha256 : r.sha256);
      const q = supplement
          ? suppQuality.records.find((x) => x.file === r.file)
          : replaced
            ? r
            : read('quality/results/' + r.file + '.json'),
        sourceCache = new Map(),
        mips = new Map();
      const decodedRgba = basis ? await d.decodeBasis(input, 13) : await d.decode(input, 13);
      const rgbaTarget = r.targets.find((t) => t.id === 13);
      assert.ok(rgbaTarget);
      assert.equal(decodedRgba.images.length, rgbaTarget.images.length);
      for (const im of decodedRgba.images) {
        const c = rgbaTarget.images.find(
          (x) => x.level === im.level && x.layer === (im.layer ?? im.image) && x.face === (im.face ?? 0),
        );
        assert.ok(c);
        assert.equal(sha(im.data), c.sha256);
        rgbaControls++;
      }
      for (const t of r.targets.filter((t) => t.supported && targets.includes(t.id))) {
        const prior = q.targets.find((x) => x.id === t.id),
          out = basis ? await d.decodeBasis(input, t.id) : await d.decode(input, t.id);
        const row = {
          scope,
          file: r.file,
          inputSha256: sha(input),
          target: t.id,
          images: [],
          oldSse: 0,
          newSse: 0,
          oldRedAlphaSse: 0,
          newRedAlphaSse: 0,
        };
        records.push(row);
        for (const im of out.images) {
          const layer = im.layer ?? im.image,
            face = im.face ?? 0,
            old = prior.images.find((x) => x.level === im.level && x.layer === layer && x.face === face);
          assert.ok(old);
          const sourceName = supplement ? q.sourceReference.file : replaced ? r.file + '.rgba8' : old.source;
          const sourcePin = supplement
            ? q.sourceReference.sha256
            : replaced
              ? replacements.find((x) => x.file === r.file).sourceSha256
              : old.sourceSha256;
          if (!sourceCache.has(sourceName)) {
            const path = supplement
              ? 'independent-cc0/' + sourceName
              : replaced
                ? 'replacements/' + sourceName
                : existsSync(new URL('corpus/' + sourceName, root))
                  ? 'corpus/' + sourceName
                  : 'quality/sources/' + sourceName;
            const bytes = readFileSync(new URL(path, root));
            assert.equal(sha(bytes), sourcePin);
            const binary = replaced
              ? { width: r.width, height: r.height }
              : supplement
                ? null
                : layers.find((x) => x.file === sourceName);
            sourceCache.set(
              sourceName,
              binary ? { width: binary.width, height: binary.height, data: bytes } : decodePNG(bytes),
            );
          }
          const key = sourceName + '/' + im.width + '/' + im.height;
          if (!mips.has(key)) mips.set(key, areaReference(sourceCache.get(sourceName), im.width, im.height));
          const reference = mips.get(key),
            control = t.images.find((x) => x.level === im.level && x.layer === layer && x.face === face);
          assert.ok(control);
          assert.equal(im.data.length, control.bytes);
          const outputSha256 = sha(im.data);
          const path = new URL(`${r.file}/`, captures);
          mkdirSync(path, { recursive: true });
          writeFileSync(new URL(`${t.id}-${im.level}-${layer}-${face}.bin`, path), im.data);
          if (outputSha256 === control.sha256) exactHashes++;
          const oldPath = supplement
            ? `independent-cc0/outputs/${r.file}/${t.id}-${im.level}.bin`
            : `${replaced ? 'replacements' : 'quality'}/outputs/${r.file}/${t.id}-${im.level}-${layer}-${face}.bin`;
          const oldPayload = readFileSync(new URL(oldPath, root));
          assert.equal(sha(oldPayload), control.sha256);
          const oldPixels = pixels(t.id, oldPayload, im.width, im.height),
            actual = pixels(t.id, im.data, im.width, im.height);
          const oldMetrics = errorMetrics(oldPixels, reference, channelsFor(t.id)),
            metrics = errorMetrics(actual, reference, channelsFor(t.id));
          for (const field of ['sse', 'sampleCount', 'perChannelSse'])
            assert.deepEqual(
              oldMetrics[field],
              old[field],
              `${scope}/${r.file}/${t.id}/${im.level}: unchanged old reader/source control`,
            );
          oldControls++;
          const contract =
            t.id === 5
              ? {
                  old: errorMetrics(oldPixels, reference, [0, 1], [0, 3]),
                  current: errorMetrics(actual, reference, [0, 1], [0, 3]),
                }
              : null;
          const recordedContract = old.sourceContractMetrics ?? old.redAlphaContract;
          if (contract && recordedContract)
            for (const field of ['sse', 'sampleCount', 'perChannelSse'])
              assert.deepEqual(contract.old[field], recordedContract[field]);
          const ideal = decodedRgba.images.find(
            (x) => x.level === im.level && (x.layer ?? x.image) === layer && (x.face ?? 0) === face,
          );
          assert.ok(ideal);
          const payload = {
            old: scalarPayloadMetrics(t.id, oldPixels, ideal.data),
            current: scalarPayloadMetrics(t.id, actual, ideal.data),
          };
          if (t.id === 1) {
            for (let at = 0; at < actual.length; at += 4)
              for (let c = 0; c < 3; c++) assert.equal(actual[at + c], oldPixels[at + c]);
          }
          row.images.push({
            level: im.level,
            layer,
            face,
            width: im.width,
            height: im.height,
            payload,
            rgbaSha256: sha(ideal.data),
            source: sourceName,
            sourceSha256: sourcePin,
            outputSha256,
            oldSse: oldMetrics.sse,
            ...metrics,
            ...(contract ? { redAlphaContract: contract } : {}),
          });
        }
        assert.equal(row.images.length, t.images.length);
        row.images = frozenImageOrder(row.images, prior.images);
        row.oldSse = row.images.reduce((n, im) => n + im.oldSse, 0);
        row.newSse = row.images.reduce((n, im) => n + im.sse, 0);
        if (t.id === 5) {
          row.oldRedAlphaSse = row.images.reduce((n, im) => n + im.redAlphaContract.old.sse, 0);
          row.newRedAlphaSse = row.images.reduce((n, im) => n + im.redAlphaContract.current.sse, 0);
        }
        assert.equal(row.oldSse, prior.sse);
        row.sourceNoWorse = row.newSse <= row.oldSse && (t.id !== 5 || row.newRedAlphaSse <= row.oldRedAlphaSse);
        const sum = (which) => row.images.reduce((n, im) => n + BigInt(im.payload[which].numeratorSse), 0n);
        row.payload = {
          oldNumeratorSse: String(sum('old')),
          newNumeratorSse: String(sum('current')),
          denominator: row.images[0].payload.old.denominator,
        };
        row.noWorse = sum('current') <= sum('old');
        if (!row.noWorse)
          losses.push({
            scope,
            file: r.file,
            target: t.id,
            oldSse: row.oldSse,
            newSse: row.newSse,
            oldRedAlphaSse: row.oldRedAlphaSse,
            newRedAlphaSse: row.newRedAlphaSse,
          });
      }
      console.log(JSON.stringify({ scope, file: r.file, losses: losses.length }));
    }
} finally {
  d.dispose();
}
const result = {
  status: losses.length ? 'fail' : 'pass',
  scope:
    'Scott 2026-11-09: spec-defined payload RGBA8 scalar SSE, new <= old per pair, zero tolerance. Original-source conventional/mapped numbers retained unchanged, losses included. Scalar quality only, not final package/API/fuzz/GPU/memory/speed acceptance.',
  group,
  targets,
  files: new Set(records.map((r) => r.file)).size,
  pairs: records.length,
  images: records.reduce((n, r) => n + r.images.length, 0),
  exactHashes,
  oldControls,
  rgbaControls,
  wasmSha256: sha(wasm),
  adapterSha256: sha(readFileSync(new URL('../transcoder/ktx2.ts', root))),
  losses,
  sourceLosses: records
    .filter((r) => !r.sourceNoWorse)
    .map((r) => ({
      scope: r.scope,
      file: r.file,
      target: r.target,
      oldSse: r.oldSse,
      newSse: r.newSse,
      oldRedAlphaSse: r.oldRedAlphaSse,
      newRedAlphaSse: r.newRedAlphaSse,
    })),
  records,
};
const expected = group === 'scalar' ? [98, 1296, 648] : group === 'eac' ? [52, 690, 345] : [23, 303, 303];
assert.deepEqual([result.pairs, result.images, rgbaControls], expected, 'Complete frozen corpus');
assert.equal(oldControls, result.images, 'Every old source control exact');
writeFileSync(
  process.argv[4] ?? new URL(`scalar-payload-report22-${group}.json`, root),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify({ ...result, records: records.length }));
if (losses.length) process.exitCode = 1;
