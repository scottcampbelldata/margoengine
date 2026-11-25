// Browser side of threemf-layers-gpu-check.mjs: the 3MF Consortium's multiprop-opaque.3mf (a colour group under two
// texture layers, Star.png and Smiley.png, mixed by alpha) drawn unlit by create3MFMesh, with the front face turned to
// fill a 128 x 128 canvas. The page also decodes both images itself and returns their texels, so the check can blend the
// layers as the spec says and compare.
import { Engine } from '../../core/dist/extension.js';
import { parse3MFMaterials } from '../dist/threemf-materials.js';
import { create3MFMesh } from '../dist/threemf-mesh.js';

const errors = [],
  engine = await Engine.create(document.getElementById('a'), {
    camera: { position: [0.05, 0.05, 3], target: [0.05, 0.05, 0] },
  });
engine.stop();
// Orthographic: the face's 0..0.1 m square is the whole canvas.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 20;
  out[5] = 20;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

async function texels(data) {
  const image = await createImageBitmap(new Blob([data.slice()], { type: 'image/png' }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    }),
    canvas = new OffscreenCanvas(image.width, image.height),
    context = canvas.getContext('2d', { colorSpace: 'srgb' });
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: [...context.getImageData(0, 0, image.width, image.height).data],
  };
}

async function draw() {
  const bytes = await (
      await fetch(new URL('./fixtures/3mf-samples/multiprop-opaque.3mf', import.meta.url))
    ).arrayBuffer(),
    loaded = await parse3MFMaterials(bytes);
  // Turn the cube so its y = 0 face, the layered one, faces the camera: (x, y, z) to (x, z, -y), a rotation.
  const p = loaded.positions;
  for (let v = 0; v < p.length; v += 3) [p[v + 1], p[v + 2]] = [p[v + 2], -p[v + 1]];
  const model = await create3MFMesh(engine, loaded, { unlit: true });
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  return {
    layers: loaded.groups[0].layers,
    materials: model.materials.length,
    textures: model.textures.size,
    images: await Promise.all(loaded.textures.map((t) => texels(t.data))),
  };
}
window.check = { draw, errors };
window.ready = true;
