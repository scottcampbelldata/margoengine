// The PostStack a full-screen pass's `attach` joins: the scene's own, or a new one made for it. `@margoengine/post`
// loads only when attach runs, so the entries that hold NodePass and ShaderPass do not import it.
import type { EngineKernel } from '@margoengine/core';
import type { EnginePlugin } from '@margoengine/core/extension';
/** What a pass's `attach` keeps of the PostStack it joined. */
export type OwnStack = { removeEffect(effect: EnginePlugin): boolean };
/**
 * Adds `pass` to the PostStack of the engine's scene, after the last effect of its kind, or to a new PostStack when
 * the scene has none, loading `@margoengine/post` only now. The pass is disposed when it cannot join, so a failed or
 * aborted attach leaves nothing behind.
 */
export async function ownStack(engine: EngineKernel, pass: EnginePlugin, signal?: AbortSignal): Promise<OwnStack> {
  try {
    const { PostStack } = await import('@margoengine/post/stack');
    signal?.throwIfAborted();
    return PostStack.join(engine, pass);
  } catch (error) {
    pass.dispose?.();
    throw error;
  }
}
