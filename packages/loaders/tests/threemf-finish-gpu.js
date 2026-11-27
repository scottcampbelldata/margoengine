// Browser side of threemf-finish-gpu-check.mjs: export3MF writes a quad with metallic or specular maps or factors, and
// parse3MFMaterials with create3MFMesh draws it back on a 128 x 128 canvas, lit. The reference draws the same quad as
// four smaller quads, each an untextured material holding that quadrant's values as numbers. A translucent box over a
// white wall is compared with a material given the transmission and volume the file was written from.
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
// A specular colour map's texels, top row first, as sRGB bytes.
const COLORS = [
  [255, 128, 64],
  [64, 255, 128],
  [128, 64, 255],
  [200, 200, 200],
];
/** The quad from (x0, y0) to (x1, y1): top-left, top-right, bottom-right, bottom-left, with glTF coordinates. */
const quad = (x0, y0, x1, y1) => ({
  positions: new Float32Array([x0, y1, 0, x1, y1, 0, x1, y0, 0, x0, y0, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 3, 2, 0, 2, 1]),
});

async function file({ tint, map, textured = true, metalness, roughness, specular }) {
  const image = async (bytes) => ({
      image: await png({ width: 2, height: 2, data: new Uint8Array(bytes) }, 2, false),
      mimeType: 'image/png',
      magFilter: 'nearest',
    }),
    material = { color: tint ? [...TINT, 1] : [1, 1, 1, 1], metalness, roughness };
  if (textured) material.baseColorTexture = await image(Array(16).fill(255));
  if (map) material.metallicRoughnessTexture = await image(TEXELS.flatMap(([r, m]) => [0, r, m, 255]));
  if (specular) {
    const extension = { specularColorFactor: specular.factor };
    if (specular.map)
      extension.specularColorTexture = { texture: await image(COLORS.flatMap((texel) => [...texel, 255])) };
    material.extensions = { KHR_materials_specular: extension };
  }
  return export3MF({ nodes: [{ geometry: quad(-1, -1, 1, 1), material }] }, { upAxis: 'z', unit: 'meter' });
}

let shown, frame;
// The pixels are copied in the page, in the task that renders: an element screenshot between draws makes ANGLE D3D11
// drop some of the WebGL2 layer's later draws (docs/known-bugs.md, KB-ANGLE-CAPTUREDRAW1).
async function show() {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  engine.render();
  const canvas = document.getElementById('a'),
    copy = new OffscreenCanvas(128, 128).getContext('2d', { willReadFrequently: true });
  copy.drawImage(canvas, 0, 0, 128, 128);
  frame = copy.getImageData(0, 0, 128, 128).data;
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
  return { layered: !!group.layers, metallic: group.metallic, specular: group.specular };
}

/**
 * Draws the four quadrants with `values[quadrant]` = [roughness, metalness, f0?]. A reflectance at normal incidence is
 * given the other way from create3MFMesh: as a specular colour over the index 1.5, whose own reflectance is 0.04.
 */
async function reference(tint, values) {
  shown?.();
  const corners = [
      [-1, 0, 0, 1],
      [0, 0, 1, 1],
      [-1, -1, 0, 0],
      [0, -1, 1, 0],
    ],
    made = values.map(([roughness, metalness, f0], k) => {
      const material = new Material({
          color: tint ? TINT : [1, 1, 1],
          roughness,
          metalness,
          ...(f0 ? { specularColor: f0.map((value) => value / 0.04) } : {}),
        }),
        mesh = createMesh(engine, quad(...corners[k]), material);
      return () => {
        mesh.destroy();
        material.dispose();
      };
    });
  shown = () => made.forEach((dispose) => dispose());
  await show();
}

/** A closed box from -1 to 1 on every axis, faces outward: mean chord 4 V / S = 4 / 3. */
function box() {
  const corners = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    faces = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ];
  return {
    positions: new Float32Array(corners),
    normals: new Float32Array(corners.map((value) => value / Math.sqrt(3))),
    uvs: new Float32Array(16),
    indices: new Uint32Array(faces),
  };
}

/** A white unlit wall behind the box, which shows through it. */
function wall() {
  const material = new Material({ shading: 'basic' }),
    geometry = quad(-1, -1, 1, 1);
  geometry.positions.forEach((_, i) => {
    if (i % 3 === 2) geometry.positions[i] = -2;
  });
  const mesh = createMesh(engine, geometry, material);
  return () => {
    mesh.destroy();
    material.dispose();
  };
}

const GLASS = { roughness: 0.2, ior: 1.4, color: [0.5, 0.8, 0.3], distance: 0.75 };

/** The glass box written to 3MF, read back and drawn; `textured` puts it on a stack under a white texture. */
async function glass(textured) {
  shown?.();
  const material = {
    roughness: GLASS.roughness,
    ior: GLASS.ior,
    transmission: 1,
    extensions: {
      KHR_materials_volume: { attenuationColor: GLASS.color, attenuationDistance: GLASS.distance },
    },
  };
  if (textured)
    material.baseColorTexture = {
      image: await png({ width: 1, height: 1, data: new Uint8Array(4).fill(255) }, 1, false),
      mimeType: 'image/png',
    };
  const loaded = await parse3MFMaterials(
      await export3MF({ nodes: [{ geometry: box(), material }] }, { upAxis: 'z', unit: 'meter' }),
    ),
    behind = wall(),
    model = await create3MFMesh(engine, loaded, { doubleSided: false, normals: 'flat' });
  shown = () => {
    model.dispose();
    behind();
  };
  await show();
  const [group] = loaded.groups,
    [drawn] = model.materials;
  return {
    layered: !!group.layers,
    translucent: group.translucent,
    values: [drawn.thickness, drawn.ior, drawn.attenuationDistance, ...drawn.attenuationColor],
  };
}

/** The same box drawn with a material built from the glTF values and the box's mean chord. */
async function glassReference(thickness, color = GLASS.color) {
  shown?.();
  const material = new Material({
      roughness: GLASS.roughness,
      ior: GLASS.ior,
      transmission: 1,
      thickness,
      attenuationColor: color,
      attenuationDistance: GLASS.distance,
    }),
    behind = wall(),
    geometry = box();
  // Flat normals, one vertex per corner.
  const flat = { positions: [], normals: [], uvs: [], indices: [] };
  for (let t = 0; t < geometry.indices.length; t += 3) {
    const corner = [0, 1, 2].map((k) => [...geometry.positions.slice(geometry.indices[t + k] * 3).slice(0, 3)]),
      [a, b, c] = corner,
      u = b.map((value, i) => value - a[i]),
      v = c.map((value, i) => value - a[i]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      length = Math.hypot(...n);
    for (const point of corner) {
      flat.indices.push(flat.positions.length / 3);
      flat.positions.push(...point);
      flat.normals.push(...n.map((value) => value / length));
      flat.uvs.push(0, 0);
    }
  }
  const mesh = createMesh(
    engine,
    {
      positions: new Float32Array(flat.positions),
      normals: new Float32Array(flat.normals),
      uvs: new Float32Array(flat.uvs),
      indices: new Uint32Array(flat.indices),
    },
    material,
  );
  shown = () => {
    mesh.destroy();
    material.dispose();
    behind();
  };
  await show();
}

/** The last frame's RGB at each point. */
const pixels = (points) => points.map(([x, y]) => [...frame.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)]);

window.check = { drawn, reference, glass, glassReference, pixels, texels: TEXELS, colors: COLORS, errors };
window.ready = true;
