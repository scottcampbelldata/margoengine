// Real-GPU regression for KB-SCATTER-VELTILES1, run from the repository root after building packages:
//   node packages/scatter/test/velocity-tiles.browser.mjs            (WebGPU)
//   node packages/scatter/test/velocity-tiles.browser.mjs --compat   (the WebGL2 layer)
// ScatterTiles destroys and remakes its LOD ring instance buffers and its record and table buffers as tiles stream in
// and out. ScatterVelocity cached the bind groups it made over those buffers for good, so the first frame after a ring
// grew drew TAA's velocity pass with a destroyed buffer ("used in submit while destroyed"). Each round below streams a
// tile in or out with the pass attached, so the rings and the record pool change size, and every frame must submit clean
// and keep carrying the scatter's wind motion.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { ScatterTiles } = await import('/packages/scatter/dist/tiles.js');
    const { ScatterVelocity } = await import('/packages/scatter/dist/velocity.js');
    const { TAA } = await import('/packages/taa/dist/index.js');
    const { PostStack } = await import('/packages/post/dist/index.js');
    const { MotionBlur } = await import('/packages/post/dist/motion-blur.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 4, -10], target: [0, 0, 8], near: 0.1, far: 200 },
    });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    // TAA (velocityOnly) reads a PostStack's scene depth, with MotionBlur reading its vectors, as a film runs it.
    let taa;
    const stack = PostStack.attach(engine, [new MotionBlur({ velocity: () => taa?.velocity, shutter: 0.5 })]);
    taa = TAA.attach(engine, { velocityOnly: true, depth: () => stack.depthTexture });
    const tiles = ScatterTiles.attach(engine, [box(0.3), box(0.3), box(0.3)], {
      bounds: [-64, -64, 64, 64],
      lod: [12, 24, 48],
      lodFade: 0,
      wind: [1, 0, 0.8, 12],
    });
    const velocity = new ScatterVelocity(tiles);
    taa.add(velocity);
    // n records spread over a tile, scale 1 (log scale byte 128).
    const records = (n) => {
      const r = new Uint8Array(n * 8);
      for (let i = 0; i < n; i++) {
        const x = ((i * 2654435761) >>> 0) & 0xffff,
          z = ((i * 40503) >>> 0) & 0xffff;
        r.set([x & 255, x >> 8, z & 255, z >> 8, 0, 128, i & 255, 0], i * 8);
      }
      return r;
    };
    const rings = () => tiles.instances.map((b) => b.size / 32);
    const frames = async (n) => {
      for (let i = 0; i < n; i++) engine.render({ delta: 1 / 30 });
      await device.queue.onSubmittedWorkDone();
    };
    const rounds = [];
    await frames(3); // the pass draws over the empty scatter's one-instance rings
    rounds.push({ step: 'empty', rings: rings(), errors: gpuErrors.length });
    for (const [step, act] of [
      ['add a', () => tiles.setTile('a', [0, 0], 16, records(64))],
      ['add b (rings grow)', () => tiles.setTile('b', [-16, 0], 16, records(4096))],
      ['add c (pool grows)', () => tiles.setTile('c', [0, 16], 16, records(4096))],
      ['remove b and c (rings shrink)', () => (tiles.removeTile('b'), tiles.removeTile('c'))],
      ['add d', () => tiles.setTile('d', [-16, 16], 16, records(2048))],
    ]) {
      const before = rings();
      act();
      await frames(3);
      rounds.push({ step, before, rings: rings(), errors: gpuErrors.length });
    }
    await device.queue.onSubmittedWorkDone();
    velocity.dispose();
    tiles.dispose();
    engine.dispose();
    return { rounds, gpuErrors: gpuErrors.slice(0, 4) };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, [], "every frame submits with the scatter's live buffers");
  // The rounds must really have remade the ring buffers, or this check proves nothing.
  const changed = result.rounds.filter((r) => r.before && r.before.join() !== r.rings.join()).length;
  assert.ok(changed >= 2, `the ring buffers were remade in ${changed} rounds`);
  console.log('scatter velocity over streamed tiles check passed');
} finally {
  await closeAll({ browser });
}
