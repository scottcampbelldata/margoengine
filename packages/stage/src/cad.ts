import type { Stage } from './index.js';
import type { LoadedModel } from './model.js';
import { loadTarget, optionalPackage, placeModel, stageSignal } from './feature.js';
import { typeError } from '../../shared/errors.js';

export type { LoadedModel } from './model.js';
/** Options for `addCAD`. Format and framing belong to the stage; the rest are forwarded to `loadCAD`. */
export interface AddCADOptions {
  /** Cancels the import; the stage's disposal cancels it too. */
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  smoothing?: boolean;
  /** Most parts (OBJ objects and groups, STEP/IGES meshes) the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxParts?: number;
  /**
   * The worker is terminated and the import rejects after this many milliseconds (default 120,000). OpenCascade can
   * spend minutes tessellating a malformed STEP or IGES file; a worker that never answers is never waited on.
   */
  timeoutMs?: number;
  /** File format; default from the URL extension ('stp' is STEP, 'igs' IGES). An unknown format rejects with a TypeError. */
  format?: 'stl' | 'obj' | 'step' | 'iges';
  /** Fit the camera to the loaded model. Default true. */
  fit?: boolean;
}

/**
 * Imports an STL, OBJ, STEP or IGES file with `@margoengine/machinery/cad` (STEP and IGES through OpenCascade in a
 * worker), adds it to the stage and fits the camera to it. The package is imported on the first call. Rejects with
 * `Install @margoengine/machinery` when it is missing, and with AbortError, adding nothing, when `signal` aborts or the
 * stage is disposed first.
 * @example const part = await addCAD(stage, '/bracket.step');
 */
export async function addCAD(
  stage: Stage,
  url: string | URL,
  { format, fit = true, signal, ...options }: AddCADOptions = {},
): Promise<LoadedModel> {
  const target = loadTarget(url, fit),
    extension = target.pathname.toLowerCase().split('.').at(-1);
  const kind = format ?? (extension === 'stp' ? 'step' : extension === 'igs' ? 'iges' : extension);
  if (kind !== 'stl' && kind !== 'obj' && kind !== 'step' && kind !== 'iges')
    throw typeError('Specify format', 'install');
  const abort = stageSignal(stage, signal);
  abort.throwIfAborted();
  const { loadCAD } = await optionalPackage(
    '@margoengine/machinery',
    () => import('@margoengine/machinery/cad'),
    abort,
  );
  return placeModel(
    stage,
    await loadCAD(stage.engine, target, { ...options, format: kind, signal: abort }),
    fit,
    abort,
  );
}
