// Real-GPU check that a skinned, morphed primitive over the default maxPartVertices (262,144) loads as parts and
// deforms and draws exactly as the same mesh split by hand into one primitive per part (tests/support/
// split-skin-fixture.js, a 520 x 520-vertex grid of 270,400 vertices, two joints blended over x 0.8 to 1.2, one morph
// target, clip "bend" at t = 0.5). Per part, @margoengine/animation's deformed vertices (its GPU compute pass) must be
// bit for bit the hand-split primitive's, and bit for bit the whole primitive's (maxPartVertices 1,048,576, no split)
// at the vertices the part's vertexMap names; the rendered frames of the split and the hand-split model must be
// identical, pixel for pixel. Natively and on the WebGL2 layer (--compat). Run from the repository root after
// building packages:
//   node scripts/run-with-timeout.mjs -- node packages/gltf/scripts/test-skinned-parts-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const compat = compatRun(),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    assert.equal(Boolean(browser.hardware.compat), compat, 'the requested layer is the one in use');
    const errors = [];
    browser.page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    const result = await browser.page.evaluate(async () => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { splitSkinGrid, handSplit, partsOf } = await import('/tests/support/split-skin-fixture.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const size = 256,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${size}px;height:${size}px`;
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          exactSize: [size, size],
          capacity: 64,
          camera: { position: [1, 0.6, 2.6], target: [0.9, 0.6, 0], fov: 50, near: 0.05, far: 20 },
        }),
        device = engineRuntime(instance).gpu,
        validation = [];
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      const grid = splitSkinGrid(520, 520);
      // The frame as the canvas holds it.
      const frame = async () => {
        const context = canvas.getContext('webgpu');
        let texture;
        context.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const original = context.getCurrentTexture.bind(context);
        context.getCurrentTexture = () => (texture = original());
        try {
          instance.render({ culling: false, delta: 0 });
          const read = device.createBuffer({
              size: size * 4 * size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: size * 4 }, [size, size]);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(read.getMappedRange()).slice();
          read.unmap();
          read.destroy();
          return bytes;
        } finally {
          context.getCurrentTexture = original;
        }
      };
      // Renders until no pipeline is compiling (scripts/support/gpu-ready.js) and returns the last frame, drawn with
      // every pipeline in place; a slow driver gets the time it needs instead of a fixed count of renders.
      const settled = async () => {
        let pixels;
        await waitForPipelines(async () => {
          pixels = await frame();
        });
        return pixels;
      };
      // The deformed vertices of each primitive, as the GPU wrote them.
      const deformed = async (model) => {
        const out = [];
        for (const p of model.primitives) {
          const bytes = p.vertices.byteLength,
            read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
            encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(p.deformed, p.deformedOffset, read, 0, bytes);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          out.push(new Float32Array(read.getMappedRange().slice(0)));
          read.unmap();
          read.destroy();
        }
        return out;
      };
      // Loads one model, plays the bend to t = 0.5, and returns its frame, deformed vertices and parts.
      const run = async (doc, buffers, options) => {
        const model = parseGLTF(instance, doc, buffers, [], {}, options),
          animation = Animation.attach(model);
        animation.play('bend').seek(0.5);
        animation.playing = false;
        await model.compile();
        const pixels = await settled(),
          vertices = await deformed(model),
          parts = model.primitives[0].part ? partsOf(model).map((p) => ({ ...p, indices: p.indices.slice() })) : null,
          drawn = model.primitives.length;
        animation.dispose();
        model.dispose();
        return { pixels, vertices, parts, drawn };
      };
      const auto = await run(grid.doc, grid.buffers),
        split = handSplit(grid, auto.parts),
        hand = await run(split.doc, split.buffers),
        whole = await run(grid.doc, grid.buffers, { maxPartVertices: 1_048_576 });
      let differentPixels = 0,
        covered = 0;
      for (let i = 0; i < auto.pixels.length; i += 4) {
        if (
          auto.pixels[i] !== hand.pixels[i] ||
          auto.pixels[i + 1] !== hand.pixels[i + 1] ||
          auto.pixels[i + 2] !== hand.pixels[i + 2]
        )
          differentPixels++;
        if (auto.pixels[i] !== auto.pixels[0] || auto.pixels[i + 1] !== auto.pixels[1]) covered++;
      }
      let againstHand = 0,
        againstWhole = 0,
        moved = 0;
      auto.vertices.forEach((part, k) => {
        const map = auto.parts[k].vertexMap,
          mine = new Uint32Array(part.buffer),
          theirs = new Uint32Array(hand.vertices[k].buffer),
          all = new Uint32Array(whole.vertices[0].buffer);
        for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) againstHand++;
        for (let j = 0; j < map.length; j++)
          for (let c = 0; c < 20; c++) if (mine[j * 20 + c] !== all[map[j] * 20 + c]) againstWhole++;
        // The far end turned: the deformed position is off the bind pose.
        for (let j = 0; j < map.length; j++)
          if (Math.abs(part[j * 20 + 1] - grid.arrays.POSITION[map[j] * 3 + 1]) > 0.05) moved++;
      });
      instance.dispose?.();
      return {
        parts: auto.drawn,
        handParts: hand.drawn,
        wholeParts: whole.drawn,
        vertices: auto.vertices.reduce((n, v) => n + v.length / 20, 0),
        differentPixels,
        covered,
        againstHand,
        againstWhole,
        moved,
        validation,
      };
    });
    console.log(JSON.stringify(result));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.validation, []);
    assert.ok(result.parts >= 2, `${result.parts} parts`);
    assert.equal(result.handParts, result.parts);
    assert.equal(result.wholeParts, 1);
    assert.ok(result.vertices >= 270_400, `${result.vertices} vertices`);
    assert.ok(result.moved > 10_000, `the bend moved ${result.moved} vertices`);
    assert.ok(result.covered > 256 * 256 * 0.2, `the grid covers ${result.covered} pixels`);
    assert.equal(result.againstHand, 0, 'deformed parts differ from the hand-split primitives');
    assert.equal(result.againstWhole, 0, 'deformed parts differ from the whole primitive at their vertices');
    assert.equal(result.differentPixels, 0, 'the split model draws other pixels than the hand-split one');
    mkdirSync('test-results', { recursive: true });
    writeFileSync(
      `test-results/gltf-skinned-parts${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
    );
  },
  () => browser.close(),
);
