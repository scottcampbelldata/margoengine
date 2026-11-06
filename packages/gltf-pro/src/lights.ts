// EXT_lights_ies (Vendor extension, status Complete) and EXT_lights_image_based (Multi-Vendor), from their READMEs on
// KhronosGroup/glTF main as read on 2026-11-06. Both reach gltf-pro's loaders as plain data; this entry turns them into
// lights through @margoengine/clustered and @margoengine/environment, which it loads on first use.
import type { Clustered, PointLight } from '@margoengine/clustered';
import type { IESLights, IESProfile } from '@margoengine/clustered/ies';
import type { CubeFaces, Environment, EnvironmentBackground, EnvironmentLighting } from '@margoengine/environment';
import { decodePNG } from '@margoengine/decoders/png';
import { margoError } from '../../shared/errors.js';
import type { GLTFDocument } from '../../shared/gltf.js';
import type { PBRModel } from './index.js';

type Vec3 = [number, number, number];
type Quaternion = readonly [number, number, number, number];
/** Where a light's files come from. */
export interface GLTFLightFileOptions {
  /** Base of relative `uri`s; default where `loadGLTF` read the file from. */
  baseURL?: string | URL;
  /** Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
/** One node's EXT_lights_ies light. */
export interface GLTFIESLight {
  name: string;
  /** The profile, on the type C grid `parseIES` gives every file. */
  profile: IESProfile;
  /** Index of the node in the glTF file. */
  nodeIndex: number;
  /** Candela scale, default 1. */
  multiplier: number;
  /** Linear RGB tint, each channel from 0 to 1. */
  color: Vec3;
}
/** A scene's EXT_lights_image_based light. */
export interface GLTFImageLight {
  name: string;
  /** Brightness multiplier, default 1. */
  intensity: number;
  /** The rotation of the environment, as the file states it; `faces` have it applied. */
  rotation: Quaternion;
  /** Mip 0 of the specular cube in linear light, for `Environment.create`. */
  faces: CubeFaces;
  /** The file's nine SH rows of three, as data: the extension does not say how they are scaled (see the README). */
  irradianceCoefficients: readonly (readonly number[])[];
}
/** Options of `applyGLTFLightExtensions`. */
export interface GLTFLightExtensionOptions extends GLTFLightFileOptions {
  /** Clustered lights to use; default one attached here, which `dispose()` removes. */
  clustered?: Clustered;
  /** Scales every IES light's candela, as `applyGLTFLights` does. Default 1. */
  exposure?: number;
  /** Draw the image-based light's cube behind the scene. Default false. */
  background?: boolean;
  /** The scene whose image-based light to use; default the file's `scene`, else 0. */
  scene?: number;
}
/** What `applyGLTFLightExtensions` made. `dispose()` removes all of it. */
export interface GLTFLightExtensions {
  readonly iesLights: readonly GLTFIESLight[];
  readonly imageLight?: GLTFImageLight;
  readonly clustered?: Clustered;
  readonly ies?: IESLights;
  readonly environment?: Environment;
  readonly lighting?: EnvironmentLighting;
  readonly background?: EnvironmentBackground;
  dispose(): void;
  [Symbol.dispose](): void;
}

const invalid = (what: string) =>
  new TypeError(`Invalid glTF ${what}; the file is not valid, re-export it and check it with the glTF Validator`);
/** A module of an optional package, which a file with these lights needs. */
const peer = <T>(load: Promise<T>, name: string): Promise<T> =>
  load.catch((error) => {
    throw margoError(
      'unsupported',
      `glTF light extensions need ${name} (${error instanceof Error ? error.message : error}): install it to use @margoengine/gltf-pro/lights`,
    );
  });
/** The bytes of a `uri` (data, or relative to the file) or a `bufferView`. */
async function bytesOf(
  model: PBRModel,
  source: { uri?: string; bufferView?: number },
  { baseURL = model.asset.baseURL, fetch: get = globalThis.fetch, signal }: GLTFLightFileOptions,
): Promise<Uint8Array> {
  if (source.bufferView !== undefined) {
    const view = model.asset.doc.bufferViews?.[source.bufferView],
      buffer = view && model.asset.buffers[view.buffer];
    if (!view || !buffer) throw invalid('light bufferView');
    return buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  if (typeof source.uri !== 'string') throw invalid('light file: it needs a uri or a bufferView');
  if (!source.uri.startsWith('data:') && baseURL === undefined && !/^[a-z]+:/i.test(source.uri))
    throw margoError('state', `glTF light file ${source.uri} is relative and the model has no base URL; pass baseURL`);
  const response = await get(new URL(source.uri, baseURL), { signal });
  if (!response.ok)
    throw margoError('failed', `glTF light file ${source.uri} answered ${response.status}; check that it is there`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The EXT_lights_ies lights on the model's nodes, in node order. Their files are read once each; a type A profile
 * is refused by `parseIES`, as the extension allows. `applyGLTFLightExtensions` places them.
 */
export async function gltfIESLights(model: PBRModel, options: GLTFLightFileOptions = {}): Promise<GLTFIESLight[]> {
  const doc: GLTFDocument = model.asset.doc,
    defs = doc.extensions?.EXT_lights_ies?.lights,
    nodes = doc.nodes ?? [];
  if (!nodes.some((node) => node?.extensions?.EXT_lights_ies)) return [];
  if (!Array.isArray(defs)) throw invalid('EXT_lights_ies: it has no lights');
  const { parseIES } = await peer(import('@margoengine/clustered/ies'), '@margoengine/clustered'),
    profiles = new Map<number, Promise<IESProfile>>(),
    lights: GLTFIESLight[] = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const light = nodes[nodeIndex]?.extensions?.EXT_lights_ies;
    if (!light || !model.nodes[nodeIndex]) continue;
    const index = light.light;
    if (index === undefined) throw invalid('EXT_lights_ies light index');
    const def = defs[index],
      multiplier = light.multiplier ?? 1,
      color = light.color ?? [1, 1, 1];
    if (!def) throw invalid('EXT_lights_ies light index');
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0)
      throw invalid('EXT_lights_ies multiplier');
    if (!Array.isArray(color) || color.length !== 3 || color.some((c) => typeof c !== 'number' || !Number.isFinite(c)))
      throw invalid('EXT_lights_ies color');
    if (def.bufferView !== undefined && def.mimeType !== 'application/x-ies-lm-63')
      throw invalid('EXT_lights_ies mimeType');
    let profile = profiles.get(index);
    if (!profile)
      profiles.set(
        index,
        (profile = bytesOf(model, def, options).then((bytes) => parseIES(new TextDecoder().decode(bytes)))),
      );
    lights.push({
      name: def.name ?? '',
      profile: await profile,
      nodeIndex,
      multiplier,
      color: color.map((c: number) => Math.min(1, Math.max(0, c))) as Vec3,
    });
  }
  return lights;
}

/** Rotates `v` by the unit quaternion `q`. */
function rotate([x, y, z, w]: Quaternion, v: readonly number[]): Vec3 {
  const tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
const STEP_THETA = 1,
  STEP_PHI = 5;
/**
 * `profile` as a light aimed straight down with no turn sees it (`IESLights`' frame for a point light, whose axes are
 * -Y, +X and -Z): a point light has no direction of its own, and a spot's cone stops at a hemisphere, which would cut
 * an uplight. `basis` holds the node's unit X, Y and Z in world space; the extension aims the light down -Z with the
 * horizontal angle 0 along +X and 90 along +Y. Same 1 by 5 degree grid `IESLights` reads.
 */
export function orientIES(
  profile: IESProfile,
  candelaOf: (profile: IESProfile, theta: number, phi: number) => number,
  basis: readonly [Vec3, Vec3, Vec3],
): IESProfile {
  const degrees = 180 / Math.PI,
    vertical = Array.from({ length: 180 / STEP_THETA + 1 }, (_, i) => i * STEP_THETA),
    horizontal = Array.from({ length: 360 / STEP_PHI + 1 }, (_, i) => i * STEP_PHI),
    dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const candela = horizontal.map((phi) =>
    vertical.map((theta) => {
      const t = theta / degrees,
        p = phi / degrees,
        world = [Math.sin(t) * Math.cos(p), -Math.cos(t), -Math.sin(t) * Math.sin(p)],
        x = dot(world, basis[0]),
        y = dot(world, basis[1]),
        z = dot(world, basis[2]);
      return candelaOf(profile, Math.acos(Math.min(1, Math.max(-1, -z))) * degrees, Math.atan2(y, x) * degrees);
    }),
  );
  return { ...profile, vertical, horizontal, candela, peak: Math.max(...candela.map((row) => Math.max(...row))) };
}

/** IEC 61966-2-1 decode. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** RGBA8 of a PNG, or of a JPEG through the browser. */
async function pixels(
  bytes: Uint8Array,
  mimeType: string | undefined,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  if (mimeType === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50)) return decodePNG(bytes);
  const bitmap = await createImageBitmap(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType ?? 'image/jpeg' }),
      {
        colorSpaceConversion: 'none',
      },
    ),
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
    context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer),
  };
}
/**
 * One cube face to linear light. RGBD holds rgb / a; the extension does not name a transfer, and on the real file only
 * the sRGB decode of that quotient gives a mean near the file's own first coefficient, in red and blue. An image with no
 * alpha reads a = 1, so JPEG and 3-channel PNG go the same way. Saved images are upside down against WebGPU's row 0 at
 * the top (the README's "flipped"), so rows swap here.
 */
function face({ width: size, data }: { width: number; data: Uint8Array }): Float32Array {
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4,
        to = (y * size + x) * 4,
        a = Math.max(data[from + 3], 1);
      for (let k = 0; k < 3; k++) out[to + k] = linear(data[from + k] / a);
      out[to + 3] = 1;
    }
  return out;
}
// The texel direction of a cube face at u, v in -1..1, row 0 at the top, WebGPU's +X, -X, +Y, -Y, +Z, -Z.
const faceDirection = (f: number, u: number, v: number): Vec3 =>
  (
    [
      [1, -v, -u],
      [-1, -v, u],
      [u, 1, v],
      [u, -1, -v],
      [u, -v, 1],
      [-u, -v, -1],
    ] as Vec3[]
  )[f];
/** The cube read along `d`, filtered within the face it lands on. */
function readCube({ size, faces }: CubeFaces, d: Vec3, out: Float32Array, at: number): void {
  const [ax, ay, az] = d.map(Math.abs),
    f = ax >= ay && ax >= az ? (d[0] > 0 ? 0 : 1) : ay >= az ? (d[1] > 0 ? 2 : 3) : d[2] > 0 ? 4 : 5,
    m = Math.max(ax, ay, az),
    [u, v] = [
      [-d[2], -d[1]],
      [d[2], -d[1]],
      [d[0], d[2]],
      [d[0], -d[2]],
      [d[0], -d[1]],
      [-d[0], -d[1]],
    ][f],
    x = Math.min(size - 1, Math.max(0, ((u / m + 1) * size) / 2 - 0.5)),
    y = Math.min(size - 1, Math.max(0, ((v / m + 1) * size) / 2 - 0.5)),
    x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(size - 1, x0 + 1),
    y1 = Math.min(size - 1, y0 + 1),
    fx = x - x0,
    fy = y - y0,
    p = faces[f];
  for (let k = 0; k < 4; k++) {
    const top = p[(y0 * size + x0) * 4 + k] * (1 - fx) + p[(y0 * size + x1) * 4 + k] * fx,
      bottom = p[(y1 * size + x0) * 4 + k] * (1 - fx) + p[(y1 * size + x1) * 4 + k] * fx;
    out[at + k] = top * (1 - fy) + bottom * fy;
  }
}
/** `cube` with its environment turned by `q`: what lay along d now lies along q d. A cube rotates only about +Y in `Environment`, a quaternion any way. */
export function rotateCube(cube: CubeFaces, [x, y, z, w]: Quaternion): CubeFaces {
  if (x === 0 && y === 0 && z === 0) return cube;
  const inverse: Quaternion = [-x, -y, -z, w],
    { size } = cube;
  return {
    size,
    faces: cube.faces.map((_, f) => {
      const out = new Float32Array(size * size * 4);
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++)
          readCube(
            cube,
            rotate(inverse, faceDirection(f, ((i + 0.5) / size) * 2 - 1, ((j + 0.5) / size) * 2 - 1)),
            out,
            (j * size + i) * 4,
          );
      return out;
    }),
  };
}

/** The scene's EXT_lights_image_based light, or undefined when it has none. */
export async function gltfImageLight(
  model: PBRModel,
  options: GLTFLightFileOptions & { scene?: number } = {},
): Promise<GLTFImageLight | undefined> {
  const doc: GLTFDocument = model.asset.doc,
    scene = doc.scenes?.[options.scene ?? doc.scene ?? 0],
    index = scene?.extensions?.EXT_lights_image_based?.light;
  if (index === undefined) return undefined;
  const def = doc.extensions?.EXT_lights_image_based?.lights?.[index];
  if (!def) throw invalid('EXT_lights_image_based light index');
  const { specularImages: mips, specularImageSize: size, irradianceCoefficients, intensity = 1 } = def,
    rotation = def.rotation ?? [0, 0, 0, 1];
  if (
    !Array.isArray(mips) ||
    !Array.isArray(mips[0]) ||
    mips[0].length !== 6 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size & (size - 1)
  )
    throw invalid('EXT_lights_image_based specular images');
  if (!Array.isArray(irradianceCoefficients) || irradianceCoefficients.length !== 9)
    throw invalid('EXT_lights_image_based irradiance coefficients');
  if (!Array.isArray(rotation) || rotation.length !== 4 || Math.abs(Math.hypot(...rotation) - 1) > 1e-3)
    throw invalid('EXT_lights_image_based rotation');
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0)
    throw invalid('EXT_lights_image_based intensity');
  const turn: Quaternion = [rotation[0], rotation[1], rotation[2], rotation[3]];
  const faces = await Promise.all(
    mips[0].map(async (image: number) => {
      const def = doc.images?.[image];
      if (!def) throw invalid('EXT_lights_image_based image index');
      const decoded = await pixels(await bytesOf(model, def, options), def.mimeType);
      if (decoded.width !== size || decoded.height !== size)
        throw invalid('EXT_lights_image_based image: it must be specularImageSize square');
      return face(decoded);
    }),
  );
  return {
    name: def.name ?? '',
    intensity,
    rotation: turn,
    faces: rotateCube({ size, faces }, turn),
    irradianceCoefficients,
  };
}

/**
 * Lights `model` with the file's EXT_lights_ies fixtures, placed where their nodes are now, and its scene's
 * EXT_lights_image_based environment. Keeps the model's KHR_lights_punctual point and spot lights in the same list.
 * A file with neither makes nothing and loads neither package.
 */
export async function applyGLTFLightExtensions(
  model: PBRModel,
  options: GLTFLightExtensionOptions = {},
): Promise<GLTFLightExtensions> {
  const { exposure = 1, background = false } = options;
  if (!Number.isFinite(exposure) || exposure < 0)
    throw new RangeError(
      'applyGLTFLightExtensions: exposure must be a finite number of 0 or more; pass a number such as 1',
    );
  const engine = model['engine'],
    [iesLights, imageLight] = await Promise.all([gltfIESLights(model, options), gltfImageLight(model, options)]);
  const removers: (() => void)[] = [],
    made: {
      -readonly [K in 'clustered' | 'ies' | 'environment' | 'lighting' | 'background']?: GLTFLightExtensions[K];
    } = {};
  const dispose = () => {
    for (const remove of removers.splice(0).reverse()) remove();
  };
  try {
    if (iesLights.length) {
      const [{ Clustered }, { IESLights, iesCandela }] = await Promise.all([
        peer(import('@margoengine/clustered'), '@margoengine/clustered'),
        peer(import('@margoengine/clustered/ies'), '@margoengine/clustered'),
      ]);
      const clustered = options.clustered ?? Clustered.attach(engine);
      if (!options.clustered) removers.push(() => clustered.dispose());
      const ies = IESLights.attach(engine, { lights: clustered });
      removers.push(() => ies.dispose());
      engine.store.tick(false);
      const punctual = model.clusteredLights(),
        oriented = new Map<string, IESProfile>(),
        fixtures: PointLight[] = [],
        profiles: IESProfile[] = [];
      for (const light of iesLights) {
        const m = model.nodes[light.nodeIndex].matrix,
          unit = (k: number): Vec3 => {
            const scale = Math.hypot(m[k], m[k + 1], m[k + 2]) || 1;
            return [m[k] / scale, m[k + 1] / scale, m[k + 2] / scale];
          },
          basis: [Vec3, Vec3, Vec3] = [unit(0), unit(4), unit(8)],
          // Lights aimed alike share a profile: IESLights holds 16.
          key =
            light.profile.format +
            light.name +
            basis
              .flat()
              .map((v) => v.toFixed(3))
              .join();
        let profile = oriented.get(key);
        if (!profile) oriented.set(key, (profile = orientIES(light.profile, iesCandela, basis)));
        const intensity = profile.peak * light.multiplier * exposure;
        fixtures.push({
          position: [m[12], m[13], m[14]],
          // Where the light falls below 1/256 of a candela at a metre, as `clusteredLights` sets a punctual light's.
          range: Math.sqrt(intensity * 256) || 1,
          color: light.color,
          intensity,
          decay: 2,
        });
        profiles.push(profile);
      }
      clustered.setLights([...punctual, ...fixtures]);
      ies.setProfiles([...punctual.map(() => null), ...profiles]);
      removers.push(clustered.add(model));
      Object.assign(made, { clustered, ies });
    }
    if (imageLight) {
      const { Environment, EnvironmentBackground, EnvironmentLighting } = await peer(
        import('@margoengine/environment'),
        '@margoengine/environment',
      );
      const environment = await Environment.attach(engine, imageLight.faces, { intensity: imageLight.intensity }),
        lighting = EnvironmentLighting.attach(engine, environment);
      removers.push(() => environment.dispose());
      removers.push(() => lighting.dispose());
      lighting.add(model);
      Object.assign(made, { environment, lighting });
      if (background) {
        const backdrop = EnvironmentBackground.attach(engine, environment);
        removers.push(() => backdrop.dispose());
        made.background = backdrop;
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { iesLights, imageLight, ...made, dispose, [Symbol.dispose]: dispose };
}
