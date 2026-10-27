// The render-layer registry core reads (`maskOf`, `cameras`, `source`) and @margoengine/environment's captures read
// too: one object on `globalThis`, so every copy of this module (in @margoengine/cameras/layers and in the React
// bindings' `<Mesh layers>`) shares it. Keep the shape.
import { checkLayers } from './view-rect.js';

const KEY = Symbol.for('margoengine.layers');

/** The registry, created on first use. */
export function renderLayers() {
  return (globalThis[KEY] ??= {
    masks: new WeakMap(),
    cameras: new WeakMap(),
    source: null,
    used: false,
    maskOf(mesh) {
      if (this.source) return this.source(mesh) >>> 0;
      if (!this.used) return 1;
      // A mesh without its own mask takes its nearest ancestor's, so a model is layered by its root.
      let current = mesh;
      for (let depth = 0; current && depth < 64; depth++) {
        const own = this.masks.get(current);
        if (own !== undefined) return own;
        const parent = current.engine.store.parents[current.id];
        current = parent >= 0 ? current.engine.meshes.get(parent) : undefined;
      }
      return 1;
    },
  });
}

/** Sets the layer mask of `mesh`; see `setRenderLayers` in @margoengine/cameras/layers. */
export function setRenderLayers(mesh, mask) {
  const registry = renderLayers();
  registry.masks.set(mesh, checkLayers(mask, 'Render layer mask'));
  registry.used = true;
  // Engine views cache their instance lists: collect again on the next draw. A structural mesh (a raycast-only
  // object in a tool or test) has no engine.
  if (mesh.engine) mesh.engine.collected = -1;
}
