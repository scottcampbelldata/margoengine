// The shot tool's test scene (tools/shot/test/determinism-check.mjs): boxes placed by Math.random, spun by the
// frame delta, a sphere moved by performance.now(), and a value read back from the GPU each frame that colours the
// floor when the read lands, so the frames depend on the seed, the clock and asynchronous GPU work. `?leak=1` adds a
// source the shot clock does not control (crypto.getRandomValues), which the determinism check must catch.
// `?aov=1` gives the shot's masks: geometry and depth from SceneTargets (@margoengine/post/mrt); `?aov=leak` adds a
// noise mask filled by crypto.getRandomValues, so only a mask differs between renders. `?aov=look` adds the clean-frame
// look masks from SceneTargets' sun light values (KB-LOOK-SHADOWMASK1): Shadows (@margoengine/shadows) on every mesh,
// a gltf/pbr box (@margoengine/gltf/pbr) added as the subject, and `penumbra`, `subject`, `lit` (`litGround`) and
// `shadow` (`shadedGround`) beside geometry and depth. `?sky=1` puts a Sky
// (@margoengine/sky) behind the boxes, whose coverage record the tool reads as the `sky-coverage` mask.
import { createStage } from 'margoengine';
import { Sky } from '@margoengine/sky';
import { applyQualityTier, sceneSamples } from '@margoengine/quality';
import { engineRuntime } from '@margoengine/core/extension';
import { SceneTargets } from '@margoengine/post/mrt';

const leak = new URLSearchParams(location.search).get('leak') === '1',
  aov = new URLSearchParams(location.search).get('aov'),
  withSky = new URLSearchParams(location.search).get('sky') === '1';
// The tier from the shot's ?quality=, as a demo page chooses it (it sets or deletes globalThis.margoLow); the MSAA
// samples core then draws with are recorded, so the test sees a shot's forced count win over the tier.
applyQualityTier();
const samples = sceneSamples();
const stage = await createStage('#viewport', {
  backend: 'webgpu',
  controls: false,
  camera: { position: [0, 6, 14], target: [0, 1, 0], fov: 50 },
});
const engine = stage.engine,
  device = engineRuntime(engine).gpu;
const record = { random: [], clock: [], date: [], deltas: [], reads: 0, samples, canvas: [] };
record.random.push(Math.random(), Math.random(), Math.random());
const floor = stage.box({ size: [20, 0.2, 20], position: [0, -0.1, 0], color: '#303846', roughness: 0.9 });
const boxes = Array.from({ length: 24 }, () =>
  stage.box({
    size: [0.8, 0.8, 0.8],
    position: [(Math.random() - 0.5) * 12, 0.4 + Math.random() * 3, (Math.random() - 0.5) * 12],
    color: [0.2 + 0.8 * Math.random(), 0.2 + 0.8 * Math.random(), 0.2 + 0.8 * Math.random()],
    roughness: 0.5,
  }),
);
if (withSky) Sky.attach(engine, { hours: 15, timeScale: 0 });
const ball = stage.sphere({ radius: 0.7, position: [0, 1.5, 0], color: '#e0b050', roughness: 0.3 });

// A frame counter goes through the GPU and back (writeBuffer, copy, mapAsync); the floor shows the last value read.
const COPY_SRC = 4,
  COPY_DST = 8,
  MAP_READ = 1;
const source = device.createBuffer({ size: 4, usage: COPY_SRC | COPY_DST }),
  readback = device.createBuffer({ size: 4, usage: MAP_READ | COPY_DST });
let frames = 0,
  reading = false,
  seen = 0,
  spin = 0;
stage.onTick((delta) => {
  frames++;
  spin += delta;
  record.deltas.push(delta);
  record.clock.push(performance.now());
  record.date.push(Date.now());
  record.canvas.push([engine.canvas.width, engine.canvas.height]);
  boxes.forEach((box, i) => box.setRotation([spin * (0.5 + (i % 5) * 0.3), spin * 0.7, 0]));
  const t = performance.now() / 1000,
    wobble = leak ? crypto.getRandomValues(new Uint8Array(1))[0] / 255 : 0;
  ball.setPosition([Math.sin(t * 2) * 4 + wobble, 1.5, Math.cos(t * 2) * 4]);
  floor.material.set({ color: [0.1 + 0.6 * ((seen % 16) / 15), 0.2, 0.3] });
  if (!reading) {
    reading = true;
    device.queue.writeBuffer(source, 0, new Uint32Array([frames]));
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]);
    readback.mapAsync(MAP_READ).then(() => {
      seen = new Uint32Array(readback.getMappedRange().slice(0))[0];
      readback.unmap();
      record.reads++;
      reading = false;
    });
  }
});
// The masks: 1 where a surface is drawn, and nearness exp(-distance / 20) (1 at the eye, 0 where nothing is drawn).
const look = aov === 'look',
  lookMasks = { penumbra: 'penumbra', subject: 'subject', lit: 'litGround', shadow: 'shadedGround' };
const targets = aov
  ? SceneTargets.attach(engine, {
      outputs: {
        geometry: { wgsl: 'vec4f(1, 0, 0, 1)', format: 'r8unorm' },
        depth: { wgsl: 'vec4f(exp(-distance(t.eye, t.position) / 20.0), 0, 0, 1)', format: 'r8unorm' },
        ...(look ? lookMasks : {}),
      },
    })
  : null;
if (look) {
  const [{ Shadows }, { loadGLTF }] = await Promise.all([
    import('@margoengine/shadows'),
    import('@margoengine/gltf/pbr'),
  ]);
  const subject = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb');
  subject.root.setPosition([2, 0.75, 3]);
  subject.root.setScale([1.5, 1.5, 1.5]);
  const shadows = Shadows.attach(engine, { resolution: 2048, bounds: { min: [-10, -1, -10], max: [10, 6, 10] } });
  for (const mesh of [floor, ...boxes, ball, subject]) shadows.add(mesh);
  targets.add(subject, { subject: true });
}
let noise;
const aovs = () => {
  const textures = { geometry: targets.texture('geometry'), depth: targets.texture('depth') };
  if (look) for (const name of Object.keys(lookMasks)) textures[name] = targets.texture(name);
  if (aov === 'leak') {
    const { width, height } = textures.geometry;
    noise ??= device.createTexture({ size: [width, height], format: 'r8unorm', usage: 4 | 2 });
    const bytes = new Uint8Array(width * height);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    device.queue.writeTexture({ texture: noise }, bytes, { bytesPerRow: width }, [width, height]);
    textures.noise = noise;
  }
  return { device, textures };
};
globalThis.shotScene = { engine, record, aovs };
