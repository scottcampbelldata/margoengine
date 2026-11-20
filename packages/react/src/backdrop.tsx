import { forwardRef, useEffect, useRef } from 'react';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import type { BackdropShape } from '@margoengine/studio/backdrop';
import { Mesh, PbrMaterial, type MeshProps, type MeshRef } from './components.js';
import { live, report, setGeometry, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';

/** Props of `<Backdrop>`: the cyclorama shape of `@margoengine/studio/backdrop` and mesh props, every one optional. */
export interface BackdropProps extends MeshProps, BackdropShape {
  /** Matte colour when no material child is given. Default '#b8b8b8'. */
  color?: string | readonly number[];
  onError?: (error: unknown) => void;
}
// UVs for texture materials: u across the width, v along the floor-to-wall profile by arc length (0 at the front edge).
function profileUVs(geometry: Geometry, width: number): Float32Array {
  const v = geometry.vertices,
    count = v.length / 6,
    uvs = new Float32Array(count * 2),
    along = new Float64Array(count / 2);
  for (let row = 1; row < count / 2; row++) {
    const a = (row - 1) * 12,
      b = row * 12;
    along[row] = along[row - 1] + Math.hypot(v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]);
  }
  const total = along[count / 2 - 1] || 1;
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = v[i * 6] / width + 0.5;
    uvs[i * 2 + 1] = along[i >> 1] / total;
  }
  return uvs;
}
function BackdropGeometry({ shape, onError }: { shape: BackdropShape; onError?: (error: unknown) => void }) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef({ shape, onError });
  latest.current = { shape, onError };
  const key = JSON.stringify(shape);
  useEffect(() => {
    let active = true,
      geometry: Geometry | undefined;
    const attach = (mesh: EngineMesh) => {
      if (geometry) setGeometry(registry, mesh, geometry);
    };
    optionalPeer('@margoengine/studio', () => import('@margoengine/studio/backdrop'))
      .then((api) => {
        if (!active || scene.engine.disposed) return;
        const made = api.backdropGeometry(latest.current.shape) as unknown as Geometry,
          v = made.vertices,
          count = v.length / 6,
          positions = new Float32Array(count * 3),
          normals = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          positions.set(v.subarray(i * 6, i * 6 + 3), i * 3);
          normals.set(v.subarray(i * 6 + 3, i * 6 + 6), i * 3);
        }
        geometrySources.set(made, {
          positions,
          normals,
          indices: made.indices,
          uvs: profileUVs(made, latest.current.shape.width ?? 8),
        });
        geometry = made;
        registry.attachments.add(attach);
        const mesh = live(registry);
        if (mesh) attach(mesh);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [scene.engine, registry, key]);
  return null;
}
/**
 * drei's Backdrop: a studio cyclorama, a floor that bends up into a wall with exact normals, from
 * `@margoengine/studio/backdrop`. The floor's front edge is at +z, the wall at -z; it receives shadows. A material child
 * (`<PbrMaterial>`, `<TextureMaterial>`, with UVs across and along the sweep) replaces the matte default.
 */
export const Backdrop = /* @__PURE__ */ forwardRef<MeshRef, BackdropProps>(function Backdrop(
  { width, depth, height, radius, segments, color = '#b8b8b8', onError, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <BackdropGeometry shape={{ width, depth, height, radius, segments }} onError={onError} />
      <PbrMaterial color={color} roughness={1} metalness={0} />
      {children}
    </Mesh>
  );
});
