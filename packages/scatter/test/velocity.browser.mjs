// Real-GPU proof of `@margoengine/scatter/velocity` (FG-16), run from the repository root after building packages:
//   node packages/scatter/test/velocity.browser.mjs            (WebGPU)
//   MARGO_COMPAT=1 node packages/scatter/test/velocity.browser.mjs   (the WebGL2 layer)
// A still camera over a meadow of GPU-built grass in wind, TAA in velocityOnly mode (no jitter), so every motion vector
// is the grass's own:
//  1. Without ScatterVelocity TAA's vectors over the meadow are all 0 (the camera does not move): before FG-16 swaying
//     grass took no motion, so MotionBlur and TAA saw it as still.
//  2. With it, the blades the colour pass left in the depth buffer carry vectors (depth-equal matched), bounded by the
//     largest move the wind bend can make in one frame, and mostly along the wind's screen direction.
//  3. Wind strength 0: no vectors though the pass draws (no false motion).
//  4. Both the diffuse and the PBR stage, no GPU validation error; a 700,000-clump field draws its motion too.
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
    const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { GrassScatter } = await import('/packages/scatter/dist/grass.js');
    const { ScatterVelocity } = await import('/packages/scatter/dist/velocity.js');
    const { TAA } = await import('/packages/taa/dist/index.js');
    const { PostStack } = await import('/packages/post/dist/index.js');
    const { MotionBlur } = await import('/packages/post/dist/motion-blur.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.style.cssText = 'width:256px;height:256px';
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 3, 6], target: [0, 0, 0], near: 0.1, far: 200 },
    });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    // MotionBlur in a PostStack, as a film uses it: TAA (velocityOnly, no jitter) reads the stack's scene depth.
    let taa;
    const stack = PostStack.attach(engine, [new MotionBlur({ velocity: () => taa?.velocity, shutter: 0.5 })]);
    taa = TAA.attach(engine, { velocityOnly: true, depth: () => stack.depthTexture });
    const half = (h) => {
      const s = h & 0x8000 ? -1 : 1,
        e = (h >> 10) & 31,
        f = h & 1023;
      return e === 0 ? s * f * 2 ** -24 : e === 31 ? NaN : s * (1 + f / 1024) * 2 ** (e - 15);
    };
    const vectors = async () => {
      const t = taa.velocity.texture,
        row = Math.ceil((t.width * 4) / 256) * 256,
        buffer = device.createBuffer({
          size: row * t.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        e = device.createCommandEncoder();
      e.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: row }, [t.width, t.height]);
      device.queue.submit([e.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(buffer.getMappedRange().slice(0)),
        out = [];
      for (let y = 0; y < t.height; y++)
        for (let x = 0; x < t.width; x++) {
          const k = (y * row) / 2 + x * 2;
          out.push([half(words[k]) * t.width, half(words[k + 1]) * t.height]);
        }
      buffer.destroy();
      return out;
    };
    // Pixels moving more than a hundredth of a pixel, the largest move, and the share along the wind on screen.
    const measure = (v, along) => {
      let moving = 0,
        largest = 0,
        aligned = 0;
      for (const [x, y] of v) {
        const m = Math.hypot(x, y);
        if (!(m > 0.01)) continue;
        moving++;
        largest = Math.max(largest, m);
        if (Math.abs(x * along[0] + y * along[1]) / m > 0.5) aligned++;
      }
      return { moving, largest, aligned: moving ? aligned / moving : 0 };
    };
    const material = new PbrMaterial({ color: [0.2, 0.45, 0.1], roughness: 0.9 });
    const run = async ({ lit = false, pass = true, strength = 0.8, count = 4000 }) => {
      const grass = GrassScatter.attach(engine, {
        count,
        area: [12, 12],
        lod: [4, 8, 30],
        lodFade: 0,
        seed: 3,
        wind: [1, 0, strength, 12],
        ...(lit ? { material } : {}),
      });
      const velocity = pass ? new ScatterVelocity(grass) : undefined,
        remove = velocity ? taa.add(velocity) : undefined;
      for (let i = 0; i < 12; i++) engine.render({ delta: 1 / 30 });
      await device.queue.onSubmittedWorkDone();
      // The wind along +x is screen +x for this camera (it looks down -z).
      const out = measure(await vectors(), [1, 0]);
      remove?.();
      velocity?.dispose();
      grass.dispose();
      engine.render({ delta: 1 / 30 });
      return out;
    };
    const out = {
      none: await run({ pass: false }),
      diffuse: await run({}),
      pbr: await run({ lit: true }),
      calm: await run({ strength: 0 }),
      big: await run({ count: 700_000 }),
    };
    await device.queue.onSubmittedWorkDone();
    out.gpuErrors = gpuErrors;
    engine.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
  assert.equal(result.none.moving, 0, 'without ScatterVelocity the still camera sees no motion over the grass');
  for (const k of ['diffuse', 'pbr', 'big']) {
    const r = result[k];
    // The core of the near ring alone gave 72 pixels once covered tips and rings wrote hashed depth: the pass must draw
    // the coverage-depth stages too, or most of the meadow's depth keeps the camera's motion (about 39,000 with them).
    assert.ok(r.moving > 20_000, `${k}: blades carry the wind's motion (${r.moving} pixels)`);
    // At 30 fps the gust phase moves at most 1.7 x 12 / 30 rad a frame and the bend's sideways reach is under a blade
    // height (0.6 m) at about 6 m: well under 30 pixels a frame here.
    assert.ok(r.largest < 30, `${k}: the largest move ${r.largest} px is inside the wind bend's bound`);
    assert.ok(r.aligned > 0.6, `${k}: motion is mostly along the wind (${r.aligned})`);
  }
  assert.equal(result.calm.moving, 0, 'no wind, no motion');
  console.log('scatter velocity check passed');
} finally {
  await closeAll({ browser });
}
