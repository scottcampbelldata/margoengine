// Real-GPU check that an extended material (here KHR_materials_diffuse_roughness) decodes each map slot in its own
// colour space when slots share one glTF texture: specular (A, linear) and specular colour (RGB, sRGB) packed in one
// texture, the layout KHR_materials_specular suggests, must draw the same picture as the same pixels in two textures.
// A black base colour leaves only the specular terms, which scale with the specular colour. On WebGPU and, with
// --compat or MARGO_COMPAT=1, on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

// A 2 x 2 quad facing +Z: positions, normals, UVs, then indices.
const floats = new Float32Array([
    ...[-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
    ...[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    ...[0, 1, 1, 1, 1, 0, 0, 0],
  ]),
  indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
  bytes = new Uint8Array(floats.byteLength + indices.byteLength);
bytes.set(new Uint8Array(floats.buffer), 0);
bytes.set(new Uint8Array(indices.buffer), floats.byteLength);
const doc = {
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  buffers: [{ byteLength: bytes.byteLength }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 48 },
    { buffer: 0, byteOffset: 48, byteLength: 48 },
    { buffer: 0, byteOffset: 96, byteLength: 32 },
    { buffer: 0, byteOffset: 128, byteLength: 12 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
  ],
  extensionsUsed: ['KHR_materials_specular', 'KHR_materials_ior', 'KHR_materials_diffuse_roughness'],
};
const compat = process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1';
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (error) => errors.push(error.message));
    const result = await browser.page.evaluate(
      async ({ doc, buffer }) => {
        const { Engine } = await import('/packages/core/dist/index.js');
        const { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js');
        const { extendedMaterials } = await import('/packages/gltf/dist/extended.js');
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        canvas.style.cssText = 'width:64px;height:64px';
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 3], target: [0, 0, 0] },
        });
        engine.stop();
        const validation = [];
        engine.gpu.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
        engine.gpu.pushErrorScope('validation');
        const shot = async () => {
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          return canvas.toDataURL('image/png');
        };
        // One texel: RGB 100 (specular colour, sRGB 0.127 linear), A 200 (specular strength, linear 0.784).
        const pixel = () => ({ width: 1, height: 1, data: new Uint8Array([100, 100, 100, 200]) });
        const pictures = {};
        try {
          for (const [name, specular, color] of [
            ['separate', 0, 1],
            ['shared', 0, 0],
          ]) {
            const fixture = structuredClone(doc);
            fixture.textures = [{ source: 0 }, { source: 1 }];
            fixture.images = [{}, {}];
            fixture.materials = [
              {
                pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.5 },
                extensions: {
                  KHR_materials_ior: { ior: 3 },
                  KHR_materials_specular: {
                    specularTexture: { index: specular },
                    specularColorTexture: { index: color },
                  },
                  KHR_materials_diffuse_roughness: { diffuseRoughnessFactor: 0.5 },
                },
              },
            ];
            const model = await parseGLTFAsync(engine, fixture, [new Uint8Array(buffer)], [pixel(), pixel()], {
              decoders: { materials: extendedMaterials },
            });
            try {
              if (!model.materials[0].extended) throw new Error('the fixture material is not an extended material');
              pictures[name] = await shot();
            } finally {
              model.dispose();
            }
          }
          const scope = await engine.gpu.popErrorScope();
          if (scope) validation.push(scope.message);
          return { pictures, validation };
        } finally {
          engine.dispose();
          canvas.remove();
        }
      },
      { doc, buffer: Array.from(bytes) },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(result.validation, []);
    const [separate, shared] = await Promise.all(
      [result.pictures.separate, result.pictures.shared].map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))),
    );
    let max = 0,
      lit = 0,
      sumSeparate = 0,
      sumShared = 0;
    for (let i = 0; i < separate.data.length; i++) {
      if (i % 4 === 3) continue;
      max = Math.max(max, Math.abs(separate.data[i] - shared.data[i]));
      sumSeparate += separate.data[i];
      sumShared += shared.data[i];
      if (separate.data[i] > 8) lit++;
    }
    const report = {
      hardware: browser.hardware,
      compat,
      maxChannelError: max,
      litChannels: lit,
      meanSeparate: sumSeparate / ((separate.data.length * 3) / 4),
      meanShared: sumShared / ((shared.data.length * 3) / 4),
    };
    writeFileSync(
      `test-results/gltf-extended-colour-space${compat ? '-compat' : ''}.json`,
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
    // The quad's specular terms must show, so the comparison below has something to compare.
    assert.ok(lit > 100, `the specular picture is dark: ${lit} lit channels`);
    assert.ok(max <= 1, `specular colour packed with specular decodes in the wrong colour space: max channel ${max}`);
  },
  () => browser.close(),
);
