// A model takes one capture hook (gltf-pro `setCapture`). SSR, SSGI and a ScenePass all capture models, so the hook a model
// gets is this one per model: while an effect draws the model's capture (`drawCapture`) it forwards to that effect's hook.
// With one effect it is that effect's hook exactly: same declarations, targets and pass. The state sits on the model under
// a registered symbol because post and shader each bundle their own copy of this file.
const key = Symbol.for('margoengine.capture');
const first = (s) => s.current ?? s.users.values().next().value;

/** Lets `hook` capture `model` alongside any other effect; returns a remover. */
export function shareCapture(model, hook) {
  let s = model[key];
  if (!s) {
    const state = { users: new Set() };
    s = state;
    model[key] = state;
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
      delete model[key];
      throw error;
    }
  } else s.users.add(hook);
  const state = s;
  return () => {
    if (!state.users.delete(hook) || state.users.size) return;
    delete model[key];
    state.restore?.();
  };
}
/** Adds `model` to an effect's `models` once, sharing `hook`, until it is removed or disposed; returns the remover. */
export function captureModel(models, model, hook) {
  let release = models.get(model);
  if (!release) {
    const restore = shareCapture(model, hook),
      forget = model.onDispose(() => models.delete(model));
    release = () => {
      if (models.get(model) === release) {
        models.delete(model);
        forget();
        restore();
      }
    };
    models.set(model, release);
  }
  return release;
}
/** Draws `model`'s capture into `hook`'s targets (`hook.begin()`'s pass). */
export function drawCapture(model, hook, c) {
  const s = model[key];
  if (!s?.users.has(hook)) return;
  s.current = hook;
  try {
    model.draw(c, 'capture', c.color, c.depth);
  } finally {
    s.current = undefined;
  }
}
