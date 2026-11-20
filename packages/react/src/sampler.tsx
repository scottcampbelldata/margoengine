import { forwardRef, useEffect, useRef, useState, type RefObject } from 'react';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import type { SurfacePoints } from '@margoengine/geometry/sample';
import type { Vec3 } from '@margoengine/math';
import type { MeshRef } from './components.js';
import { Instance, Instances, type InstancesProps } from './instances.js';
import { subscribeFrame } from './frame-priority.js';
import { report, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';
import { rangeError } from '../../shared/errors.js';

/** What `useSurfaceSampler` samples: a core geometry, a mesh, or a ref to one (read once the ref is set). */
export type SamplerSource = Geometry | EngineMesh | RefObject<EngineMesh | MeshRef | null> | null | undefined;
/** Options of `useSurfaceSampler`; every one is optional. */
export interface SurfaceSamplerOptions {
  /** One density of at least 0 per vertex. Default: even over the area. */
  weights?: ArrayLike<number>;
  /** Vertex colours, 3 or 4 values per vertex, interpolated into the samples. Default white. */
  colors?: ArrayLike<number>;
  /** Seed of the generator, so the same mesh gives the same points. Default 1. */
  seed?: number;
  onError?: (error: unknown) => void;
}
/** One sampled point, handed to `<Sampler transform>`. */
export interface SamplerPoint {
  index: number;
  position: [number, number, number];
  /** Unit surface normal. */
  normal: [number, number, number];
  uv: [number, number];
  color: [number, number, number, number];
  /** Euler XYZ radians that turn an instance's +Y onto `normal`. */
  rotation: [number, number, number];
}
/** The transform `<Sampler transform>` returns for an instance; omitted parts keep the default. */
export interface SamplerTransform {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  color?: string | readonly number[];
}
/** Props of `<Sampler>`: the props of `<Instances>` plus the surface to sample. */
export interface SamplerProps extends Omit<InstancesProps, 'limit' | 'range'>, Omit<SurfaceSamplerOptions, 'onError'> {
  /** The surface: a ref to a `<Mesh>`, a native mesh or a core geometry. Required. */
  mesh: SamplerSource;
  /** Number of points. Default 16. */
  count?: number;
  /** Instance placement per point. Default: at the point, upright, scale 1. */
  transform?: (point: SamplerPoint) => SamplerTransform;
  onError?: (error: unknown) => void;
}
function geometryOf(source: SamplerSource): Geometry | null {
  if (!source) return null;
  if ('vertices' in source) return source;
  const mesh = 'current' in source ? (source as RefObject<EngineMesh | MeshRef | null>).current : source;
  return (mesh as EngineMesh | null)?.geometry ?? null;
}
// Euler XYZ (R = Rx Ry Rz) of the shortest rotation from +Y to the unit vector n.
function alignY(nx: number, ny: number, nz: number): [number, number, number] {
  let x = nz,
    y = 0,
    z = -nx,
    w = 1 + ny;
  if (w < 1e-6) [x, y, z, w] = [1, 0, 0, 0];
  const l = Math.hypot(x, y, z, w);
  x /= l;
  y /= l;
  z /= l;
  w /= l;
  const m11 = 1 - 2 * (y * y + z * z),
    m12 = 2 * (x * y - z * w),
    m13 = 2 * (x * z + y * w),
    m23 = 2 * (y * z - x * w),
    m33 = 1 - 2 * (x * x + y * y);
  return [Math.atan2(-m23, m33), Math.asin(Math.max(-1, Math.min(1, m13))), Math.atan2(-m12, m11)];
}
/**
 * drei's useSurfaceSampler: `count` random points on a mesh surface by `@margoengine/geometry/sample` (area-weighted,
 * or by per-vertex `weights`), in the mesh's own space, with normals, UVs and colours. Null until the geometry and
 * the package are there; the same seed gives the same points.
 */
export function useSurfaceSampler(
  source: SamplerSource,
  count = 16,
  options: SurfaceSamplerOptions = {},
): SurfacePoints | null {
  if (!Number.isSafeInteger(count) || count < 0)
    throw rangeError('Sampler count must be a nonnegative integer; pass the number of points', 'react-arguments');
  const scene = useScene(),
    [points, setPoints] = useState<SurfacePoints | null>(null),
    [geometry, setGeometry] = useState<Geometry | null>(() => geometryOf(source)),
    latest = useRef(options);
  latest.current = options;
  // A ref is set after its mesh commits, and a shape's geometry may arrive later or be replaced: look each frame.
  const current = useRef(geometry);
  current.current = geometry;
  useEffect(() => {
    const look = () => {
      const found = geometryOf(source);
      if (found !== current.current) setGeometry((current.current = found));
    };
    look();
    return subscribeFrame(scene.frames, look);
  }, [scene.frames, source]);
  const { weights, colors, seed } = options;
  useEffect(() => {
    if (!geometry) {
      setPoints(null);
      return;
    }
    let active = true;
    optionalPeer('@margoengine/geometry', () => import('@margoengine/geometry/sample'))
      .then((api) => {
        if (!active) return;
        const v = geometry.vertices,
          vertices = v.length / 6,
          positions = new Float32Array(vertices * 3),
          normals = new Float32Array(vertices * 3);
        for (let i = 0; i < vertices; i++) {
          positions.set(v.subarray(i * 6, i * 6 + 3), i * 3);
          normals.set(v.subarray(i * 6 + 3, i * 6 + 6), i * 3);
        }
        const saved = geometrySources.get(geometry),
          data = typeof saved === 'function' ? saved() : saved,
          uvs = data?.uvs ? Float32Array.from(data.uvs) : new Float32Array(vertices * 2),
          sampler = new api.MeshSurfaceSampler(
            { positions, normals, uvs, indices: Uint32Array.from(geometry.indices) },
            { weights, colors: colors ?? data?.colors, seed },
          );
        setPoints(sampler.samplePoints(count));
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
    };
  }, [scene, geometry, count, weights, colors, seed]);
  return points;
}
function point(points: SurfacePoints, index: number): SamplerPoint {
  const p = points.positions,
    n = points.normals,
    i = index * 3;
  return {
    index,
    position: [p[i], p[i + 1], p[i + 2]],
    normal: [n[i], n[i + 1], n[i + 2]],
    uv: [points.uvs[index * 2], points.uvs[index * 2 + 1]],
    color: [...points.colors.subarray(index * 4, index * 4 + 4)] as [number, number, number, number],
    rotation: alignY(n[i], n[i + 1], n[i + 2]),
  };
}
/**
 * drei's Sampler: `count` instances of the geometry and material children scattered over the surface of `mesh`, one
 * instanced draw (`<Instances>`). Each sits at its point, upright, unless `transform` places it; give `rotation` from
 * the point to stand it on the surface. The points are in the mesh's own space, so give the Sampler that mesh's
 * transform (or put both in one group).
 */
export const Sampler = /* @__PURE__ */ forwardRef<MeshRef, SamplerProps>(function Sampler(
  { mesh, count = 16, weights, colors, seed, transform, onError, children, ...props },
  ref,
) {
  const points = useSurfaceSampler(mesh, count, { weights, colors, seed, onError }),
    placed = points ? Array.from({ length: points.positions.length / 3 }, (_, i) => point(points, i)) : [];
  return (
    <Instances {...props} ref={ref} limit={Math.max(1, count)}>
      {children}
      {placed.map((p) => {
        const t = transform ? transform(p) : {};
        return (
          <Instance
            key={p.index}
            position={t.position ?? p.position}
            rotation={t.rotation}
            scale={t.scale}
            color={t.color}
          />
        );
      })}
    </Instances>
  );
});
