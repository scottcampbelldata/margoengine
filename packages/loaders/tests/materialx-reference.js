// Browser side of materialx-reference-check.mjs (KB3108). Draws one fixture document of fixtures/materialx-reference,
// converted by toGraph, on a 2 x 2 plane that fills the 128 x 128 canvas exactly (8 x 8 pixels per texel of the 16 x 16
// images), lit head-on. The runner draws source.mtlx and the MaterialX 1.39.5 bake of it, baked.mtlx, under the same
// light and compares the two pictures. Images are uploaded as their request says: rgba8unorm-srgb for srgb_texture,
// rgba8unorm otherwise, with no sampler, so the node material reads texels exactly (textureLoad).
import { Engine } from '../../core/dist/extension.js';
import { Material, createMesh, installNodeMaterial } from '../../materials/dist/index.js';
import { parseMaterialX } from '../dist/materialx.js';

const errors = [],
  engine = await Engine.create(document.getElementById('a'), { camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  device = engine.gpu;
engine.stop();
// Orthographic: x and y pass through, so the plane's -1..1 square is the whole canvas.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

const plane = {
  positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
let current;

/** Draws `fixtures/materialx-reference/<name>/<file>`; returns what toGraph skipped. */
async function draw(name, file) {
  current?.();
  const url = new URL(`./fixtures/materialx-reference/${name}/${file}`, import.meta.url),
    textures = [],
    doc = parseMaterialX(await (await fetch(url)).text()),
    { graph, skipped } = await doc.toGraph(undefined, {
      async texture({ file: path, colorspace }) {
        const bitmap = await createImageBitmap(await (await fetch(new URL(path, url))).blob(), {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none',
          }),
          texture = device.createTexture({
            size: [bitmap.width, bitmap.height],
            format: colorspace === 'srgb_texture' ? 'rgba8unorm-srgb' : 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
        // Materials meshes put image row 0 at v = 1, so the upload flips them.
        device.queue.copyExternalImageToTexture({ source: bitmap, flipY: true }, { texture }, [bitmap.width, bitmap.height]);
        textures.push(texture);
        return { view: texture.createView() };
      },
    });
  const model = createMesh(engine, plane, new Material({ color: [1, 1, 1] })),
    installation = installNodeMaterial(model, graph);
  current = () => {
    installation.dispose();
    model.dispose();
    for (const texture of textures) texture.destroy();
  };
  engine.lighting.direction.set([0, 0, 1, 1]);
  engine.lighting.radiance.set([1, 1, 1, 0.2]);
  device.pushErrorScope('validation');
  engine.render();
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  if (error) errors.push(error.message);
  return skipped.map((skip) => skip.input);
}
window.check = { draw, errors };
window.ready = true;
