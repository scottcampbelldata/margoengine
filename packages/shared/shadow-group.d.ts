import type { Mesh } from '@margoengine/core/extension';
/** True for a mesh that draws nothing itself and is no gltf/pbr primitive node: a group, or a model's root. */
export function isCasterGroup(runtime: object): runtime is Mesh;
/** The shadow casters below groups, kept in step once a frame (shared/shadow-group.js). */
export class CasterGroups<Handle extends object = object> {
  readonly size: number;
  readonly list: readonly { readonly group: Mesh }[];
  add(
    group: Mesh,
    register: (mesh: Mesh) => Handle,
    unregister: (handle: Handle) => void,
    gone: (handle: Handle) => boolean,
    casts: (mesh: Mesh) => boolean,
  ): () => void;
  has(group: Mesh): boolean;
  sync(): void;
  clear(): void;
}
