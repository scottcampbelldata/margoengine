// Consumers declare @margoengine/math, so the error class is shared with their other package errors.
import { MargoError } from '@margoengine/math/errors';

/** Refuse the small WebGL2 preview before a GPU-only plugin takes ownership or allocates resources. */
export function requireWebGPU(engine, subject) {
  if (engine.backend === 'webgl2' || !engine.gpu)
    throw new MargoError('unsupported', `${subject} needs WebGPU; see https://margoengine.com/errors#webgpu`);
}
