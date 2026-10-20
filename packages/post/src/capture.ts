import type { PassContext } from '@margoengine/core/extension';
import type { SSRCapture, SSRModel } from './ssr.js';
type Context = Extract<PassContext, { backend: 'webgpu' }>;

// A model takes one capture hook (gltf-pro `setCapture`). SSR and SSGI both capture models, so the hook a model gets is
// this one per model: while an effect draws the model's capture (`drawCapture`) it forwards to that effect's hook.
// With one effect it is that effect's hook exactly: same declarations, targets and pass.
interface Shared {
  readonly users: Set<SSRCapture>;
  current?: SSRCapture;
  restore?: () => void;
}
const shared = new WeakMap<SSRModel, Shared>();
const first = (s: Shared) => s.current ?? s.users.values().next().value!;

/** Lets `hook` capture `model` alongside any other post effect; returns a remover. */
export function shareCapture(model: SSRModel, hook: SSRCapture): () => void {
  let s = shared.get(model);
  if (!s) {
    const state: Shared = { users: new Set() };
    s = state;
    shared.set(model, state);
    state.users.add(hook);
    try {
      state.restore = model.setCapture({
        get targets() {
          return first(state).targets;
        },
        declarations: (code) => first(state).declarations(code),
        begin: () => first(state).begin(),
      });
    } catch (error) {
      shared.delete(model);
      throw error;
    }
  } else s.users.add(hook);
  const state = s;
  return () => {
    if (!state.users.delete(hook) || state.users.size) return;
    shared.delete(model);
    state.restore?.();
  };
}
/** Draws `model`'s capture into `hook`'s targets (`hook.begin()`'s pass). */
export function drawCapture(model: SSRModel, hook: SSRCapture, c: Context): void {
  const s = shared.get(model);
  if (!s?.users.has(hook)) return;
  s.current = hook;
  try {
    model.draw(c, 'capture', c.color, c.depth);
  } finally {
    s.current = undefined;
  }
}
