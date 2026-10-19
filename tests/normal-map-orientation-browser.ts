import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh } from '../packages/materials/dist/index.js';
import type { MeshGeometry } from '../packages/materials/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { planeGeometry, computeTangents } from '../packages/geometry/dist/index.js';

// Which way a normal map's +Y (green) bends the surface, on the GPU. A normal map's +Y is up the image (glTF 2.0
// material.schema.json normalTexture: "+X is right and +Y is up. +Z points toward the viewer"). Where image-up lands
// depends on the UV convention: glTF puts texture (0, 0) at the image's upper-left corner (spec, "Textures"), so up is
// decreasing v; materials meshes use three.js orientation with flipY image uploads, so up is increasing v. Every case
// below places image-up at world +y (`up` 1) or, for the mirrored UV1 set, world -y (`up` -1).

const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [];
// Exactly 80 backing pixels per world unit: the 3 x 2 quad covers pixels 40-280 x 40-200.
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
engine.gpu!.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

/** Tangent-space normals as an image, row 0 the image's top; `normal(x, yUp)` takes image-up y, 0 bottom to 1 top. */
function image(size: number, normal: (x: number, yUp: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++) {
      const n = normal((column + 0.5) / size, 1 - (row + 0.5) / size),
        length = Math.hypot(...n),
        o = (row * size + column) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = Math.round((n[k] / length) * 127.5 + 127.5);
      data[o + 3] = 255;
    }
  return createImageBitmap(new ImageData(data, size, size), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}
// tilt: every texel 128,200,200 (bent toward image-up). bump: a raised Gaussian dome, its normals from the height's slope.
const maps = {
  tilt: () => image(4, () => [0, 0.569, 0.569]),
  bump: () =>
    image(32, (x, y) => {
      const s = 0.18,
        h = Math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) / (2 * s * s)),
        k = 0.3 / (s * s);
      return [k * (x - 0.5) * h, k * (y - 0.5) * h, 1];
    }),
};

function gltf(bitmap: ImageBitmap, tangents: boolean) {
  const P = new Float32Array([-1.5, -1, 0, 1.5, -1, 0, 1.5, 1, 0, -1.5, -1, 0, 1.5, 1, 0, -1.5, 1, 0]),
    N = Float32Array.from({ length: 18 }, (_, i) => +(i % 3 === 2)),
    // glTF UVs: the top edge (y = 1) reads the image's top row, v = 0.
    UV = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]),
    // glTF's bitangent = cross(N, T) * w: (1, 0, 0, 1) gives B = +y, up the image for these UVs.
    T = Float32Array.from({ length: 24 }, (_, i) => +(i % 4 === 0 || i % 4 === 3)),
    buffers = tangents ? [P, N, UV, T] : [P, N, UV],
    types = ['VEC3', 'VEC3', 'VEC2', 'VEC4'];
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews: buffers.map((b, i) => ({ buffer: i, byteLength: b.byteLength })),
    accessors: buffers.map((_, i) => ({
      bufferView: i,
      componentType: 5126,
      count: 6,
      type: types[i],
      ...(i ? {} : { min: [-1.5, -1, 0], max: [1.5, 1, 0] }),
    })),
    images: [{}],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, normalTexture: { index: 0 } }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, ...(tangents ? { TANGENT: 3 } : {}) }, material: 0 },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return parseGLTF(engine, doc, buffers, [bitmap]);
}

type MeshCase = 'mesh' | 'mesh-tangents' | 'mesh-uv1';
function mesh(bitmap: ImageBitmap, mode: MeshCase) {
  const plane = planeGeometry(3, 2);
  let geometry: MeshGeometry = mode === 'mesh-tangents' ? computeTangents(plane) : plane;
  if (mode === 'mesh-uv1')
    // The UV groups check's mirrored set: UV1 runs down the quad, so image-up is world -y; UV0 tangents do not apply.
    geometry = {
      positions: [-1.5, -1, 0, 1.5, -1, 0, 1.5, 1, 0, -1.5, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      uvs1: [0, 1, 1, 1, 1, 0, 0, 0],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
  const texture = new Texture(bitmap),
    material = new Material({ color: [1, 1, 1], roughness: 1, metalness: 0, normalMap: texture });
  if (mode === 'mesh-uv1') material.setUVTransform({ texCoord: 1 }, 'normalMap');
  const model = createMesh(engine, geometry, material);
  return {
    dispose() {
      model.dispose();
      texture.dispose();
    },
  };
}

let current: { dispose(): void } | undefined;
(window as any).normalOrientation = {
  errors,
  /** Draws `kind` with `map`, lit from the image-up (`fromUp`) or image-down side; returns image-up's world y sign. */
  async render(kind: MeshCase | 'gltf' | 'gltf-tangents', map: keyof typeof maps, fromUp: boolean) {
    current?.dispose();
    const bitmap = await maps[map](),
      up = kind === 'mesh-uv1' ? -1 : 1;
    current = kind === 'gltf' || kind === 'gltf-tangents' ? gltf(bitmap, kind === 'gltf-tangents') : mesh(bitmap, kind);
    engine.lighting.direction.set([0, 0.6 * up * (fromUp ? 1 : -1), 0.8, 2.5]);
    engine.lighting.radiance.set([1, 1, 1, 0]);
    const device = engine.gpu!;
    device.pushErrorScope('validation');
    engine.render();
    await device.queue.onSubmittedWorkDone();
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
    if (errors.length) throw new Error(errors.join('\n'));
    return up;
  },
  dispose() {
    current?.dispose();
    engine.dispose();
  },
};
