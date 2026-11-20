// Cloud shadows made before a storm's code has loaded wait for it themselves (no order for the user to keep). This file
// runs alone in its process, so nothing has loaded the storm before it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { volumetricCloudShadows } from '@margoengine/sky/cloud-shadows';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('cloud shadows made before the storm loads wait for it themselves, then take it in', async () => {
  // Until 2026-11-17 a cloud shadow made before `await clouds.ready` threw a 'state' error on its first frame.
  const h = tracedGPU(),
    clouds = new VolumetricClouds({ hurricane: { pressureDrop: 50 } }),
    shade = volumetricCloudShadows(clouds),
    device = h.engine.gpu,
    writes = [];
  const write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data) => {
    writes.push(Float32Array.from(data));
    return write(buffer, offset, data);
  };
  shade.setup(device);
  const frame = () => shade.update({ context: { device, encoder: h.context.encoder }, light: [0, 1, 0] });
  assert.equal(shade.revision, 0, 'reading the revision starts the load; the code is not in yet');
  assert.doesNotMatch(shade.wgsl(2, 40), /StormDensity/);
  assert.doesNotThrow(frame);
  assert.equal(writes.at(-1)[41], 0, 'compiled without the storm, the shadows cast nothing');
  await clouds.ready;
  assert.equal(shade.revision, 1, 'the revision moves once the storm is in, so the shadows compose again');
  assert.match(shade.wgsl(2, 40), /fn shadowFxCloudStormDensity40\(/);
  frame();
  assert.equal(writes.at(-1)[41], 1, 'and then they shade');
  assert.notEqual(writes.at(-1)[77], 0, 'with the storm in the uniform');
  shade.dispose();
  h.cleanup();
});
