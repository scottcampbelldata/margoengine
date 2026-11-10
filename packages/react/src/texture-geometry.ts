import type { Geometry } from '@margoengine/core/extension';
import type { MeshGeometry } from '@margoengine/materials';
/** React geometry bindings preserve UVs separately from the frozen core geometry layout. */
export const geometrySources = new WeakMap<Geometry, MeshGeometry | (() => MeshGeometry)>();
