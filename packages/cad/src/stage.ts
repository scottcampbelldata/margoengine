import type { LoadedModel, Stage } from '@margoengine/stage';
import { loadTarget, placeModel } from '../../shared/stage-model.js';
import { typeError } from '../../shared/errors.js';
import { cadFormatOf } from './internal/format.js';

export type { LoadedModel } from '@margoengine/stage';
/** Options for `addCAD`. Format and framing belong to the stage; the rest are forwarded to `loadCAD`. */
export interface AddCADOptions {
  /** Cancels the import; the stage's disposal cancels it too. */
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  smoothing?: boolean;
  /** Most parts (OBJ objects and groups, B-rep placements) the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxParts?: number;
  /**
   * The worker is terminated and the import rejects after this many milliseconds (default 120,000). A very large or
   * malformed B-rep file can take minutes to mesh; a worker that never answers is never waited on.
   */
  timeoutMs?: number;
  /**
   * File format; default from the URL extension ('stp' is STEP, 'igs' IGES, 'x_t', 'x_b' and 'xmt_txt' XT). An unknown
   * format rejects with a TypeError.
   */
  format?: 'stl' | 'obj' | 'step' | 'iges' | 'sat' | 'xt' | 'jt';
  /** Fit the camera to the loaded model. Default true. */
  fit?: boolean;
}

/**
 * Imports an STL, OBJ, STEP, IGES, SAT, XT or JT file with `loadCAD` (the B-rep formats through Margo's own kernel
 * in a worker), adds it to the stage and fits the camera to it. The loader is imported on the first call. Rejects with
 * AbortError, adding nothing, when `signal` aborts or the stage is disposed first.
 * @example const part = await addCAD(stage, '/bracket.step');
 */
export async function addCAD(
  stage: Stage,
  url: string | URL,
  { format, fit = true, signal, ...options }: AddCADOptions = {},
): Promise<LoadedModel> {
  const target = loadTarget(url, fit),
    kind = cadFormatOf(target.pathname, format);
  if (!kind) throw typeError('Specify format', 'install');
  // The stage's disposal aborts the import too. The loader is this package's own module, so it is never missing.
  const abort = signal ? AbortSignal.any([signal, stage.signal]) : stage.signal;
  abort.throwIfAborted();
  const { loadCAD } = await import('./cad.js');
  abort.throwIfAborted();
  return placeModel(
    stage,
    await loadCAD(stage.engine, target, { ...options, format: kind, signal: abort }),
    fit,
    abort,
  );
}
