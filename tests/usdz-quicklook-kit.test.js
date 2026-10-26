import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parseUSDZ } from '@margoengine/usdz';
import { sphere, writeKit } from '../scripts/make-usdz-quicklook-kit.mjs';

const NAMES = [
  '01-alpha-mask',
  '02-alpha-blend',
  '03-metal-rough-normal-1',
  '04-metal-rough-normal-2',
  '05-occlusion-emissive',
  '06-texture-transform',
];

test('the sphere faces outward with uvs that run left to right and top to bottom', () => {
  const { positions, normals, uvs, indices } = sphere(16, 8);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => Array.from(positions.subarray(indices[t + k] * 3, indices[t + k] * 3 + 3)));
    const e1 = b.map((v, i) => v - a[i]),
      e2 = c.map((v, i) => v - a[i]),
      cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]],
      outward = a.map((v, i) => v + b[i] + c[i]);
    assert.ok(cross.reduce((s, v, i) => s + v * outward[i], 0) > 0, `triangle ${t / 3} faces outward`);
  }
  for (let v = 0; v < positions.length / 3; v++)
    assert.ok(Math.abs(Math.hypot(...positions.subarray(v * 3, v * 3 + 3)) - 0.5) < 1e-6);
  // u = 0.5 is the point facing +z, and u grows to the right there (+x).
  const front = 4 * 17 + 8,
    next = front + 1;
  assert.ok(positions[front * 3 + 2] > 0.49 && Math.abs(positions[front * 3]) < 1e-6);
  assert.ok(positions[next * 3] > 0);
  assert.equal(uvs[1], 0);
  assert.equal(normals.length, positions.length);
});

test('the Quick Look kit writes six aligned, readable USDZ archives (and GLB twins)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'margo-usdz-kit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeKit(dir, { glb: true });
  assert.deepEqual((await readdir(dir)).sort(), NAMES.flatMap((n) => [`${n}.glb`, `${n}.usdz`]).sort());
  assert.equal(written.length, 12);
  const sources = {};
  for (const name of NAMES) {
    const archive = new Uint8Array(await readFile(join(dir, `${name}.usdz`))),
      entries = readZipDirectory(archive),
      view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    assert.equal(entries[0].name, 'scene.usda', name);
    assert.ok(entries.length >= 2, `${name} stores its textures`);
    for (const entry of entries) {
      const at = entry.headerOffset;
      assert.equal(entry.method, 0, `${name}/${entry.name} is stored`);
      assert.equal(
        (at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)) % 64,
        0,
        `${name}/${entry.name} is 64-byte aligned`,
      );
      if (entry.name.endsWith('.png'))
        assert.deepEqual(Array.from((await readZipEntry(archive, entry)).subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    }
    sources[name] = new TextDecoder().decode(await readZipEntry(archive, entries[0]));
    const asset = await parseUSDZ(archive);
    assert.ok(asset.meshes.length >= 1, `${name} is read by @margoengine/usdz`);
    const glb = await readFile(join(dir, `${name}.glb`));
    assert.equal(glb.readUInt32LE(0), 0x46546c67);
  }
  assert.match(sources['01-alpha-mask'], /inputs:opacityThreshold = 0.5/);
  assert.match(sources['01-alpha-mask'], /inputs:opacity.connect = .*BaseColorTexture.outputs:a/);
  assert.doesNotMatch(sources['02-alpha-blend'], /opacityThreshold/);
  assert.match(sources['02-alpha-blend'], /inputs:opacity.connect = .*BaseColorTexture.outputs:a/);
  for (const [name, scale] of [
    ['03-metal-rough-normal-1', '(2, 2, 2, 1)'],
    ['04-metal-rough-normal-2', '(4, 4, 2, 1)'],
  ]) {
    assert.match(sources[name], /MetallicRoughnessTexture.outputs:g/);
    assert.ok(sources[name].includes(`float4 inputs:scale = ${scale}`), `${name} normal scale`);
  }
  assert.match(sources['05-occlusion-emissive'], /inputs:occlusion.connect = .*OcclusionTexture.outputs:r/);
  assert.match(sources['05-occlusion-emissive'], /inputs:emissiveColor.connect = .*EmissiveTexture.outputs:rgb/);
  assert.match(sources['06-texture-transform'], /UsdTransform2d/);
  assert.match(sources['06-texture-transform'], /token inputs:wrapS = "repeat"/);
  assert.match(sources['06-texture-transform'], /token inputs:wrapT = "mirror"/);
});
