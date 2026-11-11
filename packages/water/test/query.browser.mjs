import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';

// The page and the results are paths of the repository root; test:gpu runs from packages/water.
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const observation = (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
  .trim()
  .split('\n')[2]
  .trim()
  .split(/\s+/)
  .map(Number);
try {
  const result = await browser.page.evaluate(async (windSpeed) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 128;
    canvas.style.cssText = 'width:192px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [1, 25, 0.01], target: [0, 0, 0], near: 0.1, far: 1000 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const compile = d.createShaderModule.bind(d);
    let fftCode = '';
    d.createShaderModule = (descriptor) => {
      if (descriptor.code.includes('struct SurfaceVertex')) fftCode = descriptor.code;
      return compile(descriptor);
    };
    const reports = [];
    const readSampleable = async (texture) => {
      const code = `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> values:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(image);if(any(id.xy>=size)){return;}
 values[id.y*size.x+id.x]=textureLoad(image,vec2i(id.xy),0);
}`;
      const module = compile({ code }),
        size = texture.width * texture.height * 16;
      const output = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const staging = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      const e = d.createCommandEncoder(),
        p = e.beginComputePass();
      p.setPipeline(pipeline);
      p.setBindGroup(0, group);
      p.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
      p.end();
      e.copyBufferToBuffer(output, 0, staging, 0, size);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      output.destroy();
      return { data, row: texture.width * 4 };
    };
    const read = async (texture) => {
      const row = Math.ceil((texture.width * 16) / 256) * 256;
      const buffer = d.createBuffer({
        size: row * texture.height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const e = d.createCommandEncoder();
      e.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
      d.queue.submit([e.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      return { data, row: row / 4 };
    };
    const texture = d.createTexture({
      size: [5, 5],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const heights = new Float32Array(25);
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) heights[j * 5 + i] = i === 4 ? 2 : -0.3 + j * 0.05;
    d.queue.writeTexture({ texture }, heights, { bytesPerRow: 20 }, [5, 5]);
    for (const kind of ['water', 'horizon', 'coast', 'still', 'fft', 'folded']) {
      const fft = kind === 'fft' || kind === 'folded';
      const surface = fft
        ? FFTOcean.attach(engine, {
            resolution: 16,
            segments: 19,
            size: 30,
            followCamera: true,
            windSpeed,
            amplitude: kind === 'folded' ? 30 : 1,
            choppiness: kind === 'folded' ? 5 : 1,
            cascades: [{ length: 32, minWavelength: 4 }],
          })
        : Water.attach(engine, {
            size: [30, 30],
            segments: 19,
            horizon: kind === 'horizon',
            ...(['coast', 'still'].includes(kind)
              ? { terrain: { heightmap: () => texture, origin: [-10, -10], size: [20, 20] }, still: kind === 'still' }
              : {}),
          });
      if (fft) surface.setTime(1.25);
      else surface.time = 1.25;
      engine.render({ delta: kind === 'coast' ? 1 / 60 : 0 });
      const snapshot = await WaveQuery.capture(surface);
      // Independent raster oracle: actual draw vertices, indices and uniforms, output interpolated world/normal.
      const code = fft ? fftCode.split('@fragment fn fragment')[0] : surface.shaderCode.split('fn linear')[0];
      const probe = compile({
        code:
          code +
          `
struct Probe {@location(0) world:vec4f,@location(1) normal:vec4f}
@fragment fn probe(i:${fft ? 'SurfaceVertex' : 'Output'})->Probe{
${fft ? '' : `if(inCoast(i.xz)){let s=coastal(i.xz);if(select(s.water.x<0.003,s.edge<=0.0,STILL)){discard;}}`}
return Probe(vec4f(i.world,1),vec4f(${fft ? 'oceanAt(i.base).normal' : 'normalize(i.normal)'},1));}`,
      });
      const targets = Array.from({ length: 2 }, () =>
        d.createTexture({
          size: [96, 64],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
      );
      const depth = d.createTexture({
        size: [96, 64],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const pipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: probe,
          entryPoint: 'vertex',
          ...(fft
            ? {}
            : {
                buffers: [
                  {
                    arrayStride: 12,
                    attributes: [
                      { shaderLocation: 0, offset: 0, format: 'float32x2' },
                      { shaderLocation: 1, offset: 8, format: 'float32' },
                    ],
                  },
                ],
              }),
        },
        fragment: {
          module: probe,
          entryPoint: 'probe',
          targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
        },
        primitive: { cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      const resources = fft
        ? [
            { binding: 0, resource: { buffer: surface.frameBuffer } },
            { binding: 1, resource: { buffer: surface.result } },
          ]
        : [
            { binding: 0, resource: { buffer: surface.uniform } },
            ...surface.view.resources[surface.view.drawn].flatMap((resource, binding) =>
              [3, 7].includes(binding) ? [{ binding, resource }] : [],
            ),
          ];
      const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources });
      const e = d.createCommandEncoder(),
        p = e.beginRenderPass({
          colorAttachments: targets.map((t) => ({ view: t.createView(), loadOp: 'clear', storeOp: 'store' })),
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
      p.setPipeline(pipeline);
      p.setBindGroup(0, group);
      if (!fft) p.setVertexBuffer(0, surface.vertices);
      p.setIndexBuffer(fft ? surface.indexBuffer : surface.indices, 'uint32');
      p.drawIndexed(19 * 19 * 6);
      p.end();
      d.queue.submit([e.finish()]);
      const world = await read(targets[0]),
        normals = await read(targets[1]);
      let count = 0,
        maxHeight = 0,
        maxNormal = 0;
      for (let y = 2; y < 62; y += 3)
        for (let x = 2; x < 94; x += 3) {
          const o = y * world.row + x * 4;
          if (world.data[o + 3] === 0) continue;
          const hit = snapshot.sample(world.data[o], world.data[o + 2]);
          if (!hit) throw new Error(`${kind}: missing CPU hit at ${world.data[o]},${world.data[o + 2]}`);
          maxHeight = Math.max(maxHeight, Math.abs(hit.height - world.data[o + 1]));
          for (let c = 0; c < 3; c++) maxNormal = Math.max(maxNormal, Math.abs(hit.normal[c] - normals.data[o + c]));
          count++;
        }
      // Differentiate actual GPU vertex displacement at fixed material coordinates.
      let maxVelocity = 0;
      if (kind === 'coast') {
        // Independent CPU conservative-flux oracle in the shallow interior (no offshore forcing/blend).
        const flux = await readSampleable(surface.coastal.fluxes[surface.coastal.current]);
        const state = await read(surface.coastal.states[surface.coastal.current]);
        const get = (image, x, z, c) =>
          image.data[Math.max(0, Math.min(4, z)) * image.row + Math.max(0, Math.min(4, x)) * 4 + c];
        const height = (x, z) => get(state, x, z, 0) + get(state, x, z, 1);
        const cellVelocity = (x, z) => {
          const q = [0, 1, 2, 3].map((c) => get(flux, x, z, c));
          const incoming = [
            x > 0 ? get(flux, x - 1, z, 1) : 0,
            x < 4 ? get(flux, x + 1, z, 0) : 0,
            z > 0 ? get(flux, x, z - 1, 3) : 0,
            z < 4 ? get(flux, x, z + 1, 2) : 0,
          ];
          const h = get(state, x, z, 0),
            ux = (q[1] - q[0] + incoming[0] - incoming[1]) / Math.max(0.04, 2 * h),
            uz = (q[3] - q[2] + incoming[2] - incoming[3]) / Math.max(0.04, 2 * h);
          const dh = (incoming[0] + incoming[1] - q[0] - q[1] + incoming[2] + incoming[3] - q[2] - q[3]) / 4;
          return [
            ux,
            dh + (ux * (height(x + 1, z) - height(x, z))) / 4 + (uz * (height(x, z + 1) - height(x, z))) / 4,
            uz,
          ];
        };
        let checked = 0;
        for (let o = 0; o < snapshot.vertices.length; o += 12) {
          const x = snapshot.vertices[o + 3],
            z = snapshot.vertices[o + 7];
          if (Math.abs(x) > 4 || Math.abs(z) > 4) continue;
          const px = (x + 10) / 4 - 0.5,
            pz = (z + 10) / 4 - 0.5,
            ix = Math.floor(px),
            iz = Math.floor(pz),
            tx = px - ix,
            tz = pz - iz,
            expected = [0, 0, 0];
          for (let j = 0; j < 2; j++)
            for (let i = 0; i < 2; i++) {
              const v = cellVelocity(ix + i, iz + j);
              for (let c = 0; c < 3; c++) expected[c] += v[c] * (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
            }
          for (let c = 0; c < 3; c++)
            maxVelocity = Math.max(maxVelocity, Math.abs(expected[c] - snapshot.vertices[o + 8 + c]));
          checked++;
        }
        if (checked < 10 || maxVelocity > 0.000001)
          throw new Error(`coastal flux mismatch: ${checked}, ${maxVelocity}`);
      }
      if (!['coast', 'still'].includes(kind)) {
        const epsilon = 0.002;
        if (fft) surface.setTime(1.25 - epsilon);
        else surface.time = 1.25 - epsilon;
        engine.render({ delta: 0 });
        const before = await WaveQuery.capture(surface);
        if (fft) surface.setTime(1.25 + epsilon);
        else surface.time = 1.25 + epsilon;
        engine.render({ delta: 0 });
        const after = await WaveQuery.capture(surface);
        for (let i = 0; i < snapshot.vertices.length; i += 12)
          for (let c = 0; c < 3; c++)
            maxVelocity = Math.max(
              maxVelocity,
              Math.abs(snapshot.vertices[i + 8 + c] - (after.vertices[i + c] - before.vertices[i + c]) / (2 * epsilon)),
            );
      }
      if (kind === 'still') {
        const middle = snapshot.sample(0, 0);
        if (!middle || Math.hypot(...middle.velocity) > 1e-6)
          throw new Error('still water must have zero particle velocity');
      }
      if (kind === 'coast' && !snapshot.vertices.some((v, i) => i % 12 === 8 && Math.abs(v) > 1e-6))
        throw new Error('coastal flow has no horizontal motion');
      const pair = await Promise.all([WaveQuery.capture(surface), WaveQuery.capture(surface)]);
      if (JSON.stringify(pair[0].sample(0, 0)) !== JSON.stringify(pair[1].sample(0, 0)))
        throw new Error('concurrent captures differ');
      if (!fft) {
        surface.setWaveHeight(0);
        const pendingEdit = await WaveQuery.capture(surface);
        if (JSON.stringify(pendingEdit.sample(0, 0)) !== JSON.stringify(pair[0].sample(0, 0)))
          throw new Error('unrendered wave edit leaked into last-drawn snapshot');
        surface.setWaveHeight(0.3);
      }
      const abort = new AbortController();
      const cancelled = WaveQuery.capture(surface, { signal: abort.signal });
      abort.abort();
      let aborted = false;
      try {
        await cancelled;
      } catch (e) {
        aborted = e.name === 'AbortError';
      }
      if (!aborted) throw new Error('in-flight cancellation must reject');
      if (kind === 'fft') {
        const pending = WaveQuery.capture(surface);
        surface.onDeviceRestored(surface.engine);
        let restoredRejected = false;
        try {
          await pending;
        } catch (e) {
          restoredRejected = e.code === 'state';
        }
        if (!restoredRejected) throw new Error('restoration did not invalidate pending capture');
        engine.render({ delta: 0 });
        await WaveQuery.capture(surface);
      }
      const saved = snapshot.heightAt(0, 0);
      surface.dispose();
      if (snapshot.heightAt(0, 0) !== saved) throw new Error('snapshot changed after disposal');
      let disposedRejected = false;
      try {
        await WaveQuery.capture(surface);
      } catch (e) {
        disposedRejected = e.code === 'state';
      }
      targets.forEach((t) => t.destroy());
      depth.destroy();
      reports.push({ kind, count, maxHeight, maxNormal, maxVelocity, disposedRejected });
    }
    const validation = await d.popErrorScope();
    texture.destroy();
    d.createShaderModule = compile;
    engine.dispose();
    return { reports, validation: validation?.message ?? null };
  }, observation[6]);
  assert.equal(result.validation, null);
  assert.deepEqual(errors, []);
  for (const row of result.reports) {
    assert.ok(row.count > 30, JSON.stringify(row));
    // Folded triangles choose the topmost hit; the raster oracle uses the same overhead ray.
    assert.ok(row.maxHeight < 0.002, JSON.stringify(row));
    assert.ok(row.maxNormal < 0.002, JSON.stringify(row));
    assert.ok(row.maxVelocity < 0.03, JSON.stringify(row));
    assert.equal(row.disposedRejected, true);
  }
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-query-${browser.hardware?.compat ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(
      { hardware: browser.hardware, observation: { station: '46042', windSpeed: observation[6] }, ...result },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
