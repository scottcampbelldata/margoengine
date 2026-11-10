import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(async () => {
      const { packBaseTextures } = await import('/packages/gltf-pro/src/base-textures.ts');
      const { packedBaseWGSL } = await import('/packages/gltf-pro/src/base-textures-shader.js');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      device.pushErrorScope('validation');
      const inputs = [
        [1, 1, 1, 'rgba8unorm-srgb'],
        [2, 3, 2, 'rgba8unorm'],
        [7, 5, 3, 'rgba8unorm-srgb'],
        [4, 4, 3, 'rgba16float'],
        [13, 9, 4, 'rgba8unorm'],
      ].map(([width, height, levels, format], slot) => {
        const texture = device.createTexture({
          size: [width, height],
          mipLevelCount: levels,
          format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        for (let level = 0; level < levels; level++) {
          const w = Math.max(1, width >> level),
            h = Math.max(1, height >> level);
          const pixels = format === 'rgba16float' ? new Uint16Array(w * h * 4) : new Uint8Array(w * h * 4);
          const palette = format === 'rgba16float' ? [0, 0x3400, 0x3800, 0x3c00, 0x4000] : [0, 64, 128, 255];
          for (let i = 0; i < pixels.length; i++)
            pixels[i] =
              i % 4 === 3
                ? format === 'rgba16float'
                  ? 0x3c00
                  : 255
                : palette[(i * 7 + level + slot) % palette.length];
          device.queue.writeTexture(
            { texture, mipLevel: level },
            pixels,
            { bytesPerRow: w * (format === 'rgba16float' ? 8 : 4) },
            [w, h],
          );
        }
        return { texture, view: texture.createView(), width, height, levels };
      });
      const vertex = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}`;
      const target = () =>
        device.createTexture({
          size: [32, 32],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      const read = async (texture) => {
        const buffer = device.createBuffer({
          size: 32 * 32 * 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const e = device.createCommandEncoder();
        e.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512 }, [32, 32]);
        device.queue.submit([e.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        buffer.destroy();
        return data;
      };
      // Native texture filtering has implementation-defined interpolation precision. Validate the
      // array path against the continuous sampler equations, retaining native differences as evidence.
      const expected = (input, slot, scale, x, y, c) => {
        if (c === 3) return 1;
        const uv = [((x + 0.5) / 32) * scale - 0.37, ((y + 0.5) / 32) * scale - 0.19],
          sam = input.sampler;
        const lod = Math.log2((Math.max(input.width, input.height) * scale) / 32);
        const linear =
          (lod <= 0
            ? sam.magFilter
            : [9728, 9984, 9986].includes(sam.minFilter)
              ? 9728
              : 9729) === 9729;
        const l = [9728, 9729].includes(sam.minFilter) ? 0 : Math.max(0, Math.min(input.levels - 1, lod));
        const wrap = (q, n, mode) =>
          mode === 33071
            ? Math.max(0, Math.min(n - 1, q))
            : mode === 33648
              ? Math.min(((q % (2 * n)) + 2 * n) % (2 * n), 2 * n - 1 - (((q % (2 * n)) + 2 * n) % (2 * n)))
              : ((q % n) + n) % n;
        const at = (level) => {
          const w = Math.max(1, input.width >> level),
            h = Math.max(1, input.height >> level);
          const pixel = (px, py) => {
            const index = (wrap(py, h, sam.wrapT) * w + wrap(px, w, sam.wrapS)) * 4 + c;
            const palette = slot === 3 ? [0, 0.25, 0.5, 1, 2] : [0, 64 / 255, 128 / 255, 1];
            let value = palette[(index * 7 + level + slot) % palette.length];
            if (slot === 0 || slot === 2) value = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            return value;
          };
          if (!linear) return pixel(Math.floor(uv[0] * w), Math.floor(uv[1] * h));
          const px = uv[0] * w - 0.5,
            py = uv[1] * h - 0.5,
            ix = Math.floor(px),
            iy = Math.floor(py),
            fx = px - ix,
            fy = py - iy;
          return (
            (pixel(ix, iy) * (1 - fx) + pixel(ix + 1, iy) * fx) * (1 - fy) +
            (pixel(ix, iy + 1) * (1 - fx) + pixel(ix + 1, iy + 1) * fx) * fy
          );
        };
        if ([9984, 9985].includes(sam.minFilter)) return at(Math.floor(l + 0.5));
        const lo = Math.floor(l),
          hi = Math.min(input.levels - 1, lo + 1);
        return at(lo) * (1 - (l - lo)) + at(hi) * (l - lo);
      };
      let maxError = 0,
        maxNativeError = 0,
        nativeCase,
        cases = 0;
      try {
        for (const minFilter of [9728, 9729, 9984, 9985, 9986, 9987])
          for (const magFilter of [9728, 9729])
            for (const wrapS of [33071, 10497, 33648]) {
              const sources = inputs.map((s, slot) => ({
                ...s,
                sampler: { minFilter, magFilter, wrapS, wrapT: [33648, 33071, 10497][slot % 3] },
              }));
              const packed = packBaseTextures(device, sources);
              try {
                for (const scale of [1, 16])
                  for (let slot = 0; slot < 5; slot++) {
                    const input = sources[slot],
                      s = input.sampler;
                    const sampler = device.createSampler({
                      addressModeU: wrapS === 33071 ? 'clamp-to-edge' : wrapS === 33648 ? 'mirror-repeat' : 'repeat',
                      addressModeV:
                        s.wrapT === 33071 ? 'clamp-to-edge' : s.wrapT === 33648 ? 'mirror-repeat' : 'repeat',
                      magFilter: magFilter === 9728 ? 'nearest' : 'linear',
                      minFilter: [9728, 9984, 9986].includes(minFilter) ? 'nearest' : 'linear',
                      mipmapFilter: [9728, 9729, 9984, 9985].includes(minFilter) ? 'nearest' : 'linear',
                      lodMaxClamp: [9728, 9729].includes(minFilter) ? 0.25 : 32,
                    });
                    const pair = [];
                    for (const manual of [false, true]) {
                      const header = manual
                        ? packedBaseWGSL.replaceAll('@group(1)', '@group(0)')
                        : '@group(0) @binding(0) var source:texture_2d<f32>;@group(0) @binding(1) var s:sampler;';
                      const code =
                        header +
                        vertex +
                        `@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {let uv=(p.xy/32.0)*${scale}.0-vec2f(0.37,0.19);return ${manual ? `margoBaseSample(${slot},uv)` : 'textureSample(source,s,uv)'};}`;
                      const module = device.createShaderModule({ code });
                      const pipeline = device.createRenderPipeline({
                        layout: 'auto',
                        vertex: { module, entryPoint: 'vertex' },
                        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
                      });
                      const group = device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(0),
                        entries: manual
                          ? [
                              { binding: 0, resource: packed.view },
                              { binding: 1, resource: { buffer: packed.params } },
                            ]
                          : [
                              { binding: 0, resource: input.view },
                              { binding: 1, resource: sampler },
                            ],
                      });
                      const texture = target(),
                        encoder = device.createCommandEncoder();
                      const pass = encoder.beginRenderPass({
                        colorAttachments: [
                          { view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
                        ],
                      });
                      pass.setPipeline(pipeline);
                      pass.setBindGroup(0, group);
                      pass.draw(3);
                      pass.end();
                      device.queue.submit([encoder.finish()]);
                      pair.push(await read(texture));
                      texture.destroy();
                    }
                    let error = 0,
                      nativeError = 0,
                      nativeTruthError = 0;
                    for (let i = 0; i < pair[0].length; i++) {
                      const pixel = Math.floor(i / 4),
                        truth = expected(input, slot, scale, pixel % 32, Math.floor(pixel / 32), i % 4);
                      error = Math.max(error, Math.abs(truth - pair[1][i]));
                      nativeTruthError = Math.max(nativeTruthError, Math.abs(truth - pair[0][i]));
                      nativeError = Math.max(nativeError, Math.abs(pair[0][i] - pair[1][i]));
                    }
                    if (!Number.isFinite(error) || error > 0.005)
                      throw new Error(JSON.stringify({ minFilter, magFilter, wrapS, slot, scale, error, nativeError }));
                    // Nearest mode has no implementation-defined interpolation weights; this also checks the
                    // native sampler selects minFilter at positive footprint LOD when mip selection is disabled.
                    const nearest = Math.max(input.width, input.height) * scale <= 32 ? magFilter === 9728 : minFilter === 9728;
                    if ([9728, 9729].includes(minFilter) && nearest && (!Number.isFinite(nativeTruthError) || nativeTruthError > 0.005))
                      throw new Error(JSON.stringify({ minFilter, magFilter, wrapS, slot, scale, nativeTruthError }));
                    maxError = Math.max(maxError, error);
                    if (nativeError > maxNativeError) {
                      maxNativeError = nativeError;
                      nativeCase = { minFilter, magFilter, wrapS, slot, scale };
                    }
                    cases++;
                  }
              } finally {
                packed.destroy();
              }
            }
        const scope = await device.popErrorScope();
        if (scope) errors.push(scope.message);
        return { cases, maxError, maxNativeError, nativeCase, errors };
      } finally {
        for (const s of inputs) s.texture.destroy();
        device.destroy();
      }
    });
    assert.equal(result.cases, 360);
    assert.deepEqual(result.errors, []);
    writeFileSync(
      'test-results/batch201-base-textures' + (process.argv.includes('--compat') ? '-compat' : '') + '.json',
      JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
    );
    console.log(JSON.stringify(result));
  },
  () => browser.close(),
);
