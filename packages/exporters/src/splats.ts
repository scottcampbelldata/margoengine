/** Portable Gaussian cloud export. The optional splats package is loaded only when an export is requested. */
import type { SplatData } from '@margoengine/splats/data';
import { joinGLB } from './glb.js';
import { addView, packGLB, type JSONObject, type NewViews } from './glb-pack.js';
import { copyExtras } from './extras.js';

/** Gaussian export settings shared by GLB and the raw .splat format. */
export interface SplatExportOptions {
  /** Maximum output bytes. Default 4,294,967,295 (the GLB format limit). */
  maxBytes?: number;
  /** Stops before module loading and between splats. */
  signal?: AbortSignal;
}

/** Settings for a KHR_gaussian_splatting GLB. */
export interface GaussianGLBOptions extends SplatExportOptions {
  /** Node and mesh name. Default omitted. */
  name?: string;
  /** Asset generator. Default 'Margo Engine Gaussian exporter'. */
  generator?: string;
  /** Require splat support, rather than permitting COLOR_0 point-cloud fallback. Default false. */
  required?: boolean;
  /** Root extras, copied as a finite JSON tree. Default none. */
  extras?: Readonly<Record<string, unknown>>;
}

const NAME = 'KHR_gaussian_splatting',
  C0 = 0.2820947917738781;
function maximum(options: SplatExportOptions): number {
  const max = options.maxBytes ?? 0xffffffff;
  if (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff)
    throw new RangeError(
      'MARGO_EXPORT_SPLAT_LIMIT: set maxBytes to an integer from 0 to 4294967295. See docs/limits.md',
    );
  return max;
}

/**
 * Write the common 32-byte-per-Gaussian .splat format using the splats package's existing codec. Positions and axis
 * scales are Float32, colors/opacity and rotations are quantized bytes; higher SH bands are absent in this format.
 * @throws {RangeError} For invalid data or an exceeded output limit; provide valid splats or raise maxBytes.
 */
export async function exportSplat(data: SplatData, options: SplatExportOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const max = maximum(options),
    { validateSplats, encodeSplat } = await import('@margoengine/splats/data');
  options.signal?.throwIfAborted();
  const count = validateSplats(data);
  if (count * 32 > max)
    throw new RangeError(
      'MARGO_EXPORT_SPLAT_SIZE: .splat exceeds maxBytes; export fewer splats or raise maxBytes. See docs/limits.md',
    );
  return encodeSplat(data);
}

/**
 * Write the ratified KHR_gaussian_splatting ellipse kernel, retaining linear Rec.709 color, opacity and every
 * available SH band (degrees 0..3). Covariance is decomposed by the owning splats package. The POINTS fallback
 * has linear COLOR_0 with opacity. Input arrays are never modified.
 * @throws {RangeError} For invalid data or output limits; provide valid splats or raise maxBytes.
 * @throws {TypeError} For malformed metadata; use strings, a boolean required flag and JSON extras.
 */
export async function exportGaussianGLB(data: SplatData, options: GaussianGLBOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const max = maximum(options);
  if (
    (options.name !== undefined && typeof options.name !== 'string') ||
    (options.generator !== undefined && typeof options.generator !== 'string') ||
    (options.required !== undefined && typeof options.required !== 'boolean')
  )
    throw new TypeError(
      'MARGO_EXPORT_SPLAT_OPTIONS: use string names/generator and a boolean required flag. See docs/limits.md',
    );
  const extras = copyExtras(options.extras, 'Gaussian extras'),
    { validateSplats, decomposeCovariance } = await import('@margoengine/splats/data');
  options.signal?.throwIfAborted();
  const count = validateSplats(data),
    sh = data.sphericalHarmonics,
    coefficients = sh ? sh.length / count / 3 : 1,
    binaryBytes = count * (12 + 12 + 16 + 4 + 12 + 16 + (coefficients - 1) * 12);
  if (binaryBytes > max)
    throw new RangeError(
      'MARGO_EXPORT_SPLAT_SIZE: Gaussian attributes exceed maxBytes; export fewer splats or raise maxBytes. See docs/limits.md',
    );
  const scales = new Float32Array(count * 3),
    rotations = new Float32Array(count * 4),
    opacity = new Float32Array(count),
    dc = new Float32Array(count * 3),
    colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted();
    const parts = decomposeCovariance(data.covariances, i * 6);
    scales.set(parts.scale, i * 3);
    rotations.set(parts.rotation, i * 4);
    opacity[i] = data.colors[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      dc[i * 3 + c] = sh ? sh[i * coefficients * 3 + c] : (data.colors[i * 4 + c] - 0.5) / C0;
      colors[i * 4 + c] = Math.max(0, Math.min(1, C0 * dc[i * 3 + c] + 0.5));
    }
    colors[i * 4 + 3] = opacity[i];
  }
  const attributes: JSONObject = {},
    json: JSONObject = {
      asset: { version: '2.0', generator: options.generator ?? 'Margo Engine Gaussian exporter' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, ...(options.name === undefined ? {} : { name: options.name }) }],
      meshes: [
        {
          ...(options.name === undefined ? {} : { name: options.name }),
          primitives: [
            { mode: 0, attributes, extensions: { [NAME]: { kernel: 'ellipse', colorSpace: 'lin_rec709_display' } } },
          ],
        },
      ],
      buffers: [{ byteLength: 0 }],
      accessors: [],
      extensionsUsed: [NAME],
      ...(options.required ? { extensionsRequired: [NAME] } : {}),
      ...(extras ? { extras } : {}),
    },
    fresh: NewViews = new Map();
  const write = (name: string, values: Float32Array, width: number): void => {
    const view = addView(json, fresh, new Uint8Array(values.buffer, values.byteOffset, values.byteLength), {
        target: 34962,
      }),
      accessor: JSONObject = {
        bufferView: view,
        componentType: 5126,
        count,
        type: width === 1 ? 'SCALAR' : `VEC${width}`,
      };
    if (name === 'POSITION') {
      accessor.min = [Infinity, Infinity, Infinity];
      accessor.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i++) {
        accessor.min[i % 3] = Math.min(accessor.min[i % 3], values[i]);
        accessor.max[i % 3] = Math.max(accessor.max[i % 3], values[i]);
      }
    }
    attributes[name] = json.accessors.push(accessor) - 1;
  };
  write('POSITION', data.positions, 3);
  write(`${NAME}:SCALE`, scales, 3);
  write(`${NAME}:ROTATION`, rotations, 4);
  write(`${NAME}:OPACITY`, opacity, 1);
  write(`${NAME}:SH_DEGREE_0_COEF_0`, dc, 3);
  write('COLOR_0', colors, 4);
  let coefficient = 1;
  for (let degree = 1; coefficient < coefficients; degree++)
    for (let order = 0; order < 2 * degree + 1; order++, coefficient++) {
      const values = new Float32Array(count * 3);
      for (let i = 0; i < count; i++)
        for (let c = 0; c < 3; c++) values[i * 3 + c] = sh![(i * coefficients + coefficient) * 3 + c];
      write(`${NAME}:SH_DEGREE_${degree}_COEF_${order}`, values, 3);
    }
  options.signal?.throwIfAborted();
  const output = joinGLB(packGLB({ json, bin: null, chunks: [] }, fresh));
  if (output.length > max)
    throw new RangeError(
      'MARGO_EXPORT_SPLAT_SIZE: GLB exceeds maxBytes; export fewer splats or raise maxBytes. See docs/limits.md',
    );
  return output;
}
