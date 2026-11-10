// @margoengine/lightmap/apply: draws a baked lightmap at draw time on materials meshes, loaded glTF-pro models and
// core meshes. The light it adds is the one `Material.lightMap` adds (packages/materials features.ts): the diffuse
// reflectance base * (1 - metalness), times occlusion, times the baked value, as indirect light. For physical
// irradiance E the Lambertian BRDF rho / pi turns it into outgoing radiance rho * E / pi (Pharr, Jakob and Humphreys,
// "Physically Based Rendering", 4th ed., 2023, section 9.2 "Diffuse Reflection"); the diffuse reflectance of a
// metallic-roughness surface is base * (1 - metalness) (Khronos glTF 2.0 specification, Appendix B, 2021).
import type { EngineKernel, Mesh as CoreMesh } from '@margoengine/core';
import type { MaterialExtension, PBRMaterial, PBRModel, PBRPrimitive } from '@margoengine/gltf-pro/model';
import { type MaterialMesh, Material, PbrMaterial, Texture, createMesh } from '@margoengine/materials';
import { MargoError } from '@margoengine/math/errors';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** A CPU bake: `bakeLightmap`'s atlas (`textures.lightmap`) or `bakeMeshLightmap`'s record (`lightmap`). */
export interface BakedLightmap {
  width: number;
  height: number;
  /** RGBA8 baked light divided by `lightmapScale` (a `bakeMeshLightmap` result). */
  lightmap?: Uint8Array;
  /** The atlas textures (a `bakeLightmap` or `bakeGlobalLightmap` result); `lightmap` is read. */
  textures?: { lightmap: Uint8Array };
  /** Multiply the RGB (0 to 1) by this to get the baked light. */
  lightmapScale: number;
  /** 'physical' irradiance is drawn with the Lambertian response (divided by pi). */
  radiometry?: 'physical';
}

/** A live GPU bake: a `GPULightmapBaker` (`@margoengine/lightmap/gpu`), drawn as it improves. */
export interface LiveLightmap {
  readonly device: GPUDevice;
  /** The running mean, rgba16float, unscaled. */
  readonly texture: GPUTexture;
  readonly radiometry?: 'physical';
}

/** Options of {@link applyLightmap}. */
export interface ApplyLightmapOptions {
  /** Multiplies the bake's own scale, 0 or more. Default 1. */
  intensity?: number;
  /**
   * 'lambertian' divides by pi (physical irradiance); 'multiply' uses the value as it is. Default 'lambertian' for a
   * bake with `radiometry: 'physical'`, else 'multiply'.
   */
  response?: 'multiply' | 'lambertian';
  /** A core mesh's lightmap UV per vertex (2 floats each, origin top-left); core geometry holds none. Core meshes only. */
  uv1?: ArrayLike<number>;
  /** A glTF-pro model's primitives to light, as indices into `model.primitives` or the primitives. Default all. */
  primitives?: readonly (number | PBRPrimitive)[];
}

/** What {@link applyLightmap} returns: the lightmap as it is drawn, live until `dispose()` takes it off again. */
export interface LightmapApplication {
  /** The texture drawn: a linear `Texture` of the bake (or of the GPU baker's live texture). */
  readonly texture: Texture;
  /** The scale applied to the texture's RGB, response included (pi divided out for 'lambertian'). */
  readonly scale: number;
  /** A core mesh's stand-in: the materials mesh that draws it with the lightmap (core meshes only). */
  readonly mesh?: MaterialMesh;
  /** Takes the lightmap off: materials get their previous lightMap back, a core mesh its own geometry. Repeatable. */
  dispose(): void;
  [Symbol.dispose](): void;
}

type Target = Material | MaterialMesh<Material | readonly Material[]> | PBRModel | CoreMesh;

const bad = (message: string): never => {
  throw new TypeError(message);
};

/**
 * A linear `Texture` of a bake, ready for `Material.lightMap`, with the `lightMapIntensity` that decodes it: RGBA8
 * for a CPU bake (`bakeLightmap`, `bakeGlobalLightmap`, `bakeMeshLightmap`), the live rgba16float texture of a
 * `GPULightmapBaker`. No mipmaps, so a minified chart never averages in its neighbours.
 */
export function lightmapTexture(baked: BakedLightmap | LiveLightmap): { texture: Texture; intensity: number } {
  if (isLive(baked)) return { texture: new Texture(baked.texture, { mipmaps: false }), intensity: 1 };
  const { width, height, data, scale } = cpuBake(baked);
  return { texture: new Texture({ width, height, data }, { colorSpace: 'linear', mipmaps: false }), intensity: scale };
}

/**
 * Draws a baked lightmap on `target` from the next frame on, read on the mesh's second UV set (UV1, glTF TEXCOORD_1):
 *
 * - a materials `Material` (or every material of a `createMesh` mesh): sets its `lightMap`, `lightMapIntensity` and
 *   `lightMapResponse`;
 * - a loaded glTF-pro `PBRModel`: each chosen primitive draws a copy of its material record that adds the light, as
 *   `Material.lightMap` does; the copy shares the record's colours, factors and maps, so live edits still show;
 * - a core `Mesh` (no UV1 or lightmap in core's shader): a materials mesh with the core mesh's geometry and material
 *   values, `options.uv1` and the lightmap, parented to the core mesh, draws in its place; the core mesh keeps its
 *   transform, children and name and draws nothing until `dispose()`.
 *
 * The light is added to the live lighting (diffuse reflectance times occlusion times the bake), so turn off live
 * terms that the bake already holds. `dispose()` restores what was there.
 */
export function applyLightmap(
  target: Target,
  baked: BakedLightmap | LiveLightmap,
  options: ApplyLightmapOptions = {},
): LightmapApplication {
  const { intensity = 1, response = baked?.radiometry === 'physical' ? 'lambertian' : 'multiply' } = options ?? {};
  if (typeof intensity !== 'number' || !(intensity >= 0) || !Number.isFinite(intensity))
    throw new RangeError('applyLightmap intensity must be a finite number 0 or more; pass a nonnegative scale');
  if (response !== 'multiply' && response !== 'lambertian')
    throw new TypeError("applyLightmap response must be 'multiply' or 'lambertian'; pass one of those");
  if (!target || typeof target !== 'object')
    bad('applyLightmap needs a Material, a materials or glTF-pro mesh or a core Mesh; pass one of those');
  if (target instanceof Material) return onMaterials([target], baked, intensity, response);
  if (isMaterialMesh(target)) {
    const m = target.material;
    return onMaterials(
      Array.isArray(m) ? [...new Set(m as readonly Material[])] : [m as Material],
      baked,
      intensity,
      response,
    );
  }
  if (isModel(target)) return onModel(target, baked, intensity, response, options.primitives);
  if (isCore(target)) return onCore(target, baked, intensity, response, options.uv1);
  return bad('applyLightmap needs a Material, a materials or glTF-pro mesh or a core Mesh; pass one of those');
}

const isLive = (b: unknown): b is LiveLightmap =>
  !!b && typeof b === 'object' && 'texture' in b && 'device' in b && !('textures' in b);

function cpuBake(b: BakedLightmap): { width: number; height: number; data: Uint8Array; scale: number } {
  const data = b?.textures?.lightmap ?? b?.lightmap,
    { width, height, lightmapScale } = b ?? ({} as BakedLightmap);
  if (
    !(data instanceof Uint8Array) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4 ||
    !(lightmapScale > 0) ||
    !Number.isFinite(lightmapScale)
  )
    bad(
      'applyLightmap needs a bake: the result of bakeLightmap, bakeGlobalLightmap, bakeMeshLightmap or a GPULightmapBaker',
    );
  return { width, height, data: data as Uint8Array, scale: lightmapScale };
}

const isMaterialMesh = (t: object): t is MaterialMesh<Material | readonly Material[]> =>
  'primitives' in t && 'material' in t && (t.material instanceof Material || Array.isArray(t.material));
const isModel = (t: object): t is PBRModel => 'primitives' in t && Array.isArray(t.primitives) && 'root' in t;
// A core mesh as `engine.createMesh()` makes it: the public Mesh type does not name its engine, the object holds it.
type CoreMeshOf = CoreMesh & { readonly engine: EngineKernel };
const isCore = (t: object): t is CoreMeshOf =>
  'setGeometry' in t && 'engine' in t && (t as unknown as CoreMesh).material?.data instanceof Float32Array;

function application(texture: Texture, scale: number, off: () => void, mesh?: MaterialMesh): LightmapApplication {
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    off();
    // The texture is this application's own: free its GPU copy (a GPU baker's borrowed texture stays the baker's).
    texture.dispose();
  };
  return { texture, scale, ...(mesh ? { mesh } : {}), dispose, [Symbol.dispose]: dispose };
}

/** One application's lightmap on one material, and what the material held before it. */
interface Layer {
  readonly texture: Texture;
  before: readonly [Material['lightMap'], number, Material['lightMapResponse']];
}
/** Live applications per material, oldest first, so they can be disposed in any order. */
const layers = new WeakMap<Material, Layer[]>();

function onMaterials(
  materials: readonly Material[],
  baked: BakedLightmap | LiveLightmap,
  intensity: number,
  response: 'multiply' | 'lambertian',
): LightmapApplication {
  // Check every material first (the response setter refuses unlit shading), so a refusal leaves all unchanged.
  for (const m of materials)
    if (response === 'lambertian' && !['standard', 'lambert', 'phong'].includes(m.shading))
      bad(
        `applyLightmap 'lambertian' needs lit shading, not '${m.shading}'; use standard, lambert or phong, or 'multiply'`,
      );
  const { texture, intensity: own } = lightmapTexture(baked),
    value = own * intensity,
    mine = materials.map(
      (m): Layer => ({ texture, before: [m.lightMap, m.lightMapIntensity, m.lightMapResponse] as const }),
    );
  materials.forEach((m, i) => {
    m.lightMapResponse = 'multiply';
    m.lightMapIntensity = value;
    m.lightMapResponse = response;
    m.lightMap = texture;
    let stack = layers.get(m);
    if (!stack) layers.set(m, (stack = []));
    stack.push(mine[i]);
  });
  return application(texture, response === 'lambertian' ? value / Math.PI : value, () =>
    materials.forEach((m, i) => {
      const stack = layers.get(m)!,
        layer = mine[i],
        at = stack.indexOf(layer);
      if (at < 0) return;
      stack.splice(at, 1);
      // A later application is still on: it restores what this one found, so this one's lightmap never returns.
      if (at < stack.length) {
        stack[at].before = layer.before;
        return;
      }
      if (m.lightMap !== texture) return;
      const [map, previous, kind] = layer.before;
      m.lightMap = map;
      m.lightMapResponse = 'multiply';
      m.lightMapIntensity = previous;
      m.lightMapResponse = kind;
    }),
  );
}

// The light Material.lightMap adds (features.ts), here from the extension's texture 0 on UV1 (i.uv.zw in both glTF-pro
// shaders) and its factor row 0 (x: the scale).
const lightWGSL =
  's.emissive+=s.base.rgb*(1-s.metal)*s.occlusion*textureSample(materialTexture0,materialSampler0,i.uv.zw).rgb*materialFactors[0].x;';

function onModel(
  model: PBRModel,
  baked: BakedLightmap | LiveLightmap,
  intensity: number,
  response: 'multiply' | 'lambertian',
  which?: readonly (number | PBRPrimitive)[],
): LightmapApplication {
  if (model.disposed) throw new MargoError('disposed', 'applyLightmap got a disposed model; pass a live PBRModel');
  const device = model.root.engine.gpu;
  if (!device)
    throw new MargoError('unsupported', 'applyLightmap on a glTF-pro model needs WebGPU; use a WebGPU engine');
  const chosen = (which ?? model.primitives).map((p) => {
    const primitive = typeof p === 'number' ? model.primitives[p] : p;
    if (!primitive || !model.primitives.includes(primitive))
      throw new RangeError(
        `applyLightmap primitive ${String(p)} is not one of the model's; pass indices into model.primitives`,
      );
    if (primitive.material.extension)
      bad(
        'applyLightmap cannot add to a glTF-pro material that already has a material extension (clearcoat, a custom one); light that model with Material.lightMap on a createMesh mesh',
      );
    return primitive;
  });
  const { texture, intensity: own } = lightmapTexture(baked),
    scale = (own * intensity) / (response === 'lambertian' ? Math.PI : 1);
  let gpu: GPUTexture | undefined;
  const view = isLive(baked)
    ? sameDevice(baked, device).texture.createView()
    : (gpu = upload(device, cpuBake(baked as BakedLightmap))).createView();
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const extension: MaterialExtension = {
    wgsl: lightWGSL,
    factors: new Float32Array([scale, 0, 0, 0]),
    textures: [{ view, sampler }],
  };
  const copies = new Map<PBRMaterial, PBRMaterial>(),
    restore = new Map<PBRPrimitive, [PBRMaterial, PBRMaterial]>();
  for (const primitive of new Set(chosen)) {
    const original = primitive.material;
    let copy = copies.get(original);
    if (!copy) copies.set(original, (copy = { ...original, extension }));
    restore.set(primitive, [original, copy]);
    primitive.material = copy;
  }
  let unsubscribe: (() => void) | undefined;
  const off = () => {
    unsubscribe?.();
    for (const [primitive, [original, copy]] of restore) if (primitive.material === copy) primitive.material = original;
    restore.clear();
    gpu?.destroy();
  };
  const app = application(texture, scale, off);
  unsubscribe = model.onDispose(() => app.dispose());
  return app;
}

function sameDevice(live: LiveLightmap, device: GPUDevice): LiveLightmap {
  if (live.device !== device)
    throw new MargoError(
      'unsupported',
      "applyLightmap got a GPULightmapBaker on another GPUDevice; create the baker with the engine's device (engine.gpu)",
    );
  return live;
}

function upload(device: GPUDevice, { width, height, data }: { width: number; height: number; data: Uint8Array }) {
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
  return texture;
}

function onCore(
  mesh: CoreMeshOf,
  baked: BakedLightmap | LiveLightmap,
  intensity: number,
  response: 'multiply' | 'lambertian',
  uv1?: ArrayLike<number>,
): LightmapApplication {
  mesh.check();
  const geometry = mesh.geometry;
  if (!geometry || !geometry.indices.length)
    bad('applyLightmap needs a core mesh with geometry; set its geometry first');
  const { vertices, indices } = geometry!,
    count = vertices.length / 6;
  if (!uv1 || typeof uv1 !== 'object' || uv1.length !== count * 2)
    bad(
      `applyLightmap on a core mesh needs options.uv1 with 2 floats per vertex (${count * 2}); pass the lightmap UVs`,
    );
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = vertices[i * 6 + a];
      normals[i * 3 + a] = vertices[i * 6 + 3 + a];
    }
  const d = mesh.material.data,
    material = new PbrMaterial({
      color: [d[0], d[1], d[2]],
      roughness: d[4],
      metalness: d[5],
      doubleSided: d[6] > 0,
    });
  const stand = createMesh(mesh.engine, { positions, normals, indices, uvs1: uv1 }, material),
    lit = onMaterials([material], baked, intensity, response);
  // The materials mesh's root is core's Mesh class; the public Mesh type is its interface.
  try {
    stand.root.setParent(mesh as unknown as Parameters<typeof stand.root.setParent>[0]);
  } catch (error) {
    // A core mesh in another scene than the stand-in's: leave everything as it was.
    lit.dispose();
    stand.destroy();
    throw error;
  }
  mesh.setGeometry(null);
  return application(
    lit.texture,
    lit.scale,
    () => {
      lit.dispose();
      stand.destroy();
      if (alive(mesh) && mesh.geometry === null) mesh.setGeometry(geometry);
    },
    stand,
  );
}

/** Whether a core mesh (and its engine) is still live: `check()` throws once either is disposed. */
function alive(mesh: CoreMesh): boolean {
  try {
    mesh.check();
    return true;
  } catch {
    return false;
  }
}
