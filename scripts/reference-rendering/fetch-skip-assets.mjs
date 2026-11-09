// Standard test data only. No renderer source. Every file stays outside the repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(
  process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench',
  'batch-160/gltf-gpu-samples',
);
const deadline = AbortSignal.timeout(15 * 60_000);
const rows = [];
async function download(url, path, expectedHash) {
  const response = await fetch(url, { signal: AbortSignal.any([deadline, AbortSignal.timeout(90_000)]) });
  assert.ok(response.ok, `${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash) assert.equal(sha256, expectedHash, url);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  rows.push({ url, path, sha256 });
}
const repository = 'https://api.github.com/repos/KhronosGroup/glTF-Test-Assets-Interactivity';
const response = await fetch(`${repository}/git/trees/f99d9b6?recursive=1`, { signal: deadline });
assert.ok(response.ok, `Conformance asset index: ${response.status}`);
const tree = await response.json();
assert.equal(tree.truncated, false);
const prefix = 'Tests/Interactivity/';
const paths = tree.tree.filter(
  (x) => x.type === 'blob' && x.path.startsWith(prefix) && /\.(glb|gltf|json)$/.test(x.path),
);
assert.ok(paths.length > 300, 'Incomplete asset index');
for (let i = 0; i < paths.length; i += 6)
  await Promise.all(
    paths
      .slice(i, i + 6)
      .map((entry) =>
        download(
          `https://raw.githubusercontent.com/KhronosGroup/glTF-Test-Assets-Interactivity/f99d9b6/${entry.path}`,
          join(root, 'interactivity', entry.path.slice(prefix.length)),
        ),
      ),
  );
for (const name of [
  'JointTypes',
  'ShapeTypes',
  'Filtering',
  'Triggers',
  'MotionProperties',
  'Materials_Friction',
  'Materials_Restitution',
])
  for (const extension of ['gltf', 'bin'])
    await download(
      `https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/9dc61cb3474ff9a51f58d3592f79d5c9e572056a/samples/${name}/${name}.${extension}`,
      join(root, 'physics', `${name}.${extension}`),
    );
for (const name of ['racoonfamily.spz', 'hornedlizard.spz'])
  await download(
    `https://raw.githubusercontent.com/nianticlabs/spz/11312e4ad836ed06e3da2f3d5b633688d17ebebb/samples/${name}`,
    join(root, name),
  );
await download(
  'https://raw.githubusercontent.com/CesiumGS/cesium/main/Specs/Data/Cesium3DTiles/GaussianSplats/tower/0/0.glb',
  join(root, 'tower.glb'),
  '9ef9d8d0756d1f423cd6aa8bd99f7dd26957f96df03dcbcec6e37103e39350b4',
);
writeFileSync(join(root, 'skip-audit-provenance.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(`Downloaded ${rows.length} external test assets. Set MARGO_SPLAT_SAMPLES=${root}`);
