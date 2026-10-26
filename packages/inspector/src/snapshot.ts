import type { Engine, Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/** One mesh as saved: its place in the tree, transform, visibility and core PBR material values. */
export interface MeshSnapshot {
  /** Engine id; restore matches meshes by it. */
  id: number;
  name: string;
  /** Parent id, -1 for a root. Informational: restore does not reparent. */
  parent: number;
  visible: boolean;
  position: [number, number, number];
  /** Euler angles in the engine's units (radians). */
  rotation: [number, number, number];
  scale: [number, number, number];
  /** Core PBR material values; colour is linear RGB. Null for a mesh without a material. */
  material: { color: [number, number, number]; roughness: number; metalness: number; doubleSided: boolean } | null;
}

/** A saved scene: plain JSON, safe to `JSON.stringify` and keep in a file. */
export interface SceneSnapshot {
  format: 'margoengine.scene-snapshot';
  version: 1;
  meshes: MeshSnapshot[];
}

/** What `restoreSnapshot` did: meshes updated, and ids in the snapshot with no live mesh. */
export interface RestoreResult {
  applied: number;
  missing: number[];
}

const triple = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];

/**
 * The state of `meshes` as plain JSON: names, visibility, transforms and core PBR material values. Take it from an
 * inspector with `inspector.snapshot()`.
 */
export function snapshotMeshes(engine: Engine, meshes: Iterable<Mesh>): SceneSnapshot {
  const out: MeshSnapshot[] = [];
  for (const mesh of meshes) {
    const d = mesh.material?.data;
    out.push({
      id: mesh.id,
      name: mesh.name,
      parent: engine.store.parents[mesh.id],
      visible: mesh.visible,
      position: triple(mesh.position),
      rotation: triple(mesh.rotation),
      scale: triple(mesh.scale),
      material: d ? { color: [d[0], d[1], d[2]], roughness: d[4], metalness: d[5], doubleSided: !!d[6] } : null,
    });
  }
  return { format: 'margoengine.scene-snapshot', version: 1, meshes: out };
}

const finite3 = (v: unknown, what: string): v is [number, number, number] => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
    throw new TypeError(`Scene snapshot ${what} must be three finite numbers; save it again with snapshotMeshes`);
  return true;
};

/** Checks the shape of untrusted snapshot data and returns it typed. */
export function parseSnapshot(data: unknown): SceneSnapshot {
  const s = data as Partial<SceneSnapshot> | null;
  if (!s || typeof s !== 'object' || s.format !== 'margoengine.scene-snapshot')
    throw new TypeError('Not a scene snapshot; pass the object snapshotMeshes returned or its parsed JSON');
  if (s.version !== 1)
    throw new RangeError(`Scene snapshot version ${String(s.version)} is not supported; this build reads version 1`);
  if (!Array.isArray(s.meshes)) throw new TypeError('Scene snapshot needs a meshes array; save it again');
  for (const m of s.meshes as MeshSnapshot[]) {
    if (!m || !Number.isInteger(m.id) || typeof m.name !== 'string' || typeof m.visible !== 'boolean')
      throw new TypeError('Scene snapshot mesh needs an integer id, a name and visible; save it again');
    finite3(m.position, 'position');
    finite3(m.rotation, 'rotation');
    finite3(m.scale, 'scale');
    if (m.material !== null) {
      finite3(m.material?.color, 'material color');
      if (typeof m.material.doubleSided !== 'boolean')
        throw new TypeError('Scene snapshot material needs doubleSided true or false');
    }
  }
  return s as SceneSnapshot;
}

/**
 * Writes a snapshot's values onto the live meshes with the same ids and reports how many it updated. The whole
 * snapshot is checked before anything changes, so a bad file leaves the scene as it was. A shared material changes for
 * every mesh using it, as when editing it by hand.
 * @throws TypeError / RangeError for a malformed snapshot or a value the engine rejects (scale of 0, colour range),
 * MargoError `'state'` after `engine.dispose()`.
 */
export function restoreSnapshot(engine: Engine, snapshot: unknown): RestoreResult {
  if (engine.disposed) throw new MargoError('state', 'Engine is disposed; restore into a live engine');
  const parsed = parseSnapshot(snapshot),
    result: RestoreResult = { applied: 0, missing: [] },
    live: [Mesh, MeshSnapshot][] = [];
  for (const m of parsed.meshes) {
    const mesh = engine.meshes.get(m.id);
    if (mesh) live.push([mesh, m]);
    else result.missing.push(m.id);
  }
  // Rollback copy: a value the engine rejects part-way must not leave a half-restored scene.
  const before = live.map(([mesh]) => ({ mesh, state: snapshotMeshes(engine, [mesh]).meshes[0] }));
  try {
    for (const [mesh, m] of live) apply(mesh, m);
  } catch (error) {
    for (const { mesh, state } of before) apply(mesh, state);
    throw error;
  }
  result.applied = live.length;
  return result;
}

function apply(mesh: Mesh, m: MeshSnapshot): void {
  mesh.name = m.name;
  mesh.visible = m.visible;
  for (const [kind, v] of [
    ['position', m.position],
    ['rotation', m.rotation],
    ['scale', m.scale],
  ] as const) {
    mesh[kind].x = v[0];
    mesh[kind].y = v[1];
    mesh[kind].z = v[2];
  }
  if (m.material && mesh.material)
    mesh.material.set({
      color: m.material.color,
      roughness: m.material.roughness,
      metalness: m.material.metalness,
      doubleSided: m.material.doubleSided,
    });
}
