// Downloads standard test data and its legal notice, never renderer source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { referenceCase, assetCommit } from './cases.mjs';
import { packGLTF } from './pack.mjs';
import { downloadArguments } from '../support/download-arguments.mjs';
import { engineBenchRoot } from '../support/engine-bench.mjs';
const root = join(engineBenchRoot(), 'batch-160');
const args = downloadArguments(
  `Usage: node scripts/reference-rendering/fetch-assets.mjs [--case=<name>]
Downloads one reference case's Khronos sample model and its README into engine-bench/batch-160.
  --case=<name>   a case from cases.mjs (default metallic-roughness)
  --help          print this and download nothing`,
  { case: { type: 'string' } },
);
if (args) {
  const family = args.case ?? 'metallic-roughness';
  const entry = referenceCase(family);
  mkdirSync(root, { recursive: true });
  const folder = family === 'metallic-roughness' ? root : join(root, entry.model);
  mkdirSync(folder, { recursive: true });
  const base = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${assetCommit}/Models/${entry.model}/`;
  for (const file of [
    ...(entry.sourceFiles ? Object.keys(entry.sourceFiles) : [`glTF-Binary/${entry.model}.glb`]),
    'README.md',
  ]) {
    const url = base + file;
    const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
    assert.ok(response.ok, `${response.status}: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (file.endsWith('.glb')) assert.equal(hash, entry.sourceSha256);
    if (entry.sourceFiles?.[file]) assert.equal(hash, entry.sourceFiles[file]);
    const target = join(folder, entry.sourceFiles ? file : file.split('/').at(-1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    console.log(url, hash);
  }

  if (entry.sourceFiles) {
    const source = Object.keys(entry.sourceFiles).find((file) => file.endsWith('.gltf'));
    const doc = JSON.parse(readFileSync(join(folder, source)));
    const resource = (uri) => readFileSync(join(folder, dirname(source), uri));
    const packed = packGLTF(
      doc,
      doc.buffers.map((b) => resource(b.uri)),
      doc.images.map((image) => ({
        bytes: resource(image.uri),
        mimeType: image.mimeType ?? (image.uri.endsWith('.png') ? 'image/png' : 'image/jpeg'),
      })),
    );
    assert.equal(createHash('sha256').update(packed).digest('hex'), entry.sourceSha256);
    writeFileSync(join(folder, entry.model + '.glb'), packed);
  }
}
