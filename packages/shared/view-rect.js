// Multi-view helpers for passes. `PassContext.view` is absent for a plain full-canvas frame, which keeps today's path.

/** The view rectangle in drawing-buffer pixels, or undefined for the whole target. */
export function viewRect(context) {
  return context?.view?.viewport;
}

/** The view's size in pixels: its rectangle, or the whole target. */
export function viewSize(context) {
  const rect = viewRect(context);
  return rect ? [rect[2], rect[3]] : [context.width, context.height];
}

/** Viewport and scissor in drawing-buffer pixels. No-op without a view. */
export function applyView(pass, context) {
  const rect = viewRect(context);
  if (!rect) return;
  pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1);
  const scissor = context.view.scissor ?? rect;
  pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
}

/** Colour load for a stacked view: the first view may clear, later views load so earlier views stay. */
export function viewLoadOp(context, preferred = 'clear') {
  return context?.view?.index ? 'load' : preferred;
}

/** Stable id for per-view state; 0 without a view. */
function viewKey(context) {
  return context?.view?.id ?? 0;
}

/** The render-layer registry that @margoengine/cameras/layers keeps on globalThis; undefined until that module loads. */
export function layerRegistry() {
  return globalThis[Symbol.for('margoengine.layers')];
}

/** A mesh's render layer mask (`setRenderLayers` in @margoengine/cameras/layers); 1 without that module. */
export function meshLayers(mesh) {
  return layerRegistry()?.maskOf(mesh) ?? 1;
}

/** The mask set on `mesh` itself with `setRenderLayers` (no inheritance, no layer source), or undefined. */
export function ownLayers(mesh) {
  return layerRegistry()?.masks.get(mesh);
}

/** Checks a 32-bit layer mask; `subject` names it in the message. */
export function checkLayers(mask, subject) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)
    throw new RangeError(`${subject} ${mask} is not a 32-bit layer mask; pass an integer from 0 to 0xffffffff`);
  return mask >>> 0;
}

/**
 * Runs `run` with the visible meshes outside layer `mask` and the visible `exclude` meshes hidden, then shows them
 * again, also when `run` throws. For captures that leave out given meshes; plain layer filtering needs no hiding.
 */
export function withHidden(engine, mask, exclude, run) {
  const registry = layerRegistry(),
    hidden = [],
    live = (mesh) => engine.meshes.get(mesh.id) === mesh,
    hide = (mesh) => {
      if (live(mesh) && !engine.store.hidden[mesh.id]) {
        mesh.visible = false;
        hidden.push(mesh);
      }
    };
  // Every mesh is on layer 0 until a mask is set or a source installed.
  if (mask !== 0xffffffff && (registry?.used || registry?.source || !(mask & 1)))
    for (const mesh of engine.meshes.values()) if (!(meshLayers(mesh) & mask)) hide(mesh);
  if (exclude) for (const mesh of exclude) hide(mesh);
  try {
    return run();
  } finally {
    if (!engine.disposed) for (const mesh of hidden) if (live(mesh)) mesh.visible = true;
  }
}

/** Whether the view being drawn shows `mesh`: their layer masks share a bit. True without a view or view layers. */
export function inView(context, mesh) {
  const layers = context?.view?.layers;
  return layers === undefined || (meshLayers(mesh) & layers) !== 0;
}

/**
 * Per-view state of an effect with history (TAA, water foam, volumetric fog, points picking). `get(context)` returns
 * the state of the view being drawn, made by `create` for a new view id. `prune()`, called from `onPreUpdate` with a
 * positive delta (once per frame, not on picks), releases the states of views not drawn since the previous call.
 */
export class ViewStates {
  constructor(create, release = () => {}) {
    this.create = create;
    this.release = release;
    this.states = new Map();
    this.frame = 0;
  }
  get(context) {
    const key = viewKey(context);
    let entry = this.states.get(key);
    if (!entry) this.states.set(key, (entry = { state: this.create(context), frame: 0 }));
    entry.frame = this.frame;
    return entry.state;
  }
  /** The state of view `id` (`RenderView.id`; 0 for the plain frame), if it has one. */
  find(id) {
    return this.states.get(id)?.state;
  }
  /** Every state. */
  *values() {
    for (const entry of this.states.values()) yield entry.state;
  }
  /** States of the views drawn since the last `prune`, in first-drawn order. */
  *drawn() {
    for (const entry of this.states.values()) if (entry.frame === this.frame) yield entry.state;
  }
  prune() {
    for (const [key, entry] of this.states)
      if (entry.frame < this.frame) {
        this.states.delete(key);
        this.release(entry.state);
      }
    this.frame++;
  }
  clear() {
    for (const entry of this.states.values()) this.release(entry.state);
    this.states.clear();
  }
}

/**
 * Remaps clip-space matrices between a view and its whole target. Rasterization applies the viewport after
 * projection, so a pass that samples full-target textures needs `toTarget` on a view-projection (a previous camera
 * reprojected into this view's pixels) and `fromTarget` on an inverse view-projection (full-target NDC back to world).
 * Both edit the 4x4 column-major matrix at `offset` in place; no-ops without a view.
 */
export function toTarget(context, matrix, offset = 0) {
  const rect = viewRect(context);
  if (!rect) return;
  const [x, y, width, height] = rect,
    sx = width / context.width,
    sy = height / context.height,
    tx = (2 * x + width) / context.width - 1,
    ty = 1 - (2 * y + height) / context.height;
  for (let column = 0; column < 4; column++) {
    const i = offset + column * 4,
      w = matrix[i + 3];
    matrix[i] = matrix[i] * sx + w * tx;
    matrix[i + 1] = matrix[i + 1] * sy + w * ty;
  }
}
export function fromTarget(context, matrix, offset = 0) {
  const rect = viewRect(context);
  if (!rect) return;
  const [x, y, width, height] = rect,
    sx = context.width / width,
    sy = context.height / height,
    tx = (context.width - 2 * x - width) / width,
    ty = (2 * y + height - context.height) / height;
  for (let row = 0; row < 4; row++) {
    const i = offset + row,
      a = matrix[i],
      b = matrix[i + 4];
    matrix[i + 12] += a * tx + b * ty;
    matrix[i] = a * sx;
    matrix[i + 4] = b * sy;
  }
}
