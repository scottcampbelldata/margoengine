// Real-GPU check of DeformedPoints (packages/animation/src/deformed-points.ts). A skinned strip and a morphed triangle,
// both hidden, are drawn as points: every vertex's point must sit on the pixel its analytic pose projects to, move
// when the clip or the morph weight moves, and cover the area its size, units and shape give. Nothing else may draw.
// Runs as `npm run test:gpu:points -w @margoengine/animation`; add `-- --compat` for the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { skinnedStrip } from '../test/fixture.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';

const bytes = ({ doc, buffers }) => ({
    doc,
    buffers: buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
  }),
  strip = skinnedStrip({ columns: 9 }),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5241 }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ({ strip, triangle, positions }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { DeformedPoints } = await import('/packages/animation/dist/deformed-points.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 1024,
          camera: { position: [1, 0.6, 5], target: [1, 0.6, 0], near: 0.01, far: 50 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      const load = ({ doc, buffers }) => {
          const model = parseGLTF(
            engine,
            doc,
            buffers.map((b) => Uint8Array.from(b)),
          );
          if (engine.plugins.get(model.name) !== model) engine.use(model);
          const animation = Animation.attach(model);
          animation.playing = false;
          model.root.visible = false;
          return { model, animation };
        },
        skinned = load(strip),
        morphed = load(triangle),
        red = DeformedPoints.attach(skinned.model, { size: 5, color: '#ff0000' }),
        blue = DeformedPoints.attach(morphed.model, { size: 5, color: '#0000ff' });
      red.visible = blue.visible = false;
      // In the task that rendered: the canvas's texture is gone once the frame is presented.
      const pixels = () => {
        engine.render({ culling: false, delta: 0 });
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d', { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height).data;
      };
      const background = pixels();
      const at = (image, [x, y]) => {
          const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
          return [image[i], image[i + 1], image[i + 2]];
        },
        isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60,
        isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60,
        // Pixels covered in one colour channel, part-covered rim pixels counted by their share.
        cover = (image, channel) => {
          let n = 0;
          for (let i = channel; i < image.length; i += 4)
            n += Math.max(0, image[i] - background[i]) / (255 - background[i]);
          return n;
        },
        pixel = ([x, y, z]) => {
          const m = engine.camera.matrix,
            w = m[3] * x + m[7] * y + m[11] * z + m[15];
          return [
            (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5 + 0.5) * canvas.width,
            (0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5) * canvas.height,
          ];
        },
        bent = (x, y, t) => {
          if (x < 1) return [x, y, 0];
          const a = (Math.PI / 2) * t,
            c = Math.cos(a),
            s = Math.sin(a);
          return [1 + (x - 1) * c - y * s, (x - 1) * s + y * c, 0];
        },
        vertices = positions.length / 3,
        pose = (t) =>
          Array.from({ length: vertices }, (_, v) => pixel(bent(positions[v * 3], positions[v * 3 + 1], t)));

      const changed = (image) => {
        let n = 0;
        for (let i = 0; i < image.length; i += 4)
          n += +(
            Math.abs(image[i] - background[i]) +
              Math.abs(image[i + 1] - background[i + 1]) +
              Math.abs(image[i + 2] - background[i + 2]) >
            12
          );
        return n;
      };
      red.visible = true;
      const steps = [];
      let before = null;
      // A looping clip's end is its start, so the last pose checked is just short of it.
      for (const t of [0, 0.5, 0.9]) {
        skinned.animation.play(0);
        skinned.animation.seek(t);
        const image = pixels(),
          now = pose(t);
        steps.push({
          t,
          onPoints: now.filter((p) => isRed(at(image, p))).length,
          // Where a point was and no point is now: the points left it.
          left: before
            ? before.filter((p) => now.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 6)).map((p) => at(image, p))
            : [],
          red: cover(image, 0),
          changed: changed(image),
        });
        before = now;
      }
      // Size, units and shape: 0.15 world units across, square then round.
      red.set({ sizeUnits: 'world', size: 0.15 });
      const span = Math.hypot(...pixel([0.15, 0, 0]).map((v, i) => v - pixel([0, 0, 0])[i])),
        square = cover(pixels(), 0);
      red.set({ shape: 'round' });
      const round = cover(pixels(), 0);
      red.visible = false;

      // Morph: the triangle's one target moves every vertex 0.3 along x.
      blue.visible = true;
      const p = morphed.model.primitives[0],
        morph = [];
      for (const weight of [0, 1, 0.5]) {
        p.weights[0] = weight;
        const image = pixels(),
          m = p.node.matrix,
          expected = [0, 1, 2].map((v) => {
            const x = p.vertices[v * 20] + 0.3 * weight,
              y = p.vertices[v * 20 + 1],
              z = p.vertices[v * 20 + 2];
            return pixel([
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            ]);
          });
        morph.push({
          weight,
          onPoints: expected.filter((q) => isBlue(at(image, q))).length,
          blue: cover(image, 2),
          changed: changed(image),
        });
      }
      const draws = engine.stats.drawCalls;
      red.dispose();
      blue.dispose();
      const after = changed(pixels()),
        error = await device.popErrorScope();
      return {
        compat: !!globalThis.__margoCompat,
        vertices,
        steps,
        span,
        square,
        round,
        morph,
        draws,
        after,
        deformed: !!skinned.model.primitives[0].deformed,
        validation: error?.message ?? null,
      };
    },
    { strip: bytes(strip), triangle: bytes(animatedTriangle()), positions: strip.positions },
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.equal(result.deformed, true, 'the strip is drawn from its deformed buffer');
  assert.equal(result.vertices, 18);
  for (const step of result.steps) {
    assert.equal(step.onPoints, 18, `every vertex has its point at t=${step.t}`);
    assert.ok(Math.abs(step.red / (18 * 25) - 1) < 0.1, `5 x 5 pixels a point: ${step.red} red pixels at t=${step.t}`);
    assert.ok(step.changed <= 18 * 36, `only the points draw: ${step.changed} pixels changed at t=${step.t}`);
    for (const colour of step.left)
      assert.ok(colour[0] < 200 || colour[1] > 60, `a point stayed behind at t=${step.t}`);
  }
  assert.ok(result.steps[1].left.length >= 6 && result.steps[2].left.length >= 6, 'the bent half moved');
  const area = result.span * result.span * 18;
  assert.ok(Math.abs(result.square / area - 1) < 0.1, `world squares cover ${result.square} of ${area} pixels`);
  assert.ok(
    Math.abs(result.round / result.square - Math.PI / 4) < 0.08,
    `discs cover ${result.round / result.square} of their squares`,
  );
  for (const step of result.morph) {
    assert.equal(step.onPoints, 3, `every morphed vertex has its point at weight ${step.weight}`);
    assert.ok(Math.abs(step.blue / (3 * 25) - 1) < 0.1, `${step.blue} blue pixels at weight ${step.weight}`);
    assert.ok(step.changed <= 3 * 36, `only the points draw at weight ${step.weight}`);
  }
  assert.equal(result.after, 0, 'disposed points draw nothing');
  console.log(`deformed points ok on ${result.compat ? 'the WebGL2 compatibility layer' : 'WebGPU'}`);
} finally {
  await browser.close();
}
