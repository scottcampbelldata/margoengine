// KHR_gaussian_splatting for gltf-pro: glTF accessors (or the draft SPZ payload) to @margoengine/splats, which holds the
// renderer, the SPZ reader and the transforms. Written from the extension's README (Complete, Ratified by the Khronos
// Group; read 2026-11-06, KhronosGroup/glTF main) and the draft KHR_gaussian_splatting_compression_spz_2 (pull request
// 2531). This entry and @margoengine/splats load only for a file that holds splats.
import type { GaussianAttributes, SplatData } from '@margoengine/splats/data';
import type { GLTFPrimitive } from '../../shared/gltf.js';
import { margoError } from '../../shared/errors.js';
import type { GLTFAsset, GLTFSplatCloud, GLTFSplatReader } from './asset.js';

const NAME = 'KHR_gaussian_splatting',
  SPZ = 'KHR_gaussian_splatting_compression_spz_2',
  FLOAT = 5126,
  // SH band sizes: 3, 5 and 7 coefficients for degrees 1, 2 and 3.
  BANDS = [3, 5, 7],
  // Most splats one cloud takes (validateSplats).
  CAPACITY = 3_000_000,
  // Band-0 SH constant: colour = 0.5 + C0 * coefficient.
  C0 = 0.2820947917738781;
/** Component types the extension allows per attribute: [componentType, normalized]. */
const ROTATION: readonly (readonly [number, boolean])[] = [
    [FLOAT, false],
    [5120, true],
    [5122, true],
  ],
  SCALE: readonly (readonly [number, boolean])[] = [
    [FLOAT, false],
    [5121, false],
    [5121, true],
    [5123, false],
    [5123, true],
  ],
  OPACITY: readonly (readonly [number, boolean])[] = [
    [FLOAT, false],
    [5121, true],
    [5123, true],
  ],
  COEFFICIENT: readonly (readonly [number, boolean])[] = [[FLOAT, false]];

const invalid = (what: string) =>
  new TypeError(`Invalid glTF ${NAME} ${what}; the file is not valid, re-export it and check it with the glTF Validator`);

/** A module of @margoengine/splats, which a file with splats needs. */
const splats = <T>(load: Promise<T>): Promise<T> =>
  load.catch((error) => {
    throw margoError(
      'unsupported',
      `${NAME} needs @margoengine/splats (${error instanceof Error ? error.message : error}): install it, or pass decoders: {splats: false} for the point cloud fallback`,
    );
  });

function accessor(
  asset: GLTFAsset,
  attributes: Record<string, number>,
  semantic: string,
  type: string,
  allowed: readonly (readonly [number, boolean])[],
  count: number,
): Float32Array {
  const id = attributes[semantic];
  if (id === undefined) throw invalid(`primitive: ${semantic} is missing`);
  const def = asset.doc.accessors?.[id];
  if (!allowed.some(([kind, normalized]) => kind === def?.componentType && normalized === !!def?.normalized))
    throw invalid(`accessor for ${semantic}: componentType ${def?.componentType}${def?.normalized ? ' normalized' : ''}`);
  const values = asset.accessor(id, type);
  if (def?.count !== count) throw invalid(`accessor for ${semantic}: its count differs from POSITION`);
  return values;
}

/**
 * The splats of mesh primitive `primitive`, in the primitive's local space, as `SplatData` for @margoengine/splats: its
 * glTF attributes or its KHR_gaussian_splatting_compression_spz_2 payload. Needs no GPU.
 * @throws TypeError when the primitive breaks the extension's rules, RangeError on values @margoengine/splats refuses,
 * MargoError `'unsupported'` for a kernel or colour space the extension does not define.
 */
export async function readGaussianSplats(
  asset: GLTFAsset,
  primitive: GLTFPrimitive,
  { signal }: { signal?: AbortSignal } = {},
): Promise<SplatData> {
  const extension = primitive.extensions?.[NAME] as
      | { kernel?: string; colorSpace?: string; extensions?: Record<string, { bufferView: number } | undefined> }
      | undefined,
    attributes = primitive.attributes ?? {};
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) throw invalid('extension');
  if (primitive.mode !== 0) throw invalid('primitive: its mode must be POINTS');
  // Files written against the draft leave kernel and colorSpace out, as the CesiumJS samples do: the ratified defaults.
  const { kernel = 'ellipse', colorSpace = 'srgb_rec709_display' } = extension;
  if (kernel !== 'ellipse')
    throw margoError('unsupported', `${NAME} kernel ${kernel} is not supported; re-export the file with "ellipse"`);
  if (colorSpace !== 'srgb_rec709_display' && colorSpace !== 'lin_rec709_display')
    throw margoError('unsupported', `${NAME} color space ${colorSpace} is not supported; re-export the file in rec709`);
  const { parseSpz, splatsFromAttributes } = await splats(import('@margoengine/splats/data'));
  signal?.throwIfAborted();
  const compressed = extension.extensions?.[SPZ];
  if (compressed) {
    // SPZ stores display colour, and the draft defines no other.
    if (colorSpace !== 'srgb_rec709_display') throw invalid('primitive: SPZ colour is srgb_rec709_display');
    return parseSpz(asset.view(compressed.bufferView), { signal });
  }
  const positions = asset.accessor(attributes.POSITION, 'VEC3'),
    count = positions.length / 3,
    read = (semantic: string, type: string, allowed: readonly (readonly [number, boolean])[]) =>
      accessor(asset, attributes, `${NAME}:${semantic}`, type, allowed, count);
  const rotation = read('ROTATION', 'VEC4', ROTATION),
    scale = read('SCALE', 'VEC3', SCALE),
    alphas = read('OPACITY', 'SCALAR', OPACITY),
    dc = read('SH_DEGREE_0_COEF_0', 'VEC3', COEFFICIENT);
  // A band exists whole or not at all, and only over the bands below it.
  const bands: Float32Array[] = [];
  let ended = false;
  BANDS.forEach((size, degree) => {
    const names = Array.from({ length: size }, (_, n) => `SH_DEGREE_${degree + 1}_COEF_${n}`),
      present = names.filter((name) => `${NAME}:${name}` in attributes).length;
    if (present && (present !== size || ended)) throw invalid(`primitive: spherical harmonics degree ${degree + 1}`);
    if (present) for (const name of names) bands.push(read(name, 'VEC3', COEFFICIENT));
    else ended = true;
  });
  const raw: GaussianAttributes = {
    count,
    positions,
    logScales: scale.map(Math.log),
    rotations: new Float32Array(count * 4),
    dc,
    alphas,
  };
  // glTF quaternions are x y z w; these attributes are w x y z.
  for (let i = 0; i < count; i++) {
    raw.rotations[i * 4] = rotation[i * 4 + 3];
    raw.rotations.set(rotation.subarray(i * 4, i * 4 + 3), i * 4 + 1);
  }
  if (bands.length) {
    const rest = new Float32Array(count * bands.length * 3);
    bands.forEach((band, n) => {
      for (let i = 0; i < count; i++) rest.set(band.subarray(i * 3, i * 3 + 3), (i * bands.length + n) * 3);
    });
    raw.rest = rest;
  }
  return splatsFromAttributes(raw, { linear: colorSpace === 'lin_rec709_display' });
}

/** Coefficients per channel of `cloud`: 0 when it has no spherical harmonics. */
const coefficients = (cloud: SplatData): number =>
  cloud.sphericalHarmonics ? cloud.sphericalHarmonics.length / (cloud.positions.length / 3) / 3 : 0;

/** `cloud` with `size` coefficients per channel: its own, then zeros (band 0 from its colour when it has none). */
function withBands(cloud: SplatData, size: number): SplatData {
  const own = coefficients(cloud);
  if (own === size) return cloud;
  const count = cloud.positions.length / 3,
    sh = new Float32Array(count * size * 3);
  for (let i = 0; i < count; i++)
    if (own) sh.set(cloud.sphericalHarmonics!.subarray(i * own * 3, (i + 1) * own * 3), i * size * 3);
    else for (let c = 0; c < 3; c++) sh[i * size * 3 + c] = (cloud.colors[i * 4 + c] - 0.5) / C0;
  return { ...cloud, sphericalHarmonics: sh };
}

function bounds({ positions }: SplatData): Float32Array {
  const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < positions.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = Math.min(out[axis], positions[i + axis]);
      out[axis + 3] = Math.max(out[axis + 3], positions[i + axis]);
    }
  return out;
}

/**
 * The reader `loadGLTF` and `parseGLTFAsync` import when a file holds splats: each primitive read, placed by its node's
 * world matrix, the clouds of the file merged so that they sort together, in clouds of at most 3,000,000 splats.
 */
export const gaussianSplats: GLTFSplatReader = {
  async attach(engine, asset, primitives, signal) {
    const { Splats, mergeSplats, transformSplats } = await splats(import('@margoengine/splats')),
      read: SplatData[] = [];
    for (const { primitive, matrix } of primitives)
      read.push(transformSplats(await readGaussianSplats(asset, primitive, { signal }), matrix));
    const size = Math.max(...read.map(coefficients)),
      groups: SplatData[][] = [];
    let held = CAPACITY;
    for (const cloud of read) {
      const count = cloud.positions.length / 3;
      if (held + count > CAPACITY) {
        groups.push([]);
        held = 0;
      }
      groups[groups.length - 1].push(size ? withBands(cloud, size) : cloud);
      held += count;
    }
    const clouds: GLTFSplatCloud[] = [];
    try {
      for (const group of groups) {
        signal?.throwIfAborted();
        const data = group.length > 1 ? mergeSplats(...group) : group[0],
          cloud = new Splats(data);
        engine.use(cloud);
        clouds.push({ cloud, bounds: bounds(data) });
      }
    } catch (error) {
      for (const { cloud } of clouds) cloud.dispose();
      throw error;
    }
    return clouds;
  },
};
