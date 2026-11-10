// MASK cut-out at alpha exactly equal to alphaCutoff (glTF 2.0 3.9.4: alpha >= cutoff renders opaque) when the vertex
// colour alpha is 1 or COLOR_0 is absent. Base colour factor alpha 0.5 times a white texel is exactly 0.5 (an rgba8
// texel cannot hold 0.5); cutoff 0.5. Interpolating a constant vertex alpha of 1 leaves 0.99999994 in some pixels,
// which cut about half of a tilted grid before the fix. Colour, pick and shadow-caster paths must keep every texel.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

/** A 40 x 40 quad grid 4 m wide, tilted 45 degrees (perspective-correct interpolation), with optional COLOR_0 alpha. */
function grid(alpha, cutoff) {
  const n = 40,
    pos = [],
    col = [],
    idx = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      pos.push((x / n) * 4 - 2, (y / n) * 4 - 2, 0);
      col.push(1, 1, 1, alpha ?? 1);
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  const buffers = [new Float32Array(pos), new Float32Array(col), new Uint32Array(idx)];
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews: buffers.map((b, i) => ({ buffer: i, byteLength: b.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-2, -2, 0], max: [2, 2, 0] },
      { bufferView: 1, componentType: 5126, count: col.length / 4, type: 'VEC4' },
      { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
    meshes: [
      {
        primitives: [
          { attributes: alpha === undefined ? { POSITION: 0 } : { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5], metallicFactor: 0, roughnessFactor: 1 },
        alphaMode: 'MASK',
        alphaCutoff: cutoff,
        doubleSided: true,
      },
    ],
    nodes: [{ mesh: 0, rotation: [-0.3826834, 0, 0, 0.9238795] }],
    scenes: [{ nodes: [0] }],
  };
  return { doc, buffers: buffers.map((b) => [...new Uint8Array(b.buffer)]) };
}

const compat = process.argv.includes('--compat');
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const payload = {
      reference: grid(1, 0.49),
      vertex: grid(1, 0.5),
      absent: grid(undefined, 0.5),
      below: grid(0.999, 0.5),
    };
    const result = await browser.page.evaluate(async (payload) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Picking } = await import('/packages/selection/dist/index.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:320px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 50, near: 0.1, far: 40 },
        }),
        engine = engineRuntime(instance),
        validation = [],
        picker = Picking.attach(instance, { capture: false }),
        shadows = Shadows.attach(instance, { resolution: 256, distance: 12 });
      engine.lighting.direction.set([0.3, 1, 0.4, 1]);
      // Layer 0 of the directional shadow map, one number a texel.
      const readShadow = async () => {
        const device = engine.gpu,
          texture = shadows.depthTexture,
          size = 4 * texture.width,
          row = Math.ceil(size / 256) * 256,
          read = device.createBuffer({ size: row * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        if (texture.format !== 'depth32float') throw new Error('shadow map format ' + texture.format);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture, aspect: 'depth-only' },
          { buffer: read, bytesPerRow: row },
          [texture.width, texture.height, 1],
        );
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const all = new Float32Array(read.getMappedRange().slice(0)),
          out = new Float32Array(texture.width * texture.height);
        for (let y = 0; y < texture.height; y++)
          out.set(all.subarray((y * row) / 4, (y * row) / 4 + texture.width), y * texture.width);
        read.unmap();
        read.destroy();
        return out;
      };
      engine.gpu.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      const render = async () => {
        const device = engine.gpu,
          context = canvas.getContext('webgpu');
        let texture;
        context.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const original = context.getCurrentTexture.bind(context);
        context.getCurrentTexture = () => (texture = original());
        try {
          instance.render({ culling: false });
          const read = device.createBuffer({
            size: 1280 * 320,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: 1280 }, [320, 320]);
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
      // Pick points spread over the grid's projection (through @margoengine/selection, which draws `pickingPrimitives`).
      const points = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) points.push([64 + x * 27.3 + 0.37, 96 + y * 21.1 + 0.61]);
      const out = {};
      for (const [name, fixture] of Object.entries(payload)) {
        const model = await parseGLTF(
          instance,
          fixture.doc,
          fixture.buffers.map((b) => new Uint8Array(b)),
          [],
        );
        const removeCaster = shadows.add(model);
        // Pipelines compile asynchronously: render until two frames agree.
        let pixels = await render();
        for (let t = 0; t < 20; t++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const next = await render(),
            same = next.every((v, i) => v === pixels[i]);
          pixels = next;
          if (same && t > 2) break;
        }
        const shadow = await readShadow(),
          remove = picker.add(model);
        let picked = 0;
        for (const point of points) if (await instance.pick(...point)) picked++;
        remove();
        removeCaster();
        out[name] = {
          pixels,
          picked,
          shadow,
          shadowVertexAlpha: model.shadowPrimitives[0]?.vertexAlpha ?? null,
          pickVertexAlpha: model.pickingPrimitives[0]?.vertexAlpha ?? null,
        };
        model.dispose();
      }
      picker.dispose();
      shadows.dispose?.();
      // The fully cut grid casts nothing: its map holds only the cleared depth.
      const clear = out.below.shadow[0],
        cast = (v) => v.shadow.reduce((n, d) => n + (d !== clear ? 1 : 0), 0);
      const background = (p) => {
        let count = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] === p[0] && p[i + 1] === p[1] && p[i + 2] === p[2]) count++;
        return count;
      };
      const differ = (a, b) => {
        let count = 0;
        for (let i = 0; i < a.length; i += 4)
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
        return count;
      };
      const each = (f) => Object.fromEntries(Object.entries(out).map(([k, v]) => [k, f(v)]));
      return {
        validation,
        points: points.length,
        backgroundPixels: each((v) => background(v.pixels)),
        differFromReference: each((v) => differ(v.pixels, out.reference.pixels)),
        picked: each((v) => v.picked),
        clearDepthEverywhere: out.below.shadow.every((d) => d === clear),
        shadowTexels: each(cast),
        shadowVertexAlpha: each((v) => v.shadowVertexAlpha),
        pickVertexAlpha: each((v) => v.pickVertexAlpha),
      };
    }, payload);
    console.log(JSON.stringify(result));
    assert.deepEqual(result.validation, []);
    // The reference (cutoff 0.49) covers a large share of the frame.
    assert.ok(result.backgroundPixels.reference < 320 * 320 * 0.5, JSON.stringify(result.backgroundPixels));
    // Alpha exactly at the cutoff: the colour pass keeps every pixel, with COLOR_0 alpha 1 and without COLOR_0.
    assert.equal(result.differFromReference.vertex, 0, 'COLOR_0 alpha 1 cut pixels at alpha == cutoff');
    assert.equal(result.differFromReference.absent, 0, 'no COLOR_0 cut pixels at alpha == cutoff');
    // Control: vertex alpha 0.999 puts alpha at 0.4995, below the cutoff, and the whole grid is cut.
    assert.equal(result.backgroundPixels.below, 320 * 320, 'vertex alpha below 1 still cuts');
    // Picking keeps every point at the cutoff and none below it.
    assert.equal(result.picked.reference, result.points);
    assert.equal(result.picked.vertex, result.points, 'pick lost points at alpha == cutoff (COLOR_0 alpha 1)');
    assert.equal(result.picked.absent, result.points, 'pick lost points at alpha == cutoff (no COLOR_0)');
    assert.equal(result.picked.below, 0, 'pick kept points below the cutoff');
    // The shadow map: the grid at the cutoff casts exactly what it casts below a 0.49 cutoff; below it, nothing.
    assert.ok(result.clearDepthEverywhere, 'the fully cut grid wrote the shadow map');
    assert.ok(result.shadowTexels.reference > 1000, JSON.stringify(result.shadowTexels));
    assert.equal(result.shadowTexels.vertex, result.shadowTexels.reference, 'shadow lost texels at alpha == cutoff');
    assert.equal(result.shadowTexels.absent, result.shadowTexels.reference, 'shadow lost texels (no COLOR_0)');
    // Shadow casters and pick primitives take the vertexAlpha: false path only when every alpha is 1.
    assert.deepEqual(result.shadowVertexAlpha, { reference: false, vertex: false, absent: false, below: null });
    assert.deepEqual(result.pickVertexAlpha, { reference: false, vertex: false, absent: false, below: null });
    writeFileSync(
      `test-results/gltf-pro-mask-alpha${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
    );
  },
  () => browser.close(),
);
