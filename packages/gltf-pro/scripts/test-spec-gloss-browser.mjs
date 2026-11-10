import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (error) => errors.push(error.message));
    const input = animatedTriangle();
    delete input.doc.skins;
    delete input.doc.animations;
    delete input.doc.nodes[0].skin;
    const rows = await browser.page.evaluate(
      async ({ doc, buffers }) => {
        const { Engine } = await import('/packages/core/dist/index.js');
        const { parseGLTFAsync, loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
        const { extendedMaterials } = await import('/packages/gltf-pro/dist/extended.js');
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        canvas.style.cssText = 'width:128px;height:128px';
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
        const shot = async () => {
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          return canvas.toDataURL('image/png');
        };
        try {
          for (const [diffuse, specular, gloss, base, metal] of [
            [[0.2, 0.4, 0.8, 1], [0.04, 0.04, 0.04], 0.5, [0.2, 0.4, 0.8, 1], 0],
            [[0, 0, 0, 1], [1, 0.766, 0.336], 0.5, [1, 0.766, 0.336, 1], 1],
            [[0.5, 0.5, 0.5, 0.75], [0.04, 0.04, 0.04], 0, [0.5, 0.5, 0.5, 0.75], 0],
          ]) {
            const pictures = [];
            for (const spec of [false, true]) {
              const material = spec
                ? {
                    extensions: {
                      KHR_materials_pbrSpecularGlossiness: {
                        diffuseFactor: diffuse,
                        specularFactor: specular,
                        glossinessFactor: gloss,
                      },
                    },
                  }
                : {
                    pbrMetallicRoughness: { baseColorFactor: base, metallicFactor: metal, roughnessFactor: 1 - gloss },
                    extensions: { KHR_materials_specular: {} },
                  };
              const fixture = structuredClone(doc);
              fixture.materials = [material];
              if (spec) fixture.extensionsRequired = ['KHR_materials_pbrSpecularGlossiness'];
              const model = await parseGLTFAsync(
                engine,
                fixture,
                buffers.map((b) => new Uint8Array(b)),
                [],
                spec ? {} : { decoders: { materials: extendedMaterials } },
              );
              try {
                pictures.push(await shot());
              } finally {
                model.dispose();
              }
            }
            rows.push({ pictures, metal, gloss });
          }
          engine.camera.position = [0, 0.1, 0.65];
          engine.camera.target = [0, 0.1, 0];
          const model = await loadGLTF(engine, '/examples/assets/khronos-samples/SpecGlossVsMetalRough.glb');
          try {
            rows.push({
              real: true,
              pictures: [await shot()],
              primitives: model.primitives.length,
              extension: model.asset.hooks.materials.extensions,
            });
            // Compare the standard asset's independently authored workflows at identical placement.
            for (const node of model.nodes.slice(2)) node.visible = false;
            model.nodes[0].setPosition([0, 0, 0]);
            model.nodes[1].setPosition([0, 0, 0]);
            const comparison = [];
            for (const selected of [0, 1]) {
              model.nodes[0].visible = selected === 0;
              model.nodes[1].visible = selected === 1;
              comparison.push(await shot());
            }
            rows.push({ comparison: true, pictures: comparison });
          } finally {
            model.dispose();
          }
          const scope = await engine.gpu.popErrorScope();
          if (scope) validation.push(scope.message);
          return { rows, validation };
        } finally {
          engine.dispose();
          canvas.remove();
        }
      },
      {
        doc: input.doc,
        buffers: input.buffers.map((b) => Array.from(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))),
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.validation, []);
    for (const row of rows.rows) {
      const pictures = await Promise.all(row.pictures.map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))));
      if (row.comparison) {
        let sum = 0,
          max = 0;
        for (let i = 0; i < pictures[0].data.length; i++) {
          const error = Math.abs(pictures[0].data[i] - pictures[1].data[i]);
          sum += error;
          max = Math.max(max, error);
        }
        row.meanAbsoluteChannelError = sum / pictures[0].data.length;
        row.maxChannelError = max;
      assert.ok(row.meanAbsoluteChannelError < 1, `standard workflows diverged: ${row.meanAbsoluteChannelError}`);
      } else if (row.real) {
        writeFileSync(
          `test-results/batch201-spec-gloss${process.argv.includes('--compat') ? '-compat' : ''}.png`,
          Buffer.from(row.pictures[0].split(',')[1], 'base64'),
        );
        assert.deepEqual(row.extension, ['KHR_materials_pbrSpecularGlossiness']);
        assert.ok(row.primitives >= 4);
        const unique = new Set();
        for (let i = 0; i < pictures[0].data.length; i += 4) unique.add(pictures[0].data.subarray(i, i + 3).join(','));
        assert.ok(unique.size > 100, `real asset colours: ${unique.size}`);
      } else {
        let max = 0,
          changed = 0;
        for (let i = 0; i < pictures[0].data.length; i++) {
          max = Math.max(max, Math.abs(pictures[0].data[i] - pictures[1].data[i]));
          if (pictures[0].data[i] !== pictures[1].data[i]) changed++;
        }
        assert.ok(max <= 1, `endpoint metal=${row.metal} gloss=${row.gloss}: max channel ${max}, changed ${changed}`);
        row.maxChannelError = max;
      }
      delete row.pictures;
    }
    writeFileSync(
      `test-results/batch201-spec-gloss${process.argv.includes('--compat') ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, ...rows }, null, 2) + '\n',
    );
    console.log(JSON.stringify(rows));
  },
  () => browser.close(),
);
