// Downloads standard test data and its legal notice, never renderer source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
mkdirSync(root, { recursive: true });
const commit = '8f492390ddc7a2ae221a1369ef560589cf8c70fb';
const base = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${commit}/Models/MetalRoughSpheresNoTextures/`;
for (const file of ['glTF-Binary/MetalRoughSpheresNoTextures.glb', 'README.md']) {
  const url = base + file;
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  assert.ok(response.ok, `${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (file.endsWith('.glb')) assert.equal(hash, '5e677f260ec0f366967a6e9545de2f3dab2a160e307b9bcb9d050cd2028f63f8');
  writeFileSync(join(root, file.split('/').at(-1)), bytes);
  console.log(url, hash);
}
