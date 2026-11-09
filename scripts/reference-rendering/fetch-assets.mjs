// Downloads standard test data and its legal notice, never renderer source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { referenceCase, assetCommit } from './cases.mjs';
const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
mkdirSync(root, { recursive: true });
const family = process.argv.find((a) => a.startsWith('--case='))?.slice(7) ?? 'metallic-roughness';
const entry = referenceCase(family);
const folder = family === 'metallic-roughness' ? root : join(root, entry.model);
mkdirSync(folder, { recursive: true });
const base = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${assetCommit}/Models/${entry.model}/`;
for (const file of [`glTF-Binary/${entry.model}.glb`, 'README.md']) {
  const url = base + file;
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  assert.ok(response.ok, `${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (file.endsWith('.glb')) assert.equal(hash, entry.sourceSha256);
  writeFileSync(join(folder, file.split('/').at(-1)), bytes);
  console.log(url, hash);
}
