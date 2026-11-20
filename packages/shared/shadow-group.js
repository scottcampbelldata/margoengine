import { meshSource } from './mesh-source.js';

/** True for a mesh that draws nothing itself and is no gltf/pbr primitive node: a group, or a model's root. */
export const isCasterGroup = (runtime) => 'id' in runtime && !runtime.geometry && !meshSource(runtime);

/** A mesh that another source already casts: its handle is gone at once, so the walk asks again next frame. */
const skipped = { gone: true };

/**
 * The shadow casters below added nodes (`shadows.add(node)`): a group, a model's root, or a mesh with geometry (which
 * casts itself through its own source and its descendants through here). `sync()` runs once a frame before the casters
 * are read: it registers each mesh with geometry below the node, and each gltf/pbr model once, and unregisters what
 * left it, so a mesh parented later casts from the next frame and one reparented away stops. A node with nothing below
 * it, or below it only groups, adds nothing; no scan runs while no node was added, and a node with no children costs
 * one property read a frame.
 */
export class CasterGroups {
  list = [];
  rec = undefined;
  constructor() {
    // One function for every walk (a closure per frame and group would be garbage); `rec` is the group being walked.
    this.visit = (id) => {
      const rec = this.rec,
        child = rec.group.engine.meshes.get(id);
      if (!child) return;
      const model = child.geometry ? undefined : meshSource(child)?.model,
        key = child.geometry ? child : model;
      if (key) {
        let entry = rec.entries?.get(key);
        if (!entry) (rec.entries ??= new Map()).set(key, (entry = { handle: undefined, mark: 0 }));
        if (entry.mark !== rec.mark) {
          entry.mark = rec.mark;
          rec.seen++;
          if (!entry.handle || rec.gone(entry.handle)) entry.handle = rec.casts(child) ? skipped : rec.register(child);
        }
      }
      child.kids?.forEach(this.visit);
    };
    this.sweep = (entry, key, entries) => {
      if (entry.mark === this.rec.mark) return;
      entries.delete(key);
      this.rec.unregister(entry.handle);
    };
  }
  get size() {
    return this.list.length;
  }
  /**
   * Casts every mesh below `group`. `register(mesh)` adds one caster and returns its handle, `unregister(handle)`
   * removes it, `gone(handle)` says the owner dropped it already (its mesh was disposed), `casts(mesh)` says another
   * source casts it already (added by hand, or below another node), so it is not cast twice. Returns the remover.
   */
  add(group, register, unregister, gone, casts) {
    const rec = { group, register, unregister, gone, casts, entries: undefined, mark: 0, seen: 0 };
    this.list.push(rec);
    return () => {
      const index = this.list.indexOf(rec);
      if (index >= 0) {
        this.list.splice(index, 1);
        this.release(rec);
      }
    };
  }
  has(group) {
    return this.list.some((rec) => rec.group === group);
  }
  sync() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const rec = this.list[i],
        group = rec.group;
      if (group.engine.disposed || group.engine.meshes.get(group.id) !== group) {
        this.list.splice(i, 1);
        this.release(rec);
        continue;
      }
      if (!group.kids?.size && !rec.entries?.size) continue;
      rec.mark++;
      rec.seen = 0;
      this.rec = rec;
      group.kids?.forEach(this.visit);
      if (rec.entries && rec.entries.size > rec.seen) rec.entries.forEach(this.sweep);
    }
    this.rec = undefined;
  }
  /** Drops every caster of every group (the Shadows is disposed). */
  clear() {
    for (const rec of this.list) this.release(rec);
    this.list.length = 0;
  }
  release(rec) {
    if (!rec.entries) return;
    for (const entry of rec.entries.values()) if (entry.handle) rec.unregister(entry.handle);
    rec.entries.clear();
  }
}
