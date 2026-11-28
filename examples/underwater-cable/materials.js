import { computeTangents, pbrVertexStream } from '@margoengine/geometry';
import { parsePreparedPBR } from '@margoengine/gltf/pbr';

const painted = (baseColorFactor, roughnessFactor = 0.7, metallicFactor = 0) => ({
  pbrMetallicRoughness: { baseColorFactor: [...baseColorFactor, 1], roughnessFactor, metallicFactor },
});

function scan(base = 0, tint = [1, 1, 1], rough = 1, metal = 1, relief = 1) {
  return {
    pbrMetallicRoughness: {
      baseColorTexture: { index: base },
      baseColorFactor: [...tint, 1],
      metallicRoughnessTexture: { index: base + 2 },
      roughnessFactor: rough,
      metallicFactor: metal,
    },
    normalTexture: { index: base + 1, scale: relief },
    occlusionTexture: { index: base + 2, strength: 0.55 },
  };
}

export const materials = {
  sand: scan(0, [0.8, 0.89, 0.83], 1, 0, 0.9),
  steel: scan(3, [0.9, 0.97, 1], 0.83, 0.65, 0.72),
  rock: scan(6, [0.65, 0.78, 0.71], 0.96, 0, 0.96),
  silver: painted([0.34, 0.43, 0.45], 0.42, 0.66),
  anodized: painted([0.15, 0.19, 0.21], 0.36, 0.48),
  brass: painted([0.43, 0.26, 0.11], 0.48, 0.45),
  amber: painted([0.51, 0.16, 0.018], 0.55, 0.25),
  zinc: painted([0.24, 0.26, 0.19], 0.88, 0.05),
  rubber: painted([0.024, 0.035, 0.038], 0.76),
  stripe: painted([0.76, 0.61, 0.16], 0.61),
  kelp: { ...painted([0.1, 0.17, 0.044], 0.7), doubleSided: true },
  eelgrass: { ...painted([0.05, 0.098, 0.045], 0.83), doubleSided: true },
  hull: { ...painted([0.027, 0.075, 0.102], 0.83), normalTexture: { index: 4, scale: 0.16 } },
  keel: { ...painted([0.169, 0.056, 0.034], 0.86), normalTexture: { index: 4, scale: 0.21 } },
  deck: painted([0.135, 0.17, 0.17], 0.84),
  white: painted([0.68, 0.72, 0.67], 0.49),
  windows: painted([0.022, 0.055, 0.064], 0.14, 0.27),
  beacon: { ...painted([0.13, 0.3, 0.21], 0.25), emissiveFactor: [0.1, 0.75, 0.43] },
  warmLamp: { ...painted([0.66, 0.39, 0.13], 0.18), emissiveFactor: [1, 0.58, 0.19] },
};

const maps = [
  'sand.jpg',
  'sand-normal.jpg',
  'sand-arm.jpg',
  'steel.jpg',
  'steel-normal.jpg',
  'steel-arm.jpg',
  'textures/coast_rocks_05_diff_1k.jpg',
  'textures/coast_rocks_05_nor_gl_1k.jpg',
  'textures/coast_rocks_05_arm_1k.jpg',
];

export function bitmap(url, signal) {
  return fetch(url, { signal }).then(async (response) => {
    if (!response.ok)
      throw new Error(
        'Asset request failed: ' +
          url.pathname +
          ' (' +
          response.status +
          '). Run node examples/underwater-cable/assets.mjs',
      );
    return createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  });
}

export function plateImage() {
  const canvas = new OffscreenCanvas(512, 256);
  const ink = canvas.getContext('2d');
  ink.fillStyle = '#17272b';
  ink.fillRect(0, 0, 512, 256);
  ink.strokeStyle = '#aabbac';
  ink.lineWidth = 4;
  ink.strokeRect(14, 14, 484, 228);
  ink.fillStyle = '#dce4cd';
  ink.font = 'bold 92px monospace';
  ink.fillText('CJ–04', 50, 125);
  ink.font = '36px monospace';
  ink.fillText('TIDAL ARRAY', 52, 178);
  ink.fillStyle = '#af8449';
  for (let x = 53; x < 444; x += 24) ink.fillRect(x, 200, 11, 13);
  return canvas.transferToImageBitmap();
}

export function suitNormalImage() {
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const pixels = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (x + y * size) * 4;
      const twill = Math.sin(((x + y * 0.5) * Math.PI) / 4);
      const cross = Math.cos((y * Math.PI) / 3.2 + 0.7 * twill);
      pixels.data.set([128 + 14 * twill, 128 + 12 * cross, 251, 255], i);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.transferToImageBitmap();
}
export async function materialImages(assetRoot, signal) {
  return Promise.all(maps.map((file) => bitmap(new URL(file, assetRoot), signal)));
}

export class SetModel {
  nodes = [];
  meshes = [];
  geometry = [];
  index = new Map();

  node(name, translation, { parent, rotation, scale } = {}) {
    const index = this.nodes.length;
    this.nodes.push({ name, translation, rotation, scale, children: [] });
    if (parent !== undefined) this.nodes[parent].children.push(index);
    return index;
  }

  part(name, geometry, material, translation = [0, 0, 0], options = {}) {
    let byMaterial = this.index.get(geometry);
    if (!byMaterial) this.index.set(geometry, (byMaterial = new Map()));
    let mesh = byMaterial.get(material);
    if (mesh === undefined) {
      mesh = this.meshes.length;
      byMaterial.set(material, mesh);
      const slot = Object.keys(materials).indexOf(material);
      if (slot === -1) throw new Error('Unknown material ' + material);
      this.meshes.push({ primitives: [{ attributes: {}, material: slot }] });
      this.geometry.push([
        { vertices: pbrVertexStream(computeTangents(geometry, { split: false })), indices: geometry.indices },
      ]);
    }
    const index = this.node(name, translation, options);
    this.nodes[index].mesh = mesh;
    return index;
  }

  load(engine, images) {
    const children = new Set(this.nodes.flatMap((node) => node.children));
    const roots = this.nodes.map((_, i) => i).filter((i) => !children.has(i));
    return parsePreparedPBR(
      engine,
      {
        asset: { version: '2.0' },
        nodes: this.nodes,
        meshes: this.meshes,
        materials: Object.values(materials),
        scenes: [{ nodes: roots }],
        scene: 0,
        samplers: [{ wrapS: 10497, wrapT: 10497, minFilter: 9987, magFilter: 9729 }],
        images: images.map(() => ({})),
        textures: images.map((_, source) => ({ source, sampler: 0 })),
      },
      this.geometry,
      images,
    );
  }
}

materials.plate = {
  pbrMetallicRoughness: { baseColorTexture: { index: 9 }, metallicFactor: 0.38, roughnessFactor: 0.56 },
};
const fabric = (baseColor, roughness = 0.79) => ({
  ...painted(baseColor, roughness),
  normalTexture: { index: 10, scale: 0.39 },
});
materials.suit = fabric([0.035, 0.044, 0.05]);
materials.redSuit = fabric([0.22, 0.037, 0.025]);
materials.hood = { ...fabric([0.028, 0.039, 0.05], 0.85), doubleSided: true };
materials.glove = fabric([0.041, 0.055, 0.062], 0.88);
materials.gear = painted([0.029, 0.038, 0.047], 0.72);
materials.stainless = painted([0.42, 0.45, 0.43], 0.42, 1);
materials.hose = painted([0.044, 0.051, 0.058], 0.72);
materials.tank = { ...painted([0.38, 0.4, 0.39], 0.59, 1), normalTexture: { index: 4, scale: 0.14 } };
materials.fin = { ...painted([0.037, 0.167, 0.189], 0.6), doubleSided: true };
materials.sensor = { ...painted([0.08, 0.18, 0.2], 0.26), emissiveFactor: [0.04, 0.14, 0.12] };
materials.visor = {
  pbrMetallicRoughness: { baseColorFactor: [0.14, 0.25, 0.32, 0.13], roughnessFactor: 0.1, metallicFactor: 0 },
  alphaMode: 'BLEND',
};
