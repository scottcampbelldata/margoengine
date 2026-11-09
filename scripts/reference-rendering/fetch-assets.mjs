// Downloads standard test data and its legal notice, never renderer source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { referenceCase, assetCommit } from './cases.mjs';
import { packGLTF } from './pack.mjs';
const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
mkdirSync(root, { recursive: true });
const family = process.argv.find((a) => a.startsWith('--case='))?.slice(7) ?? 'metallic-roughness';
const entry = referenceCase(family);
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
