import type { PBRModel } from './model.js';
import type { MaterialDrawAdapter } from './material-draw.js';
import { typeError } from '../../shared/errors.js';

/** One explicit adapter per source model; replicas inherit the current owner each draw. */
export const materialDrawAdapters = new WeakMap<PBRModel, MaterialDrawAdapter>();
const bypass = new WeakSet<PBRModel>();

export function currentMaterialDraw(model: PBRModel): MaterialDrawAdapter | undefined {
  // Consume the one delegated call before entering it, so a nested probe/view
  // inside the ordinary renderer still receives its own adapter invocation.
  return bypass.delete(model) ? undefined : materialDrawAdapters.get(model);
}

export function runMaterialDraw(
  model: PBRModel,
  adapter: MaterialDrawAdapter,
  parameters: Parameters<PBRModel['draw']>,
  draw: () => void,
): void {
  const result = adapter({
    model,
    context: parameters[0],
    mode: parameters[1],
    phase: parameters[4] ?? 'all',
    draw() {
      bypass.add(model);
      try {
        draw();
      } finally {
        bypass.delete(model);
      }
    },
  }) as unknown;
  if (result && typeof (result as { then?: unknown }).then === 'function')
    throw typeError('Material draw adapters must complete synchronously; do not return a promise', 'material');
}

export function inheritMaterialDraw(source: PBRModel, replica: PBRModel): void {
  const adapter = materialDrawAdapters.get(source);
  if (adapter) materialDrawAdapters.set(replica, adapter);
  else materialDrawAdapters.delete(replica);
}
