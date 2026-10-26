import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import type { Engine, Mesh } from '@margoengine/core/extension';
/**
 * Finds parts of one engine by name pattern or tag, and shows or hides a subtree. Names are read at construction and
 * `refresh()`; tags are yours. Lookups can be limited to the subtree under a `root` mesh.
 *
 * @example
 * ```ts
 * const index = new AssemblyIndex(engine);
 * index.tag(lid, 'cover');
 * const bolts = index.findChildrenByName('Bolt*');
 * ```
 */
export class AssemblyIndex {
  private readonly names = new Map<string, Set<Mesh>>();
  private readonly tags = new Map<string, Set<Mesh>>();
  private readonly engine: Engine;
  constructor(engine: EngineKernel) {
    this.engine = engineRuntime(engine);
    this.refresh();
  }
  /** Reads mesh names again and forgets tags of disposed meshes; call it after renaming, adding or disposing meshes. */
  refresh(): void {
    this.names.clear();
    for (const node of this.engine.meshes.values()) {
      const group = this.names.get(node.name) ?? new Set<Mesh>();
      group.add(node);
      this.names.set(node.name, group);
    }
    for (const group of this.tags.values())
      for (const node of group) if (this.engine.meshes.get(node.id) !== node) group.delete(node);
  }
  /** Adds `tag` (a non-empty string of at most 256 characters) to a mesh of this engine. */
  tag(handle: MeshHandle, tag: string): void {
    const node = meshRuntime(handle);
    node.check();
    if (node.engine !== this.engine || typeof tag !== 'string' || !tag || tag.length > 256)
      throw new TypeError(
        'Assembly tag must be a non-empty string of at most 256 characters, on a mesh of this engine; pass a short tag and a mesh from the same engine.',
      );
    const group = this.tags.get(tag) ?? new Set<Mesh>();
    group.add(node);
    this.tags.set(tag, group);
  }
  /** Removes `tag` from a mesh; nothing happens if it was not tagged. */
  untag(node: MeshHandle, tag: string): void {
    this.tags.get(tag)?.delete(meshRuntime(node));
  }
  private within(node: Mesh, handle?: MeshHandle): boolean {
    const root = handle ? meshRuntime(handle) : undefined;
    if (this.engine.meshes.get(node.id) !== node) return false;
    if (!root) return true;
    root.check();
    if (root.engine !== this.engine)
      throw new TypeError(
        'Assembly root belongs to another engine; pass a mesh created by the engine of this AssemblyIndex.',
      );
    for (let id = node.id, depth = 0; id !== -1 && depth < 64; id = this.engine.store.parents[id], depth++)
      if (id === root.id) return true;
    return false;
  }
  /** Meshes whose name matches `pattern` (`*` matches any run of characters, everything else is literal), optionally only under `root`. */
  findChildrenByName(pattern: string, root?: MeshHandle): MeshHandle[] {
    if (typeof pattern !== 'string' || pattern.length > 256)
      throw new TypeError(
        'Name pattern must be a string of at most 256 characters; pass a shorter pattern, with * as the wildcard.',
      );
    const expression = new RegExp(
        '^' +
          pattern
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') +
          '$',
      ),
      found: Mesh[] = [];
    for (const [name, nodes] of this.names)
      if (expression.test(name)) for (const node of nodes) if (this.within(node, root)) found.push(node);
    return found;
  }
  /** Meshes carrying `tag`, optionally only under `root`; an unknown tag gives an empty list. */
  findByTag(tag: string, root?: MeshHandle): MeshHandle[] {
    return [...(this.tags.get(tag) ?? [])].filter((node) => this.within(node, root));
  }
  /** Shows or hides `handle` and, through it, its children. */
  setSubtreeVisible(handle: MeshHandle, visible: boolean): void {
    const root = meshRuntime(handle);
    root.check();
    if (root.engine !== this.engine)
      throw new TypeError(
        'Assembly root belongs to another engine; pass a mesh created by the engine of this AssemblyIndex.',
      );
    root.visible = visible;
  }
}
