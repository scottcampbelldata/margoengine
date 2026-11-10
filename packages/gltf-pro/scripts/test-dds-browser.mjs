import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { dds, bc1Solid } from '../../decoders/tests/support/texture-encoders.js';
import { decodePNG } from '../../../tests/support/png.js';

const fixture = materialQuad();
fixture.doc.buffers.forEach(
  (d, i) =>
    (d.uri = 'data:application/octet-stream;base64,' + Buffer.from(fixture.buffers[i].buffer).toString('base64')),
);
fixture.doc.materials = [
  { extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
];
fixture.doc.extensionsRequired = ['MSFT_texture_dds'];
fixture.doc.textures = [{ extensions: { MSFT_texture_dds: { source: 0 } } }];
const vectors = JSON.parse(readFileSync(new URL('../../decoders/tests/fixtures/bc/vectors.json', import.meta.url)));
const formats = new Set();
const samples = vectors.filter((v) => {
  if (formats.has(v.format)) return false;
  formats.add(v.format);
  return true;
});
const dxgi = {
  'bc1-rgba-unorm': 71,
  'bc2-rgba-unorm': 74,
  'bc3-rgba-unorm': 77,
  'bc4-r-unorm': 80,
  'bc4-r-snorm': 81,
  'bc5-rg-unorm': 83,
  'bc5-rg-snorm': 84,
  'bc6h-rgb-ufloat': 95,
  'bc6h-rgb-float': 96,
  'bc7-rgba-unorm': 98,
};
const files = samples.map(({ format, block }) => ({
  format,
  bytes: Array.from(dds({ width: 4, height: 4, dx10: { format: dxgi[format] }, data: Buffer.from(block, 'hex') })),
}));
files.push({
  format: 'bc1-mips',
  bytes: Array.from(
    dds({
      width: 4,
      height: 4,
      mips: 3,
      fourCC: 'DXT1',
      data: new Uint8Array([...bc1Solid(255, 0, 0), ...bc1Solid(255, 0, 0), ...bc1Solid(255, 0, 0)]),
    }),
  ),
});
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const result = await browser.page.evaluate(
      async ({ doc, files }) => {
        const { Engine } = await import('/packages/core/dist/index.js');
        const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js');
        const { decodeDDSImage } = await import('/packages/gltf-pro/dist/dds.js');
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 3], target: [0, 0, 0] },
        });
        engine.stop();
        const validation = [];
        engine.gpu.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
        engine.gpu.pushErrorScope('validation');
        const rows = [];
        try {
          for (const file of files) {
            const pictures = [];
            for (const software of [false, true]) {
              const input = structuredClone(doc);
              input.images = [{ uri: 'data:image/vnd-ms.dds;base64,' + btoa(String.fromCharCode(...file.bytes)) }];
              const model = await parseGLTFAsync(
                engine,
                input,
                software
                  ? {
                      decoders: {
                        dds: {
                          decode(data) {
                            const image = decodeDDSImage(data);
                            const facade = (device) => ({
                              features: new Set(),
                              limits: device.limits,
                              createTexture: device.createTexture.bind(device),
                              queue: device.queue,
                            });
                            return {
                              ...image,
                              gpuFormat: (d, s) => image.gpuFormat(facade(d), s),
                              upload: (d, s) => image.upload(facade(d), s),
                            };
                          },
                        },
                      },
                    }
                  : {},
              );
              try {
                await waitForPipelines(async () => {
                  engine.render({ delta: 0 });
                  await engine.gpu.queue.onSubmittedWorkDone();
                });
                pictures.push(canvas.toDataURL('image/png'));
              } finally {
                model.dispose();
              }
            }
            rows.push({ format: file.format, pictures });
          }
          const scoped = await engine.gpu.popErrorScope();
          if (scoped) validation.push(scoped.message);
          return { rows, validation };
        } finally {
          engine.dispose();
          canvas.remove();
        }
      },
      { doc: fixture.doc, files },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(result.validation, []);
    for (const row of result.rows) {
      const images = await Promise.all(row.pictures.map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))));
      let max = 0;
      for (let i = 0; i < images[0].data.length; i++)
        max = Math.max(max, Math.abs(images[0].data[i] - images[1].data[i]));
      assert.ok(max <= 1, row.format + ': native/fallback channel error ' + max);
      if (row.format === 'bc1-mips')
        assert.ok(images[0].data[(32 * 64 + 32) * 4] > 100, 'DDS material must render red');
      row.maxChannelError = max;
      delete row.pictures;
    }
    writeFileSync(
      'test-results/batch201-dds' + (process.argv.includes('--compat') ? '-compat' : '') + '.json',
      JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
    );
    console.log(JSON.stringify(result));
  },
  () => browser.close(),
);
