// Standard Khronos fixture data only. The browser reproducer imports no Margo packages.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceSha256 = '863cf24d0e48892ec830a7c712e4eb8bf5c0fd6cc2ae2f34d213b216f0bd6c12';
export const sourceURL =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/IORTestGrid/glTF-Binary/IORTestGrid.glb';

export function blendRepeatRoot(env = process.env) {
  return resolve(
    env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../../engine-bench/', import.meta.url)),
    'batch-160',
  );
}

export async function blendRepeatScene(root) {
  const folder = join(root, 'IORTestGrid'),
    path = join(folder, 'IORTestGrid.glb');
  if (!existsSync(path)) {
    const response = await fetch(sourceURL, { signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, `Fixture download: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceSha256, 'Downloaded fixture changed');
    mkdirSync(folder, { recursive: true });
    const candidate = join(folder, `blend-repeat-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(candidate, bytes, { flag: 'wx' });
    try {
      // Publish complete bytes atomically. A concurrent downloader's complete fixture is verified below too.
      try {
        linkSync(candidate, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      unlinkSync(candidate);
    }
  }
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceSha256, 'Outside fixture changed');
  const jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + jsonLength)),
    binary = bytes.subarray(28 + jsonLength),
    node = doc.nodes[12],
    primitive = doc.meshes[node.mesh].primitives[0];
  assert.equal(node.name, 'IOR1.5_White_R0_M0_T1_S1');
  const positions = doc.accessors[primitive.attributes.POSITION],
    indices = doc.accessors[primitive.indices];
  assert.equal(positions.componentType, 5126);
  assert.equal(positions.type, 'VEC3');
  assert.equal(indices.componentType, 5125);
  assert.equal(indices.type, 'SCALAR');
  assert.equal(indices.count, 3840);
  const positionView = doc.bufferViews[positions.bufferView],
    indexView = doc.bufferViews[indices.bufferView],
    vertices = new Float32Array(indices.count * 20);
  // Preserve all 1,280 triangles. Duplicate vertices only to give each triangle a finite flat tint.
  for (let i = 0; i < indices.count; i++) {
    const index = binary.readUInt32LE((indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0) + i * 4),
      offset = (positionView.byteOffset ?? 0) + (positions.byteOffset ?? 0) + index * (positionView.byteStride ?? 12);
    assert.ok(index < positions.count);
    for (let k = 0; k < 3; k++) vertices[i * 20 + k] = binary.readFloatLE(offset + k * 4);
    vertices[i * 20 + 4] = 0.83 + (Math.floor(i / 3) % 37) / 1000;
  }
  // Fixed batch-160 camera and the fixture node's transform. No time/frame inputs.
  const camera = [
    3.1715948581695557, 0, 0, 0, 0, 3.1715948581695557, 0, 0, 0, 0, 0.00010001000191550702, -1, 0.2156684398651123,
    -0.14589336514472961, 0.009850985370576382, 1.5,
  ];
  const model = [
    1, 0, 0, 0, 0, 2.220446049250313e-16, -1, 0, 0, 1, 2.220446049250313e-16, 0, 0.16496936976909637,
    2.9802322387695312e-8, 0.017525793984532356, 1,
  ];
  const uniform = new Float32Array([...camera, ...model, ...model, -0.068, 0.046, 1.5, 1]);
  return {
    vertices: Array.from(vertices),
    indices: Array.from({ length: indices.count }, (_, i) => i),
    uniform: Array.from(uniform),
    inputSha256: createHash('sha256').update(vertices).update(uniform).digest('hex'),
  };
}
