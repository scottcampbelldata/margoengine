import type { EnginePlugin } from '@margoengine/core';
import type { Stage } from './index.js';
import { fault } from '../../shared/errors.js';

/** The stage's disposal signal, combined with the caller's `signal` when there is one. */
export function stageSignal(stage: Stage, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, stage.signal]) : stage.signal;
}

/**
 * Imports an optional package for a stage feature entry. A missing package rejects with its npm install command and a help link; every other
 * failure, including AbortError, is rethrown. Rejects with AbortError when `abort` fires before the import resolves.
 */
export async function optionalPackage<T>(name: string, load: () => Promise<T>, abort: AbortSignal): Promise<T> {
  let module: T;
  try {
    module = await load();
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
    const message = error instanceof Error ? error.message : '';
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find (module|package)|Failed to resolve|dynamically imported module/i.test(message)
    )
      throw fault(
        'state',
        `Install ${name} to use this stage feature; run npm install ${name} and restart the app`,
        'install',
      );
    throw error instanceof Error ? error : fault('failed', message);
  }
  abort.throwIfAborted();
  return module;
}

/** Imports `name`, then constructs one plugin and attaches it to the stage, unless the stage was disposed meanwhile. */
export async function attachPlugin<T extends EnginePlugin, M>(
  stage: Stage,
  name: string,
  load: () => Promise<M>,
  create: (module: M) => T,
): Promise<T> {
  return stage.use(create(await optionalPackage(name, load, stage.signal)));
}

// Shared with @margoengine/cad's addCAD (packages/shared/stage-model.js).
export { loadTarget, placeModel } from '../../shared/stage-model.js';
