import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const { Engine } = await import('/packages/core/dist/index.js');
    const { boxGeometry } = await import('/packages/geometry/dist/index.js');
    const m = await import('/packages/materials/dist/index.js');
    const { NodeMaterial, uniform, texture, positionLocal, vec3 } = await import('/packages/shader/dist/index.js');
    const { LightingMaterial } = await import('/packages/shader/dist/lighting.js');
    const { captureMaterials, restoreMaterials } = await import('/packages/save/dist/materials.js');
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      exactSize: [128, 128],
      capacity: 64,
      camera: { position: [0, 0, 3], target: [0, 0, 0] },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    const map = new m.Texture(
      { data: new Uint8Array([160, 80, 40, 255]), width: 1, height: 1 },
      { colorSpace: 'srgb' },
    );
    const tint = uniform([0.7, 0.9, 0.4]);
    const values = {
      pbr: new m.PbrMaterial({
        map,
        roughness: 0.4,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
        emissive: [0.03, 0.01, 0],
      }),
      wgsl: new m.WgslMaterial({
        wgsl: 'fn shade(i:Out,s:Surface)->Surface {var o=s;o.base=vec4f(o.base.rgb*uniforms.tint,o.base.a);return o;}',
        uniforms: { tint: [0.8, 0.3, 0.7] },
        map,
      }),
      node: new NodeMaterial({
        colorNode: texture(map).rgb.mul(tint),
        positionNode: positionLocal.add(vec3(0.1, 0, 0)),
      }),
      lighting: new LightingMaterial({ lightingNode: tint }),
    };
    const read = async () => {
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      engine.render({ delta: 0 });
      const bitmap = await createImageBitmap(canvas),
        context = new OffscreenCanvas(128, 128).getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return context.getImageData(0, 0, 128, 128).data;
    };
    const imageCanvas = new OffscreenCanvas(1, 1),
      imageContext = imageCanvas.getContext('2d');
    imageContext.fillStyle = '#a05028';
    imageContext.fillRect(0, 0, 1, 1);
    const png = await imageCanvas.convertToBlob(),
      url = URL.createObjectURL(png);
    const addressed = await m.loadTexture(url);
    const addressedState = JSON.parse(
      JSON.stringify(
        await captureMaterials(
          { addressed: new m.Material({ map: addressed }) },
          { textureURL: (t) => (t === addressed ? url : undefined) },
        ),
      ),
    );
    const addressedCopy = await restoreMaterials(addressedState);
    if (addressedCopy.addressed.map.width !== 1) throw Error('URL texture did not restore');
    addressedCopy.addressed.map.dispose();
    addressedCopy.addressed.dispose();
    addressed.dispose();
    URL.revokeObjectURL(url);
    let different = 0,
      lit = 0;
    try {
      const saved = JSON.parse(JSON.stringify(await captureMaterials(values)));
      const restored = await restoreMaterials(saved);
      for (const key of Object.keys(values)) {
        const mesh = m.createMesh(engine, boxGeometry(1, 1, 1), values[key]);
        const before = await read();
        mesh.dispose();
        const replacement = m.createMesh(engine, boxGeometry(1, 1, 1), restored[key]);
        const after = await read();
        for (let i = 0; i < before.length; i++) {
          if (before[i] !== after[i]) different++;
          if (i % 4 === 0 && before[i] > 25) lit++;
        }
        replacement.dispose();
      }
      const validation = await device.popErrorScope();
      for (const material of Object.values(restored)) material.dispose();
      return { different, lit, validation: validation?.message };
    } finally {
      engine.dispose();
    }
  });
  console.log(JSON.stringify(result));
  assert.equal(result.different, 0);
  assert.ok(result.lit > 100);
  assert.equal(result.validation, undefined);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
