import type { PBRModel } from './model.js';
import { fault } from '../../shared/errors.js';
import { materialDrawAdapters } from './material-draw-state.js';

/** A synchronous draw on the source model or an isolated device renderer. */
export interface MaterialDrawCall {
  readonly model: PBRModel;
  readonly context: Parameters<PBRModel['draw']>[0];
  readonly mode: Parameters<PBRModel['draw']>[1];
  readonly phase: 'all' | 'opaque' | 'blend';
  /** Draw the current material records with the original context, pass and phase. */
  draw(): void;
}

/** Temporarily select materials, call draw for each layer, then restore the records before returning. */
export type MaterialDrawAdapter = (call: MaterialDrawCall) => void;

/**
 * Install one synchronous material-layer adapter. It also reaches existing and future isolated renderers.
 * The returned remover is idempotent; disposing the source removes the adapter automatically.
 * No adapter is installed by importing this entry.
 */
export function setMaterialDraw(model: PBRModel, adapter: MaterialDrawAdapter): () => void {
  if (model.disposed) throw fault('disposed', 'Material drawing needs a live model; load the model again');
  if (typeof adapter !== 'function')
    throw new TypeError(
      'Material draw adapter must be a synchronous function; see https://margoengine.com/errors#material',
    );
  if (materialDrawAdapters.has(model))
    throw fault('attached', 'A material draw adapter is already installed; remove it before installing another', 'material');
  let unsubscribe: (() => void) | undefined;
  const remove = () => {
    if (materialDrawAdapters.get(model) === adapter) materialDrawAdapters.delete(model);
    unsubscribe?.();
    unsubscribe = undefined;
  };
  materialDrawAdapters.set(model, adapter);
  try {
    unsubscribe = model.onDispose(remove);
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}
