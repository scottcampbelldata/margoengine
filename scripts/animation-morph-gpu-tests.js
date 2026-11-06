// Real-GPU check of MorphWeightPlayer (packages/animation/src/morph-gpu.ts): for STEP, LINEAR and CUBICSPLINE weight
// tracks, each copy's weights after a frame must match sampleTrack on the CPU at that copy's time, looping or held,
// on 70 copies (140 items), so the last workgroup is part filled and a stray thread would corrupt a neighbour.
// Runs as `npm run test:gpu:morph -w @margoengine/animation` (check:gpu-packages).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5197 }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
      { Animation, sampleTrack } = await import('/packages/animation/dist/index.js'),
      { cloneModel } = await import('/packages/animation/dist/skeleton-utils.js'),
      { MorphWeightPlayer } = await import('/packages/animation/dist/morph-gpu.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 4096,
        camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.01, far: 50 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    const buffers = [],
      bufferViews = [],
      accessors = [],
      add = (values, type) => {
        const data = new Float32Array(values),
          id = buffers.length;
        buffers.push(new Uint8Array(data.buffer));
        bufferViews.push({ buffer: id, byteLength: data.byteLength });
        accessors.push({
          bufferView: id,
          componentType: 5126,
          count: data.length / { SCALAR: 1, VEC3: 3 }[type],
          type,
          ...(type === 'VEC3' ? { min: [-2, -2, -2], max: [2, 2, 2] } : {}),
        });
        return id;
      };
    const position = add([-1, -1, 0, 1, -1, 0, 0, 1, 0], 'VEC3'),
      delta = add([0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0], 'VEC3'),
      times = [0, 0.4, 1, 1.7],
      time = add(times, 'SCALAR'),
      // Two targets: two values per key; CUBICSPLINE holds in-tangent, value, out-tangent per key.
      linear = [0, 1, 0.5, 0.25, 1, 0, 0.2, 0.9],
      cubic = Array.from({ length: 4 * 3 * 2 }, (_, i) => Math.sin(i * 1.7) * 0.8),
      clips = { STEP: linear, LINEAR: linear, CUBICSPLINE: cubic },
      names = Object.keys(clips),
      animations = names.map((interpolation) => ({
        name: interpolation,
        channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
        samplers: [{ input: time, output: add(clips[interpolation], 'SCALAR'), interpolation }],
      })),
      doc = {
        asset: { version: '2.0' },
        buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
        bufferViews,
        accessors,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
          {
            primitives: [{ attributes: { POSITION: position }, targets: [{ POSITION: delta }, { POSITION: delta }] }],
            weights: [0, 0],
          },
        ],
        animations,
      };
    const source = parseGLTF(engine, doc, buffers);
    if (engine.plugins.get(source.name) !== source) engine.use(source);
    const copies = [source];
    for (let i = 1; i < 70; i++) copies.push(await cloneModel(source));
    const players = copies.map((model) => {
      const animation = Animation.attach(model);
      animation.playing = false;
      return animation;
    });
    const read = async (animation) => {
      const r = animation.resources[0],
        out = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(r.weights, r.slot.weights.offset * 4, out, 0, 8);
      device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const values = [...new Float32Array(out.getMappedRange())];
      out.unmap();
      out.destroy();
      return values;
    };
    let worst = 0,
      checks = 0;
    const byMode = {};
    let failure = null;
    // The clip's own float32 end time, which the shader reads.
    const duration = Math.fround(times.at(-1));
    for (const interpolation of names)
      for (const loop of [true, false]) {
        const label = interpolation + (loop ? ' loop' : ' held');
        byMode[label] = 0;
        const player = MorphWeightPlayer.attach(engine, interpolation, { loop }),
          track = players[0].clips.find((c) => c.name === interpolation).tracks[0],
          members = players.map((a, i) => {
            const member = { offset: (i % 13) * 0.37 - 1, speed: 0.5 + (i % 5) * 0.25 };
            player.add(a, member);
            return member;
          });
        // A frame advances plugins: hold the clock so each frame samples exactly `at`.
        player.playing = false;
        for (const at of [0, 0.4, 0.73, 1.7, 2.9, 11.3]) {
          player.time = at;
          engine.render({ culling: false });
          for (let i = 0; i < players.length; i++) {
            // Animation's own wrap, exact: a time on a whole lap is the clip's start (copy 5 at 1.7 is exactly that).
            const f = Math.fround,
              raw = f(f(f(at) * f(members[i].speed)) + f(members[i].offset)),
              local = loop ? ((raw % duration) + duration) % duration : Math.min(Math.max(raw, 0), duration);
            const expected = sampleTrack(track.times, track.values, 2, local, interpolation),
              actual = await read(players[i]);
            for (let c = 0; c < 2; c++) {
              if (Math.abs(actual[c] - expected[c]) > Math.max(worst, 1e-5))
                failure = { label, copy: i, at, ...members[i], local, duration, expected: expected[c], actual: actual[c], c };
              worst = Math.max(worst, Math.abs(actual[c] - expected[c]));
              byMode[label] = Math.max(byMode[label], Math.abs(actual[c] - expected[c]));
              checks++;
            }
          }
        }
        player.dispose();
      }
    const error = await device.popErrorScope();
    return { worst, checks, byMode, failure, validation: error?.message ?? null };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.ok(result.checks >= 3 * 2 * 6 * 70 * 2, 'every copy checked');
  assert.ok(result.worst < 1e-5, `GPU weights differ from sampleTrack by ${result.worst}`);
} finally {
  await browser.close();
}
