// Real-GPU checks for LightProbes.addCapture (@margoengine/environment/probes): a reflection probe over flat terrain
// under a sky, with no environment and no core meshes, bakes black without the hook; with the terrain's passes and the
// sky's replayed into the capture, its downward texels show the green terrain and its upward ones the blue sky. Live
// capture then runs with the terrain's prepare pass replayed: after each frame, the terrain's own uniform holds the main
// camera again (the restore), not the probe's, and its upload count follows terrain's changed-bits rule exactly.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Terrain } from '@margoengine/terrain';
import { Sky } from '@margoengine/sky';
import { halfToFloat } from '../dist/index.js';
import { LightProbes } from '../dist/probes.js';
import { assert, hardware } from './gpu-read.js';

const SIZE = 16;
const octDecode = (u, v) => {
  const n = [u * 2 - 1, 1 - Math.abs(u * 2 - 1) - Math.abs(v * 2 - 1), v * 2 - 1];
  const t = Math.max(-n[1], 0);
  n[0] += n[0] >= 0 ? -t : t;
  n[2] += n[2] >= 0 ? -t : t;
  const length = Math.hypot(...n);
  return n.map((x) => x / length);
};
// Mean linear radiance of the probe's sharp level over texels looking down (y < -0.5) and up (y > 0.5).
function hemispheres(probes) {
  const data = probes.texels,
    base = probes.reflectionOffset(0),
    down = [0, 0, 0],
    up = [0, 0, 0];
  let nDown = 0,
    nUp = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const d = octDecode((x + 0.5) / SIZE, (y + 0.5) / SIZE),
        i = base + y * SIZE + x,
        rgb = [halfToFloat(data[i * 2] & 65535), halfToFloat(data[i * 2] >>> 16), halfToFloat(data[i * 2 + 1] & 65535)];
      if (d[1] < -0.5) {
        for (let c = 0; c < 3; c++) down[c] += rgb[c];
        nDown++;
      } else if (d[1] > 0.5) {
        for (let c = 0; c < 3; c++) up[c] += rgb[c];
        nUp++;
      }
    }
  return { down: down.map((v) => v / nDown), up: up.map((v) => v / nUp) };
}

window.runTests = async () => {
  const engine = await Engine.create(document.querySelector('#scene'), {
    backend: 'webgpu',
    camera: { position: [3, 4, 9], target: [0, 0, 0] },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [],
    checks = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const terrain = Terrain.attach(engine, {
    resolution: 16,
    levels: 3,
    origin: [-50, -50],
    size: [100, 100],
    heightScale: 1,
    layers: [0, 1, 2, 3].map(() => ({ height: [-100, 100], slope: [0, 1], scale: 1 })),
    textures(d) {
      const heightmap = d.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
      d.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
      const layers = d.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
      d.queue.writeTexture(
        { texture: layers },
        new Uint8Array([40, 200, 40, 255, 40, 200, 40, 255, 40, 200, 40, 255, 40, 200, 40, 255]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1, 4],
      );
      return { heightmap, layers };
    },
  });
  const sky = Sky.attach(engine);
  const probes = LightProbes.attach(engine, {
    reflections: [{ position: [0, 2, 0], min: [-10, -1, -10], max: [10, 10, 10] }],
    resolution: SIZE,
  });
  await probes.bake();
  const before = hemispheres(probes);
  checks.push({ name: 'without the hook', ...before });
  assert(Math.max(...before.down, ...before.up) < 1e-3, `nothing captured without the hook: ${JSON.stringify(before)}`);

  const removeTerrain = probes.addCapture(terrain, { passes: [terrain.name + ':prepare', terrain.name] });
  const removeSky = probes.addCapture(sky);
  await probes.bake();
  const after = hemispheres(probes);
  checks.push({ name: 'terrain and sky captured', ...after });
  assert(after.down[1] > 0.01, `terrain shows below the probe: ${after.down}`);
  assert(
    after.down[1] > 1.5 * after.down[0] && after.down[1] > 1.5 * after.down[2],
    `the terrain is green: ${after.down}`,
  );
  assert(after.up[2] > 0.01 && after.up[2] > after.up[0], `the sky shows above the probe, blue: ${after.up}`);

  // Live capture replays terrain:prepare with the probe camera; the frame's terrain draw must see the main camera.
  // The ring uniform has no COPY_SRC: watch the queue's uploads to it. The last one before the frame's submit is what
  // the frame's terrain draw reads. Terrain writes a ring uniform only when its bits differ from the last upload to that
  // buffer (26faf9535), so each frame's count follows that rule exactly: the frame prepare uploads the main camera
  // unless the buffer already holds those bits, then the six probe faces and the restore (the main camera again) always
  // upload. The first frame keeps the camera the bake left (prepare skipped); the second moves it (prepare uploads).
  const ring = terrain.rings[0].uniform,
    queue = device.queue,
    writeBuffer = queue.writeBuffer,
    bitsOf = (data) => new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2).slice(),
    sameBits = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    eyeOf = (bits) => [...new Float32Array(bits.buffer, 0, 19).slice(16, 19)];
  let held, uploads;
  queue.writeBuffer = function (buffer, offset, data, ...rest) {
    if (buffer === ring) (uploads ?? []).push((held = bitsOf(data)));
    return writeBuffer.call(this, buffer, offset, data, ...rest);
  };
  const liveFrame = async (label) => {
    assert(held, `${label}: the ring uniform was uploaded before the frame`);
    const before = held;
    uploads = [];
    engine.render();
    await queue.onSubmittedWorkDone();
    const seen = uploads,
      main = seen.at(-1),
      prepare = !!main && !sameBits(before, main),
      eyes = seen.map(eyeOf),
      eye = eyes.at(-1)?.map((v) => +v.toFixed(4));
    uploads = undefined;
    assert(
      seen.length === (prepare ? 8 : 7),
      `${label}: ${prepare ? 'frame prepare' : 'frame prepare skipped (the ring holds its bits)'}, six probe faces and the restore: ${seen.length} uploads`,
    );
    if (prepare)
      assert(sameBits(seen[0], main), `${label}: the frame prepare and the restore upload the same main camera`);
    assert(
      eyes.slice(prepare ? 1 : 0, -1).every((e) => Math.abs(e[1] - 2) < 1e-4),
      `${label}: the probe faces upload the probe position: ${JSON.stringify(eyes)}`,
    );
    checks.push({ name: label, prepare, uploads: eyes.length, eye });
    assert(
      eye.every((v, i) => Math.abs(v - engine.camera.position[i]) < 1e-4),
      `${label}: terrain uniform holds the main camera after the capture: ${eye}`,
    );
    return { prepare, first: eyes[0] };
  };
  try {
    // A bake ends with the restore, so the ring's last upload (what the frame prepare is compared with) is seen here.
    await probes.bake();
    assert(terrain.rings[0].uniform === ring, 'the bake keeps the ring buffer');
    probes.setLive({ facesPerFrame: 6 });
    await liveFrame('restore after live capture');
    engine.camera.position = [4, 5, 8];
    const moved = await liveFrame('restore after live capture, camera moved');
    assert(moved.prepare, 'a moved camera changes the ring bits, so the frame prepare must upload');
    assert(
      moved.first.every((v, i) => Math.abs(v - engine.camera.position[i]) < 1e-4),
      `the frame prepare uploads the moved main camera: ${moved.first}`,
    );
  } finally {
    queue.writeBuffer = writeBuffer;
  }
  probes.setLive(null);
  removeTerrain();
  removeSky();

  const validation = await device.popErrorScope();
  assert(!validation, validation?.message);
  assert(!errors.length, errors.join('; '));
  const report = { adapter: hardware({ info: device.adapterInfo }), checks };
  probes.dispose();
  engine.dispose();
  return report;
};
