// Browser side of threemf-finish-gpu-check.mjs: export3MF writes a quad with a metallic-roughness map or factors, and
// parse3MFMaterials with create3MFMesh draws it back on a 128 x 128 canvas, lit. The reference draws the same quad as
// four smaller quads, each an untextured material holding that quadrant's roughness and metalness as numbers.
import { Engine } from '../../core/dist/extension.js';
import { export3MF } from '../../exporters/dist/threemf.js';
import { png } from '../../exporters/dist/png.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { parse3MFMaterials } from '../dist/threemf-materials.js';
import { create3MFMesh } from '../dist/threemf-mesh.js';

const errors = [],
  engine = await Engine.create(document.getElementById('a'), { camera: { position: [0, 0, 3], target: [0, 0, 0] } });
engine.stop();
// Orthographic: x and y pass through, so the quad's -1..1 square is the whole canvas.
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
// The sun near the view direction, so a smooth surface and a rough one reflect it very differently.
engine.lighting.direction.set([0.25, 0.35, 1, 3]);
engine.onError = (error) => errors.push(String(error));
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

// A tint that 8-bit sRGB holds exactly.
const TINT = [230, 188, 124].map((byte) => ((byte / 255 + 0.055) / 1.055) ** 2.4);
// The map's texels, top row first, as [roughness, metalness] bytes.
const TEXELS = [
  [51, 255],
  [255, 0],
  [153, 128],
  [89, 204],
];
/** The quad from (x0, y0) to (x1, y1): top-left, top-right, bottom-right, bottom-left, with glTF coordinates. */
const quad = (x0, y0, x1, y1) => ({
  positions: new Float32Array([x0, y1, 0, x1, y1, 0, x1, y0, 0, x0, y0, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 3, 2, 0, 2, 1]),
});

async function file({ tint, map, textured = true, metalness, roughness }) {
  const image = async (bytes) => ({
      image: await png({ width: 2, height: 2, data: new Uint8Array(bytes) }, 2, false),
      mimeType: 'image/png',
      magFilter: 'nearest',
    }),
    material = { color: tint ? [...TINT, 1] : [1, 1, 1, 1], metalness, roughness };
  if (textured) material.baseColorTexture = await image(Array(16).fill(255));
  if (map) material.metallicRoughnessTexture = await image(TEXELS.flatMap(([r, m]) => [0, r, m, 255]));
  return export3MF({ nodes: [{ geometry: quad(-1, -1, 1, 1), material }] }, { upAxis: 'z', unit: 'meter' });
}

let shown;
async function show() {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
}

/** Draws the file read back from 3MF. */
async function drawn(source, options = {}) {
  shown?.();
  const loaded = await parse3MFMaterials(await file(source)),
    model = await create3MFMesh(engine, loaded, { doubleSided: false, ...options });
  shown = () => model.dispose();
  await show();
  const [group] = loaded.groups;
  return { layered: !!group.layers, metallic: group.metallic };
}

/** Draws the four quadrants with `values[quadrant]` = [roughness, metalness]. */
async function reference(tint, values) {
  shown?.();
  const corners = [
      [-1, 0, 0, 1],
      [0, 0, 1, 1],
      [-1, -1, 0, 0],
      [0, -1, 1, 0],
    ],
    made = values.map(([roughness, metalness], k) => {
      const material = new Material({ color: tint ? TINT : [1, 1, 1], roughness, metalness }),
        mesh = createMesh(engine, quad(...corners[k]), material);
      return () => {
        mesh.destroy();
        material.dispose();
      };
    });
  shown = () => made.forEach((dispose) => dispose());
  await show();
}

window.check = { drawn, reference, texels: TEXELS, errors };
window.ready = true;
