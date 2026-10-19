import { Engine } from '../packages/core/dist/extension.js';
import {
  Material,
  Texture,
  clearcoat,
  createMesh,
  installNodeMaterial,
  materialLobes,
} from '../packages/materials/dist/index.js';
import type { MeshGeometry } from '../packages/materials/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { MaterialExtension, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { planeGeometry, computeTangents } from '../packages/geometry/dist/index.js';

// Which way a normal map's +Y (green) bends the surface, on the GPU. A normal map's +Y is up the image (glTF 2.0
// material.schema.json normalTexture: "+X is right and +Y is up. +Z points toward the viewer"). Where image-up lands
// depends on the UV convention: glTF puts texture (0, 0) at the image's upper-left corner (spec, "Textures"), so up is
// decreasing v; materials meshes use three.js orientation with flipY image uploads, so up is increasing v. Every case
// below places image-up at world +y (`up` 1) or, for the mirrored UV1 set, world -y (`up` -1).
// Kinds by lobe: base normal maps light a white diffuse surface; `*-coat` kinds tilt only a clearcoat over a black
// base (its highlight reads the tilt); `*-aniso` kinds stretch a metal highlight along anisotropyRotation pi/4, image
// right-up (KHR_materials_anisotropy: counter-clockwise from the tangent, toward the bitangent, up the image).

const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  device = engine.gpu!,
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
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

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

/** A caller-owned view for the extension helpers, uploaded as each convention expects (materials: flipY). */
function view(bitmap: ImageBitmap, flipY: boolean) {
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bitmap, flipY }, { texture }, [bitmap.width, bitmap.height]);
  return { texture, info: { view: texture.createView(), sampler: device.createSampler({ magFilter: 'linear' }) } };
}

type Lobe = 'normal' | 'coat' | 'aniso';
/** The extension a `*-coat`, `*-node` or `*-aniso` kind attaches, with the normal map as a caller-owned view. */
function extensionFor(kind: string, bitmap: ImageBitmap, flipY: boolean, model: PBRModel) {
  const { texture, info } = view(bitmap, flipY);
  if (kind.endsWith('-node')) {
    const sampled = { type: 'texture', texture: info } as const,
      emit = {
        type: 'emit',
        color: { type: 'color', value: [1, 1, 1, 1] },
        normal: { type: 'normalMap', texture: sampled },
      } as const;
    const installation = installNodeMaterial(model, { nodes: [emit] });
    return () => {
      installation.dispose();
      texture.destroy();
    };
  }
  const extension: MaterialExtension = kind.endsWith('-coat')
    ? clearcoat({ factor: 1, roughnessFactor: 0.5, clearcoatNormalTexture: info })
    : materialLobes({ anisotropy: { strength: 1, rotation: Math.PI / 4 } });
  model.primitives[0].extension = extension;
  return () => texture.destroy();
}
const lobeOf = (kind: string): Lobe => (kind.endsWith('-coat') ? 'coat' : kind.endsWith('-aniso') ? 'aniso' : 'normal');
// Base colour, metalness and roughness each lobe reads best on.
const surfaces: Record<Lobe, { color: [number, number, number]; metalness: number; roughness: number }> = {
  normal: { color: [1, 1, 1], metalness: 0, roughness: 1 },
  coat: { color: [0, 0, 0], metalness: 0, roughness: 1 },
  aniso: { color: [1, 1, 1], metalness: 1, roughness: 0.2 },
};

function gltf(bitmap: ImageBitmap, kind: string) {
  const tangents = kind === 'gltf-tangents',
    extended = kind !== 'gltf' && !tangents,
    surface = surfaces[lobeOf(kind)];
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
    ...(extended ? {} : { images: [{}], textures: [{ source: 0 }] }),
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [...surface.color, 1],
          metallicFactor: surface.metalness,
          roughnessFactor: surface.roughness,
        },
        ...(extended ? {} : { normalTexture: { index: 0 } }),
      },
    ],
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
  const model = parseGLTF(engine, doc, buffers, extended ? [] : [bitmap]),
    release = extended ? extensionFor(kind, bitmap, false, model) : () => {};
  return {
    dispose() {
      release();
      model.dispose();
    },
  };
}

function mesh(bitmap: ImageBitmap, kind: string) {
  const plane = planeGeometry(3, 2);
  let geometry: MeshGeometry = kind === 'mesh-tangents' ? computeTangents(plane) : plane;
  if (kind === 'mesh-uv1')
    // The UV groups check's mirrored set: UV1 runs down the quad, so image-up is world -y; UV0 tangents do not apply.
    geometry = {
      positions: [-1.5, -1, 0, 1.5, -1, 0, 1.5, 1, 0, -1.5, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      uvs1: [0, 1, 1, 1, 1, 0, 0, 0],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
  // `mesh` .. `mesh-uv1` and the `-option` kinds set the map through Material options, the rest through an extension.
  const option = !/-(coat|node|aniso)$/.test(kind) || kind.includes('-option'),
    texture = new Texture(bitmap),
    lobe = lobeOf(kind),
    maps =
      !option || kind.includes('-aniso')
        ? {}
        : lobe === 'coat'
          ? { clearcoat: 1, clearcoatRoughness: 0.5, clearcoatNormalMap: texture }
          : { normalMap: texture },
    material = new Material({
      ...surfaces[lobe],
      ...maps,
      ...(option && lobe === 'aniso' ? { anisotropy: 1, anisotropyRotation: Math.PI / 4 } : {}),
    });
  if (kind === 'mesh-uv1') material.setUVTransform({ texCoord: 1 }, 'normalMap');
  const model = createMesh(engine, geometry, material),
    release = option ? () => {} : extensionFor(kind, bitmap, true, model);
  return {
    dispose() {
      release();
      model.dispose();
      texture.dispose();
    },
  };
}

let current: { dispose(): void } | undefined;
(window as any).normalOrientation = {
  errors,
  /**
   * Draws `kind` with `map`, lit from the image-up (`fromUp`) or image-down side (anisotropy: along or across its
   * image right-up axis); returns image-up's world y sign.
   */
  async render(kind: string, map: keyof typeof maps, fromUp: boolean) {
    current?.dispose();
    const bitmap = await maps[map](),
      up = kind === 'mesh-uv1' ? -1 : 1,
      side = fromUp ? 1 : -1,
      lobe = lobeOf(kind);
    current = kind.startsWith('gltf') ? gltf(bitmap, kind) : mesh(bitmap, kind);
    engine.lighting.direction.set(
      lobe === 'coat'
        ? [0, 0.8 * side, 0.6, 12]
        : lobe === 'aniso'
          ? [0.5 * side, 0.5, 0.7, 1]
          : [0, 0.6 * up * side, 0.8, 2.5],
    );
    engine.lighting.radiance.set([1, 1, 1, 0]);
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
