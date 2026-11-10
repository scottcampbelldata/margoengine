import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('shadow-cull fixture reads the real command buffer of either rendering route', async () => {
  const html = readFileSync(new URL('./shadow-cull.html', import.meta.url), 'utf8').replaceAll('\r', '');
  const method = html.match(/async counts\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*\/\//);
  assert.ok(method, 'the canonical counts fixture must exist');
  for (const compat of [false, true]) {
    const camera = { size: 60 },
      commands = { size: 240 };
    const cameraData = new Uint32Array(15),
      cascadeData = new Uint32Array(60);
    cameraData.set([7], 1);
    cameraData.set([11], 6);
    cameraData.set([13], 11);
    for (let i = 0; i < 12; i++) cascadeData[i * 5 + 1] = i + 1;
    const reads = [];
    const read = async (buffer, size) => {
      reads.push([buffer, size]);
      assert.ok(buffer === camera || buffer === commands, 'read the real owning buffer');
      return buffer === camera ? cameraData : cascadeData;
    };
    const scatter = { commands: camera, values: new Float32Array(36) };
    scatter.values[35] = 2;
    if (compat) scatter.route = { shadow: { commands } };
    else scatter.cascadeCull = { commands };
    const counts = new Function('scatters', 'read', `return async function() {${method[1]}}`)([scatter], read);
    assert.deepEqual(await counts(), [
      {
        camera: [7, 11, 13],
        cascades: [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
          [10, 11, 12],
        ],
        radius: 2,
      },
    ]);
    assert.deepEqual(reads, [
      [camera, 60],
      [commands, 240],
    ]);
  }
});
