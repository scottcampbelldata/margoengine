import { forwardRef, useEffect, useRef } from 'react';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { ProductCaustics, ProductCausticsOptions } from '@margoengine/studio/caustics';
import type { Vec3 } from '@margoengine/math';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { subscribeFrame } from './frame-priority.js';
import { live, report, useMesh, useScene, type Scene } from './internal.js';
import { inScene } from './scene-owner.js';
import { optionalPeer } from './optional.js';

/** Props of `<Caustics>`: the caustic catcher of `@margoengine/studio/caustics` and mesh props, every one optional. */
export interface CausticsProps
  extends MeshProps,
    Omit<ProductCausticsOptions, 'geometry' | 'position' | 'signal' | 'color'> {
  /** Floor centre in world units. Default: the group's world position. */
  floor?: Vec3;
  /** Linear rgb tint of the caustics, 0..1. Default white. */
  color?: Vec3;
  /** Called with the native catcher once it is attached (for `readMap`, `stats`, `invalidate`). */
  onReady?: (caustics: ProductCaustics) => void;
  onError?: (error: unknown) => void;
}
const descendant = (scene: Scene, mesh: EngineMesh, root: EngineMesh) => {
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++)
    if (id === root.id) return true;
  return false;
};
// The children's triangles in world space, and a key that changes when a mesh, its geometry or its matrix does.
function worldTriangles(
  scene: Scene,
  root: EngineMesh,
): { key: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array } | null {
  const meshes = [...scene.engine.meshes.values()].filter(
    (m) => m !== root && m.visible && m.geometry && descendant(scene, m, root),
  );
  if (!meshes.length) return null;
  let vertices = 0,
    triangles = 0;
  const parts: string[] = [];
  for (const m of meshes) {
    vertices += m.geometry!.vertices.length / 6;
    triangles += m.geometry!.indices.length;
    parts.push(String(m.id), String(geometryId(m.geometry!)), Array.prototype.join.call(m.matrix, ','));
  }
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    indices = new Uint32Array(triangles);
  let v = 0,
    t = 0;
  for (const m of meshes) {
    const g = m.geometry!,
      x = m.matrix,
      count = g.vertices.length / 6;
    for (let i = 0; i < count; i++) {
      const s = g.vertices,
        o = i * 6,
        [px, py, pz, nx, ny, nz] = [s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5]];
      for (let a = 0; a < 3; a++) {
        positions[(v + i) * 3 + a] = x[a] * px + x[a + 4] * py + x[a + 8] * pz + x[a + 12];
        normals[(v + i) * 3 + a] = x[a] * nx + x[a + 4] * ny + x[a + 8] * nz;
      }
    }
    for (let i = 0; i < g.indices.length; i++) indices[t + i] = g.indices[i] + v;
    v += count;
    t += g.indices.length;
  }
  return { key: parts.join('|'), positions, normals, indices };
}
const ids = new WeakMap<object, number>();
let nextId = 0;
function geometryId(geometry: object): number {
  let id = ids.get(geometry);
  if (id === undefined) ids.set(geometry, (id = ++nextId));
  return id;
}
function Catcher({
  options,
  onReady,
  onError,
}: {
  options: Omit<CausticsProps, keyof MeshProps | 'onReady' | 'onError'>;
  onReady?: (c: ProductCaustics) => void;
  onError?: (error: unknown) => void;
}) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef({ options, onReady, onError });
  latest.current = { options, onReady, onError };
  const key = JSON.stringify(options);
  // Live settings: a changed option restarts the cached map.
  const plugin = useRef<ProductCaustics | null>(null);
  useEffect(() => {
    const caustics = plugin.current;
    if (!caustics) return;
    const { floor, ...rest } = latest.current.options;
    Object.assign(caustics.options, rest, floor ? { position: floor } : {});
    caustics.invalidate();
  }, [key]);
  useEffect(() => {
    let active = true,
      attaching = false,
      seen = '',
      caustics: ProductCaustics | null = null;
    const controller = new AbortController(),
      fail = (error: unknown) => {
        if (active && !scene.engine.disposed && !(error instanceof DOMException && error.name === 'AbortError'))
          report(scene, error, latest.current.onError);
      };
    const look = () => {
      const root = live(registry);
      if (!root || attaching) return;
      scene.engine.store.tick(false);
      const found = worldTriangles(scene, root);
      if (!found || found.key === seen) return;
      seen = found.key;
      const geometry = { positions: found.positions, normals: found.normals, indices: found.indices };
      if (caustics) {
        caustics.setGeometry(geometry, { signal: controller.signal }).then(() => caustics?.invalidate(), fail);
        return;
      }
      attaching = true;
      optionalPeer('@margoengine/studio', () => import('@margoengine/studio/caustics'))
        .then(async (api) => {
          if (!active || scene.engine.disposed) return;
          const { floor, ...rest } = latest.current.options,
            m = root.matrix,
            made = await inScene(scene, () =>
              api.ProductCaustics.attach(scene.engine, {
                ...rest,
                geometry,
                position: floor ?? [m[12], m[13], m[14]],
                signal: controller.signal,
              }),
            );
          if (!active) {
            made.dispose();
            return;
          }
          caustics = plugin.current = made;
          latest.current.onReady?.(made);
        })
        .catch(fail)
        .finally(() => {
          attaching = false;
        });
    };
    const stop = subscribeFrame(scene.frames, look, -50);
    return () => {
      active = false;
      stop();
      controller.abort();
      caustics?.dispose();
      plugin.current = null;
    };
  }, [scene, registry]);
  return null;
}
/**
 * drei's Caustics: light focused through the transparent children onto a floor beneath them, by the photon-traced
 * catcher of `@margoengine/studio/caustics` (a GPU BVH and photon map). The children's world triangles are traced; it
 * re-traces when one moves or changes. Needs WebGPU or the WebGL2 compatibility layer.
 */
export const Caustics = /* @__PURE__ */ forwardRef<MeshRef, CausticsProps>(function Caustics(
  {
    floor,
    size,
    height,
    lightDirection,
    lightPosition,
    ior,
    backsideIOR,
    backside,
    maxEvents,
    photonSide,
    resolution,
    frames,
    worldRadius,
    intensity,
    color,
    onReady,
    onError,
    children,
    ...props
  },
  ref,
) {
  const options = Object.fromEntries(
    Object.entries({
      floor,
      size,
      height,
      lightDirection,
      lightPosition,
      ior,
      backsideIOR,
      backside,
      maxEvents,
      photonSide,
      resolution,
      frames,
      worldRadius,
      intensity,
      color,
    }).filter(([, v]) => v !== undefined),
  );
  return (
    <Mesh {...props} ref={ref}>
      <Catcher options={options} onReady={onReady} onError={onError} />
      {children}
    </Mesh>
  );
});
