// Regression (2026-11-15): passes that redraw core meshes with depthCompare 'equal' (TAA object velocity, SSAO's ambient,
// SSGI's and SSR's replays, the selection mask) keep only the samples whose depth matches the colour pass bit for bit.
// WGSL promises that two programs compute the same position only when both declare it @invariant (W3C WGSL 12.10;
// reassociation and fusion, 15.7.5), and core's colour vertex did not. This check draws green core meshes at many
// rotations, scales and depths, then replays them after the main pass with core's own vertex code and depthCompare
// 'equal', writing magenta. Every covered sample must be replaced: a green channel above zero anywhere means the replay
// missed a sample the colour pass wrote. Runs on WebGPU, and on the WebGL2 layer under MARGO_COMPAT=1.
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/depth-equal.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.modern);
  const covered = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/extension.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0.3, 0.7, 9], target: [0, 0, -20], far: 400 },
    });
    e.scene.background = '#000000';
    e.gpu.addEventListener('uncapturederror', (ev) => {
      throw ev.error;
    });
    const material = new PbrMaterial({ color: '#00ff00', roughness: 0.6 }),
      geometry = box();
    // A fixed spread: overlapping boxes from 3 to 160 units away, rotated on all axes and scaled unevenly, so many
    // pixels sit on far, steep and intersecting surfaces where depth has the least room to spare.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let k = 0; k < 320; k++) {
      const z = -3 - random() * 157,
        spread = 0.3 * (9 - z);
      e.createMesh()
        .setGeometry(geometry)
        .setMaterial(material)
        .setPosition([(random() - 0.5) * spread, (random() - 0.5) * spread, z])
        .setRotation([random() * 6.283, random() * 6.283, random() * 6.283])
        .setScale([1 + random() * 6, 1 + random() * 6, 1 + random() * 6]);
    }
    let pipeline, source;
    e.use({
      name: 'depth-equal-replay',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'depth-equal-replay',
          order: 1,
          execute(c) {
            // Core's shader as every replay takes it (c.shader), with a fragment that only marks the sample.
            if (source !== c.shader) {
              source = c.shader;
              const code = c.shader.replace(
                /@fragment fn fragment[\s\S]*$/,
                '@fragment fn fragment(i:Output)->@location(0) vec4f{return vec4f(1,0,1,1);}',
              );
              const module = c.device.createShaderModule({ code });
              pipeline = c.device.createRenderPipeline({
                ...c.descriptor,
                layout: 'auto',
                vertex: { ...c.descriptor.vertex, module },
                fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
                primitive: { ...c.descriptor.primitive, cullMode: 'none' },
                depthStencil: { ...c.descriptor.depthStencil, depthWriteEnabled: false, depthCompare: 'equal' },
              });
            }
            c.draw({ pipeline, bindings: [], clear: false });
          },
        });
      },
    });
    await waitForPipelines(async () => {
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
    });
    e.render();
    await e.gpu.queue.onSubmittedWorkDone();
    window.finish = () => e.dispose();
    return { meshes: e.meshes.size, compat: !!globalThis.__margoCompat };
  });
  assert.equal(covered.meshes, 320);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  let magenta = 0,
    missed = 0,
    first;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = image.data.subarray(i, i + 3);
    if (g > 0) {
      missed++;
      first ??= `pixel ${(i / 4) % image.width},${Math.floor(i / 4 / image.width)} = ${r},${g},${b}`;
    } else if (r > 0 || b > 0) magenta++;
  }
  // The scene covers most of the frame; a near-empty frame would prove nothing.
  assert.ok(magenta > image.width * image.height * 0.3, `replay marked ${magenta} pixels`);
  assert.equal(missed, 0, `the depth-equal replay missed ${missed} covered pixels (first: ${first})`);
  await page.evaluate(() => window.finish());
  assert.deepEqual(errors, []);
  console.log(
    `depth-equal replay of core meshes (${covered.compat ? 'WebGL2 layer' : 'WebGPU'}): ${magenta} pixels, 0 missed`,
  );
} finally {
  await browser.close();
}
