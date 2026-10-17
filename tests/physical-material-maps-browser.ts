// This page imports built packages deliberately: the GPU check also verifies the published module boundary.
import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh } from '../packages/materials/dist/index.js';
import type {
  MaterialOptions,
  MapSlot,
  MaterialMesh,
  MeshGeometry,
  RawImage,
} from '../packages/materials/dist/index.js';
import { Transmission } from '../packages/materials/dist/transmission.js';
import { PostStack } from '../packages/post/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';

type Options = MaterialOptions;
type MapCase = { slot: MapSlot; base: Options; a: number[]; b: number[]; factor: (rgba: number[]) => Options };
type Model = MaterialMesh<Material | readonly Material[]>;
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [],
  textures: Texture[] = [],
  models: Model[] = [];

// Exactly 80 backing pixels per world unit; sample positions stay stable on all physical adapters.
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.lighting.direction.set([0.6, 0.3, 1, 2]);
engine.lighting.radiance[3] = 0.15;
engine.onError = (error) => errors.push(String(error));
let observed: GPUDevice | undefined;
function observe() {
  const device = engine.gpu!;
  if (device !== observed) {
    observed = device;
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  }
  return device;
}
observe();

function texture(data: number[], width = data.length / 4) {
  const result = new Texture(
    { data: new Uint8Array(data), width, height: 1 },
    {
      minFilter: 'nearest',
      magFilter: 'nearest',
      mipmaps: false,
      wrapS: 'clamp',
      wrapT: 'clamp',
    },
  );
  textures.push(result);
  return result;
}
function quad(left = -1.5, right = 1.5, bottom = -1, top = 1, normal = [0, 0, 1]): MeshGeometry {
  const v = 0.05 + (0.4 * (top - bottom)) / (right - left);
  return {
    positions: [left, bottom, 0, right, bottom, 0, right, top, 0, left, top, 0],
    normals: [...normal, ...normal, ...normal, ...normal],
    // Both channels have gradients, but stay inside separate nearest-filtered texels.
    uvs: [0.05, 0.05, 0.45, 0.05, 0.45, v, 0.05, v],
    uvs1: [0.55, 0.05, 0.95, 0.05, 0.95, v, 0.55, v],
    tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
function split(halfWidth = 1.5, halfHeight = 1): MeshGeometry {
  const a = quad(-halfWidth, 0, -halfHeight, halfHeight),
    b = quad(0, halfWidth, -halfHeight, halfHeight);
  return {
    positions: [...Array.from(a.positions), ...Array.from(b.positions)],
    normals: [...Array.from(a.normals), ...Array.from(b.normals)],
    uvs: [...Array.from(a.uvs!), ...Array.from(b.uvs!)],
    uvs1: [...Array.from(a.uvs1!), ...Array.from(b.uvs1!)],
    tangents: [...Array.from(a.tangents!), ...Array.from(b.tangents!)],
    indices: [...Array.from(a.indices!), ...Array.from(b.indices!, (i) => i + 4)],
    groups: [
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 6, materialIndex: 0 },
    ],
  };
}
let transmission: Transmission | undefined, stack: PostStack | undefined;
function add<T extends Model>(model: T): T {
  models.push(model);
  return model;
}
function clear() {
  for (const model of models.splice(0)) model.dispose();
  if (transmission) engine.removePlugin(transmission.name);
  if (stack) engine.removePlugin(stack.name);
  transmission = undefined;
  stack = undefined;
  engine.lighting.direction.set([0.6, 0.3, 1, 2]);
}
async function frame() {
  const device = observe();
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
function background() {
  add(
    createMesh(engine, quad(-2, 2, -1.5, 1.5), new Material({ shading: 'basic', color: [0.7, 0.5, 0.3] })),
  ).root.setPosition([0, 0, -0.5]);
}
function hdr(model: Model) {
  stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
  transmission = Transmission.attach(engine);
  transmission.add(model);
}
const srgb = (byte: number) => {
  const x = byte / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const common = { color: [0.25, 0.3, 0.35], roughness: 0.45 },
  rgbaA = [64, 85, 150, 102],
  rgbaB = [192, 204, 70, 217],
  colorA = [128, 64, 192, 51],
  colorB = [230, 170, 60, 204];
// Scalar references apply Khronos channel rules independently of Material's texture implementation.
const cases: Record<string, MapCase> = {
  clearcoatMap: {
    slot: 'clearcoatMap',
    base: { ...common, clearcoat: 0.9, clearcoatRoughness: 0.2 },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ clearcoat: (0.9 * v[0]) / 255 }),
  },
  clearcoatRoughnessMap: {
    slot: 'clearcoatRoughnessMap',
    base: { ...common, clearcoat: 1, clearcoatRoughness: 0.9 },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ clearcoatRoughness: (0.9 * v[1]) / 255 }),
  },
  sheenColorMap: {
    slot: 'sheenColorMap',
    base: { ...common, sheenColor: [0.8, 0.6, 0.7], sheenRoughness: 0.55 },
    a: colorA,
    b: colorB,
    factor: (v) => ({ sheenColor: [0.8 * srgb(v[0]), 0.6 * srgb(v[1]), 0.7 * srgb(v[2])] }),
  },
  sheenRoughnessMap: {
    slot: 'sheenRoughnessMap',
    base: { ...common, sheenColor: [0.8, 0.2, 0.6], sheenRoughness: 0.95 },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ sheenRoughness: (0.95 * v[3]) / 255 }),
  },
  specularIntensityMap: {
    slot: 'specularIntensityMap',
    base: { ...common, roughness: 0.25, specularIntensity: 0.9 },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ specularIntensity: (0.9 * v[3]) / 255 }),
  },
  specularColorMap: {
    slot: 'specularColorMap',
    base: { ...common, roughness: 0.25, specularColor: [0.8, 0.6, 0.7] },
    a: colorA,
    b: colorB,
    factor: (v) => ({ specularColor: [0.8 * srgb(v[0]), 0.6 * srgb(v[1]), 0.7 * srgb(v[2])] }),
  },
  transmissionMap: {
    slot: 'transmissionMap',
    base: { ...common, color: [0.8, 0.9, 1], transmission: 0.9 },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ transmission: (0.9 * v[0]) / 255 }),
  },
  thicknessMap: {
    slot: 'thicknessMap',
    base: {
      ...common,
      color: [0.8, 0.9, 1],
      transmission: 0.9,
      thickness: 1.8,
      attenuationColor: [0.2, 0.6, 0.85],
      attenuationDistance: 0.8,
    },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ thickness: (1.8 * v[1]) / 255 }),
  },
  anisotropyMap: {
    slot: 'anisotropyMap',
    base: {
      ...common,
      color: [0.7, 0.5, 0.3],
      metalness: 0.8,
      roughness: 0.3,
      anisotropy: 0.9,
      anisotropyRotation: 0.2,
    },
    a: [255, 128, 85, 19],
    b: [128, 255, 217, 240],
    factor: (v) => ({
      anisotropy: (0.9 * v[2]) / 255,
      anisotropyRotation: 0.2 + Math.atan2((v[1] / 255) * 2 - 1, (v[0] / 255) * 2 - 1),
    }),
  },
  iridescenceMap: {
    slot: 'iridescenceMap',
    base: {
      ...common,
      roughness: 0.25,
      metalness: 0.6,
      iridescence: 0.9,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 350],
    },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ iridescence: (0.9 * v[0]) / 255 }),
  },
  iridescenceThicknessMap: {
    slot: 'iridescenceThicknessMap',
    base: {
      ...common,
      roughness: 0.25,
      metalness: 0.6,
      iridescence: 1,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 500],
    },
    a: rgbaA,
    b: rgbaB,
    factor: (v) => ({ iridescenceThicknessRange: [100 + (400 * v[1]) / 255, 100 + (400 * v[1]) / 255] }),
  },
};
const caseTextures = Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, texture([...c.a, ...c.b])])),
  allSlots: readonly MapSlot[] = [
    'clearcoatMap',
    'clearcoatRoughnessMap',
    'clearcoatNormalMap',
    'sheenColorMap',
    'sheenRoughnessMap',
    'specularIntensityMap',
    'specularColorMap',
    'transmissionMap',
    'thicknessMap',
    'anisotropyMap',
    'iridescenceMap',
    'iridescenceThicknessMap',
  ],
  full: Options = {
    ...common,
    clearcoat: 0.8,
    clearcoatRoughness: 0.4,
    clearcoatNormalScale: 0.6,
    sheenColor: [0.4, 0.3, 0.2],
    sheenRoughness: 0.6,
    specularIntensity: 0.8,
    specularColor: [0.8, 0.9, 1],
    transmission: 0.5,
    thickness: 0.4,
    attenuationColor: [0.3, 0.6, 0.8],
    attenuationDistance: 1,
    anisotropy: 0.7,
    anisotropyRotation: 0.2,
    iridescence: 0.6,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
  },
  shared = texture([200, 150, 180, 160]),
  normalTex = texture([128, 208, 240, 9, 208, 128, 240, 230]),
  diagonalAniso = texture([218, 218, 255, 1]);
let current: Model | undefined, live: Material | undefined;
const identity = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
function material(o: Options) {
  return new Material(o);
}
function uv(m: Material, slot: MapSlot, mode: string) {
  m.setUVTransform(
    mode === 'transform' ? { texCoord: 1, offset: [-0.5, 0] } : { texCoord: mode === 'map0' ? 0 : 1 },
    slot,
  );
}

const physicalMaps = {
  engine,
  errors,
  names: Object.keys(cases),
  async baseline(physical: boolean) {
    clear();
    current = add(createMesh(engine, quad(), material({ ...common, ...(physical ? { clearcoat: 0 } : {}) })));
    await frame();
  },
  async render(name: string, variant: string, withHDR = false) {
    clear();
    const c = cases[name],
      reference = variant === 'a' || variant === 'b',
      o = { ...c.base, ...(reference ? c.factor(variant === 'a' ? c.a : c.b) : {}) },
      m = material(o),
      g = quad();
    if (variant.startsWith('map') || variant === 'transform' || variant === 'fallback') {
      m[c.slot] = caseTextures[name]; // Assignment after construction must update the shader and bindings.
      uv(m, c.slot, variant);
      if (variant === 'fallback') delete g.uvs1;
    }
    if (o.transmission !== undefined) background();
    current = add(createMesh(engine, g, m));
    if (withHDR) hdr(current);
    await frame();
  },
  async coatNormal(variant: string) {
    clear();
    const o: Options = { color: [0, 0, 0], specularIntensity: 0, clearcoat: 1, clearcoatRoughness: 0.45 },
      g = quad(),
      m = material({ ...o, clearcoatNormalScale: variant === 'zero' ? 0 : 1 });
    // Reference normal comes directly from linear RGBA8 normal decoding, independently of the map shader.
    if (variant === 'a' || variant === 'b' || variant === 'mirrorReference') {
      const bytes = variant === 'b' ? [208, 128, 240] : [128, 208, 240],
        n = bytes.map((v) => (v / 255) * 2 - 1);
      if (variant === 'mirrorReference') n[1] *= -1;
      g.normals = [...n, ...n, ...n, ...n];
    } else if (variant !== 'base') {
      m.clearcoatNormalMap = normalTex;
      uv(m, 'clearcoatNormalMap', variant === 'zero' ? 'map0' : variant);
      if (variant === 'fallback') delete g.uvs1;
      if (variant === 'mirror') {
        g.uvs1 = [0.05, 19 / 60, 0.45, 19 / 60, 0.45, 0.05, 0.05, 0.05];
        m.setUVTransform({ texCoord: 1 }, 'clearcoatNormalMap');
      }
    }
    current = add(createMesh(engine, g, m));
    await frame();
  },
  async anisotropyMirror(variant: 'reference' | 'wrong' | 'map') {
    clear();
    const g = quad(),
      m = material({
        ...cases.anisotropyMap.base,
        anisotropy: 0.9,
        anisotropyRotation: variant === 'reference' ? -Math.PI / 4 : variant === 'wrong' ? Math.PI / 4 : 0,
      });
    if (variant === 'map') {
      m.anisotropyMap = diagonalAniso;
      g.uvs1 = [0.05, 19 / 60, 0.45, 19 / 60, 0.45, 0.05, 0.05, 0.05];
      m.setUVTransform({ texCoord: 1 }, 'anisotropyMap');
    }
    current = add(createMesh(engine, g, m));
    await frame();
  },
  async grouped(mapped: boolean, instanced: boolean) {
    clear();
    let sharedInstances = true;
    const a = cases.sheenColorMap,
      b = cases.specularIntensityMap,
      ma = material({ ...a.base, ...(mapped ? { sheenColorMap: caseTextures.sheenColorMap } : a.factor(a.b)) }),
      mb = material({
        ...b.base,
        ...(mapped ? { specularIntensityMap: caseTextures.specularIntensityMap } : b.factor(b.a)),
      });
    if (mapped) {
      uv(ma, a.slot, 'map1');
      uv(mb, b.slot, 'map0');
    }
    if (instanced) {
      const model = add(createInstancedMesh(engine, split(0.5, 0.4), [ma, mb], 2));
      model.instances.setMatrixAt(0, identity(-1));
      model.instances.setMatrixAt(1, identity(1));
      sharedInstances = model.primitives.every((p) => p.instances === model.instances);
      current = model;
    } else current = add(createMesh(engine, split(), [ma, mb]));
    await frame();
    return {
      primitives: current.primitives.length,
      sharedInstances,
    };
  },
  async restore() {
    const old = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { changedDevice: old !== engine.gpu };
  },
  async commonLive(mode: 'base' | 'assign' | 'remove' | 'reference') {
    if (mode === 'base' || mode === 'reference') {
      clear();
      // No advanced scalar options: the initial draw uses gltf-pro's native group-1 layout.
      live = material({ ...common, clearcoat: mode === 'base' ? 1 : cases.clearcoatMap.b[0] / 255 });
      current = add(createMesh(engine, quad(), live));
    } else if (mode === 'assign') {
      live!.clearcoatMap = caseTextures.clearcoatMap;
      live!.setUVTransform({ texCoord: 1 }, 'clearcoatMap');
    } else live!.clearcoatMap = null;
    // Put the narrow default-roughness clearcoat highlight inside the captured quad.
    engine.lighting.direction.set([0.3, 0.1, 1, 2]);
    await frame();
  },
  async authoredAnisotropy(mode: 'base' | 'assign' | 'remove' | 'reference' | 'mapReference') {
    if (mode === 'base' || mode === 'reference' || mode === 'mapReference') {
      clear();
      const g = quad();
      if (mode === 'base') g.tangents = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
      live = material({
        ...cases.anisotropyMap.base,
        anisotropy: 0.9,
        anisotropyRotation: mode === 'reference' ? Math.PI / 2 : mode === 'mapReference' ? Math.PI / 4 : 0,
      });
      current = add(createMesh(engine, g, live));
    } else live!.anisotropyMap = mode === 'assign' ? diagonalAniso : null;
    await frame();
  },
  async live(mode: string) {
    if (mode === 'base') {
      clear();
      background();
      live = material(full);
      const model = add(createInstancedMesh(engine, split(0.5, 0.4), [live, live], 2));
      model.instances.setMatrixAt(0, identity(-1));
      model.instances.setMatrixAt(1, identity(1));
      current = model;
    }
    if (mode === 'assign' || mode === 'remove')
      for (const slot of allSlots) live![slot] = mode === 'assign' ? shared : null;
    if (mode === 'update' || mode === 'reset') {
      (shared.source as RawImage).data.set(mode === 'update' ? [150, 200, 220, 210] : [200, 150, 180, 160]);
      shared.update();
    }
    await frame();
  },
  async liveReference(updated: boolean) {
    clear();
    background();
    const t = texture(updated ? [150, 200, 220, 210] : [200, 150, 180, 160]),
      m = material({ ...full, ...Object.fromEntries(allSlots.map((slot) => [slot, t])) }),
      model = add(createInstancedMesh(engine, split(0.5, 0.4), [m, m], 2));
    model.instances.setMatrixAt(0, identity(-1));
    model.instances.setMatrixAt(1, identity(1));
    current = model;
    await frame();
  },
  async budget(overLimit: boolean) {
    clear();
    const slots = ['map', 'metalRoughnessMap', 'normalMap', 'aoMap', 'emissiveMap', ...allSlots],
      o = {
        ...full,
        ...Object.fromEntries(slots.map((slot) => [slot, overLimit ? texture([200, 150, 180, 160]) : shared])),
      };
    // An explicit deterministic failure must happen before a GPU validation error is emitted.
    const previous = engine.onError;
    engine.onError = (error) => {
      throw error;
    };
    try {
      background();
      current = add(createMesh(engine, quad(), material(o)));
      await frame();
      return { error: null };
    } catch (error) {
      return { error: String(error), errors: [...errors] };
    } finally {
      engine.onError = previous;
    }
  },
  dispose() {
    clear();
    for (const value of textures) value.dispose();
    engine.dispose();
  },
};
Object.assign(window, { physicalMaps });
