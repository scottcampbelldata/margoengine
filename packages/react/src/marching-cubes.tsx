import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Geometry, Mesh as EngineMesh } from '@margoengine/core/extension';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import type { Vec3 } from '@margoengine/math';
import { Mesh, PbrMaterial, type MeshProps, type MeshRef } from './components.js';
import { subscribeFrame } from './frame-priority.js';
import { live, report, setGeometry, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';
import { fault, rangeError } from '../../shared/errors.js';

/**
 * A live metaball of `<MarchingCubes>`, the ref of `<MarchingCube>`. Its values are read every frame: write them in
 * place (in `useFrame`, say) and the surface is rebuilt on frames where one changed.
 */
export interface MarchingCubeHandle {
  /** Centre in the field's space, -1..1 on each axis. */
  readonly position: [number, number, number];
  strength: number;
  subtract: number;
  /** Linear rgb, or null for no colour of its own. */
  color: [number, number, number] | null;
}
/** A live plane of `<MarchingCubes>`, the ref of `<MarchingPlane>`. */
export interface MarchingPlaneHandle {
  planeType: 'x' | 'y' | 'z';
  strength: number;
  subtract: number;
}
/** Props of `<MarchingCube>`; every one is optional. */
export interface MarchingCubeProps {
  /** Centre in the field's space, -1..1 on each axis (the field fills the mesh's -1..1 cube). Default [0, 0, 0]. */
  position?: Vec3;
  /** Field strength: larger is a bigger ball. Default 0.5. */
  strength?: number;
  /** Fall-off: the ball's field ends where strength / d^2 drops to this (d in units of the field's width). Default 12. */
  subtract?: number;
  /** Colour blended into the vertex colours by field weight (hex, number or linear rgb). Default none. */
  color?: ColorInput;
}
/** Props of `<MarchingPlane>`; every one is optional. */
export interface MarchingPlaneProps {
  /** The field's low face this plane lies on: 'x' (-x), 'y' (-y, a floor) or 'z' (-z). Default 'x'. */
  planeType?: 'x' | 'y' | 'z';
  /** Default 0.5. */
  strength?: number;
  /** Default 12. */
  subtract?: number;
}
/** Props of `<MarchingCubes>`: mesh props plus the field's grid, every one optional. */
export interface MarchingCubesProps extends MeshProps {
  /** Grid samples per axis, 3..128. Default 28. */
  resolution?: number;
  /** Field value of the surface. Default 80. */
  isolation?: number;
  /** Matte colour when no material child is given. Default '#ffffff'. */
  color?: string | readonly number[];
  /** Most triangles kept, an integer from 1; the rest of an extraction is dropped. Default 10000, as drei's. */
  maxPolyCount?: number;
  /** Write uvs, the vertex x and z mapped from -1..1 to 0..1. Default false, as drei's. */
  enableUvs?: boolean;
  /** Write vertex colours from the balls' `color` (white where none reaches). Default false, as drei's. */
  enableColors?: boolean;
  children?: ReactNode;
  onError?: (error: unknown) => void;
}
interface Field {
  cubes: Set<MarchingCubeHandle>;
  planes: Set<MarchingPlaneHandle>;
}
const FieldContext = /* @__PURE__ */ createContext<Field | null>(null);
function useField(name: string): Field {
  const field = useContext(FieldContext);
  if (!field) throw fault('state', `${name} requires MarchingCubes; place it inside a <MarchingCubes>`, 'react-usage');
  return field;
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw rangeError(`MarchingCubes ${name} must be a finite number`, 'react-arguments');
  return value;
}
const axes = { x: 0, y: 1, z: 2 } as const;
// The metaball field, drei's: each ball adds strength / d^2 - subtract where that is positive, d measured in units of
// the field's width (the -1..1 cube is 1 wide). Planes add the same of the distance to their face. The fields sum and
// the surface is where the sum equals isolation, as for Blinn's (1982) blobby molecules and Wyvill, McPheeters and
// Wyvill's (1986) soft objects; the falloff is neither Blinn's Gaussian nor Wyvill's r^6 polynomial with C'(R) = 0,
// so a ball's field ends at d = sqrt(strength / subtract) with a kink in its slope. The sampled grid holds
// isolation - field, so the inside is negative.
function sampleGrid(
  grid: Float32Array,
  n: number,
  isolation: number,
  cubes: Iterable<MarchingCubeHandle>,
  planes: Iterable<MarchingPlaneHandle>,
): void {
  grid.fill(isolation);
  const step = 1 / (n - 1);
  for (const ball of cubes) {
    if (ball.strength <= 0 || ball.subtract <= 0) continue;
    const reach = Math.sqrt(ball.strength / ball.subtract),
      c = ball.position.map((v) => (v + 1) / 2),
      lo = c.map((v) => Math.max(0, Math.floor((v - reach) / step))),
      hi = c.map((v) => Math.min(n - 1, Math.ceil((v + reach) / step)));
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let y = lo[1]; y <= hi[1]; y++) {
        const dz = z * step - c[2],
          dy = y * step - c[1],
          row = (z * n + y) * n;
        for (let x = lo[0]; x <= hi[0]; x++) {
          const dx = x * step - c[0],
            value = ball.strength / (dx * dx + dy * dy + dz * dz + 1e-6) - ball.subtract;
          if (value > 0) grid[row + x] -= value;
        }
      }
  }
  for (const plane of planes) {
    if (plane.strength <= 0 || plane.subtract <= 0) continue;
    const axis = axes[plane.planeType],
      reach = Math.min(n - 1, Math.ceil(Math.sqrt(plane.strength / plane.subtract) / step));
    for (let i = 0; i < n * n * n; i++) {
      const at = axis === 0 ? i % n : axis === 1 ? Math.floor(i / n) % n : Math.floor(i / (n * n));
      if (at > reach) continue;
      const d = at * step,
        value = plane.strength / (d * d + 1e-6) - plane.subtract;
      if (value > 0) grid[i] -= value;
    }
  }
}
// Unit normals: the gradient of isolation - field at each vertex (Lorensen and Cline 1987, eq. 1: the surface normal is
// the field's gradient, which they estimate by central differences of sampled data; the field here is known, so it is
// taken exactly). Where the gradient vanishes the extractor's grid normal stays.
function fieldNormals(
  positions: Float32Array,
  normals: Float32Array,
  cubes: readonly MarchingCubeHandle[],
  planes: readonly MarchingPlaneHandle[],
): void {
  for (let i = 0; i < positions.length; i += 3) {
    const g = [0, 0, 0];
    for (const ball of cubes) {
      if (ball.strength <= 0 || ball.subtract <= 0) continue;
      const d = [0, 1, 2].map((a) => (positions[i + a] - ball.position[a]) / 2),
        q = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + 1e-6;
      if (ball.strength / q <= ball.subtract) continue;
      for (let a = 0; a < 3; a++) g[a] += (2 * ball.strength * d[a]) / (q * q);
    }
    for (const plane of planes) {
      if (plane.strength <= 0 || plane.subtract <= 0) continue;
      const a = axes[plane.planeType],
        d = (positions[i + a] + 1) / 2,
        q = d * d + 1e-6;
      if (plane.strength / q > plane.subtract) g[a] += (2 * plane.strength * d) / (q * q);
    }
    const length = Math.hypot(g[0], g[1], g[2]);
    if (length > 0) for (let a = 0; a < 3; a++) normals[i + a] = g[a] / length;
  }
}
// Vertex colours: the coloured balls' colours weighted by their field at each vertex; white where none reaches.
function vertexColors(positions: Float32Array, cubes: readonly MarchingCubeHandle[]): Float32Array {
  const count = positions.length / 3,
    out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let r = 0,
      g = 0,
      b = 0,
      total = 0;
    for (const ball of cubes) {
      const dx = (positions[i * 3] - ball.position[0]) / 2,
        dy = (positions[i * 3 + 1] - ball.position[1]) / 2,
        dz = (positions[i * 3 + 2] - ball.position[2]) / 2,
        w = Math.max(0, ball.strength / (dx * dx + dy * dy + dz * dz + 1e-6) - ball.subtract);
      if (!w || !ball.color) continue;
      r += ball.color[0] * w;
      g += ball.color[1] * w;
      b += ball.color[2] * w;
      total += w;
    }
    if (total) out.set([r / total, g / total, b / total], i * 3);
    else out.set([1, 1, 1], i * 3);
  }
  return out;
}
// The first `max` triangles of `indices` and only the vertices they use, renumbered in order of first use.
function keepTriangles(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  max: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const kept = indices.slice(0, max * 3),
    map = new Int32Array(positions.length / 3).fill(-1);
  let count = 0;
  for (let i = 0; i < kept.length; i++) {
    if (map[kept[i]] < 0) map[kept[i]] = count++;
    kept[i] = map[kept[i]];
  }
  const p = new Float32Array(count * 3),
    n = new Float32Array(count * 3);
  for (let old = 0; old < map.length; old++)
    if (map[old] >= 0) {
      p.set(positions.subarray(old * 3, old * 3 + 3), map[old] * 3);
      n.set(normals.subarray(old * 3, old * 3 + 3), map[old] * 3);
    }
  return { positions: p, normals: n, indices: kept };
}
function Surface({
  field,
  resolution,
  isolation,
  maxPolyCount,
  enableUvs,
  enableColors,
  onError,
}: {
  field: Field;
  resolution: number;
  isolation: number;
  maxPolyCount: number;
  enableUvs: boolean;
  enableColors: boolean;
  onError?: (error: unknown) => void;
}) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(onError);
  latest.current = onError;
  useEffect(() => {
    let active = true,
      geometry: Geometry | null = null,
      signature = new Float64Array(0),
      stop: (() => void) | undefined;
    const grid = new Float32Array(resolution ** 3),
      attach = (mesh: EngineMesh) => setGeometry(registry, mesh, geometry);
    optionalPeer('@margoengine/procedural', () => import('@margoengine/procedural'))
      .then((api) => {
        if (!active || scene.engine.disposed) return;
        const rebuild = () => {
          const cubes = [...field.cubes],
            planes = [...field.planes],
            next = new Float64Array(cubes.length * 8 + planes.length * 3 + 1);
          let k = 0;
          next[k++] = cubes.length;
          for (const c of cubes)
            next.set([...c.position, c.strength, c.subtract, ...(c.color ?? [-1, -1, -1])], (k += 8) - 8);
          for (const p of planes) next.set([axes[p.planeType], p.strength, p.subtract], (k += 3) - 3);
          if (next.length === signature.length && next.every((v, i) => v === signature[i])) return;
          signature = next;
          for (const c of cubes) for (const v of [...c.position, c.strength, c.subtract]) finite(v, 'ball values');
          sampleGrid(grid, resolution, isolation, cubes, planes);
          let made = api.marchingCubes(grid, {
            resolution: [resolution, resolution, resolution],
          }) as unknown as Geometry | null;
          if (made) {
            const v = made.vertices,
              count = v.length / 6;
            let positions: Float32Array = new Float32Array(count * 3),
              normals: Float32Array = new Float32Array(count * 3),
              indices: Uint32Array = made.indices;
            for (let i = 0; i < count; i++) {
              positions.set(v.subarray(i * 6, i * 6 + 3), i * 3);
              normals.set(v.subarray(i * 6 + 3, i * 6 + 6), i * 3);
            }
            fieldNormals(positions, normals, cubes, planes);
            if (indices.length > maxPolyCount * 3) {
              ({ positions, normals, indices } = keepTriangles(positions, normals, indices, maxPolyCount));
              // The extractor's own Geometry class (core's), so this entry adds no runtime import of core.
              made = new (made.constructor as typeof Geometry)(positions, normals, indices);
            } else for (let i = 0; i < count; i++) v.set(normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
            let uvs: Float32Array | undefined;
            if (enableUvs) {
              uvs = new Float32Array((positions.length / 3) * 2);
              for (let i = 0; i < uvs.length / 2; i++) {
                uvs[i * 2] = (positions[i * 3] + 1) / 2;
                uvs[i * 2 + 1] = (positions[i * 3 + 2] + 1) / 2;
              }
            }
            geometrySources.set(made, {
              positions,
              normals,
              indices,
              ...(uvs && { uvs }),
              ...(enableColors && { colors: vertexColors(positions, cubes) }),
            });
          }
          geometry = made;
          const mesh = live(registry);
          if (mesh) attach(mesh);
        };
        const guarded = () => {
          try {
            rebuild();
          } catch (error) {
            report(scene, error, latest.current);
          }
        };
        registry.attachments.add(attach);
        guarded();
        stop = subscribeFrame(scene.frames, guarded, -50);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current);
      });
    return () => {
      active = false;
      stop?.();
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && geometry && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [scene, registry, field, resolution, isolation, maxPolyCount, enableUvs, enableColors]);
  return null;
}
/**
 * drei's MarchingCubes: a metaball surface from the `<MarchingCube>` and `<MarchingPlane>` children, extracted by
 * `marchingCubes` of `@margoengine/procedural` over the mesh's -1..1 cube (scale the mesh to size it) and rebuilt on
 * frames where a ball moved. A material child replaces the matte default; with `enableColors` and coloured balls, a
 * `<TextureMaterial>` child shows their blended vertex colours.
 */
export const MarchingCubes = /* @__PURE__ */ forwardRef<MeshRef, MarchingCubesProps>(function MarchingCubes(
  {
    resolution = 28,
    isolation = 80,
    color = '#ffffff',
    maxPolyCount = 10000,
    enableUvs = false,
    enableColors = false,
    onError,
    children,
    ...props
  },
  ref,
) {
  if (!Number.isInteger(resolution) || resolution < 3 || resolution > 128)
    throw rangeError('MarchingCubes resolution must be an integer from 3 to 128', 'react-arguments');
  if (!Number.isSafeInteger(maxPolyCount) || maxPolyCount < 1)
    throw rangeError('MarchingCubes maxPolyCount must be a whole number of at least 1', 'react-arguments');
  finite(isolation, 'isolation');
  const [field] = useState<Field>(() => ({ cubes: new Set(), planes: new Set() }));
  return (
    <Mesh {...props} ref={ref}>
      <Surface
        field={field}
        resolution={resolution}
        isolation={isolation}
        maxPolyCount={maxPolyCount}
        enableUvs={enableUvs === true}
        enableColors={enableColors === true}
        onError={onError}
      />
      <PbrMaterial color={color} />
      <FieldContext.Provider value={field}>{children}</FieldContext.Provider>
    </Mesh>
  );
});
const origin: Vec3 = [0, 0, 0];
/** drei's MarchingCube: one metaball of the parent `<MarchingCubes>`; its ref is a live handle. */
export const MarchingCube = /* @__PURE__ */ forwardRef<MarchingCubeHandle, MarchingCubeProps>(function MarchingCube(
  { position = origin, strength = 0.5, subtract = 12, color },
  ref,
) {
  const field = useField('MarchingCube'),
    [handle] = useState<MarchingCubeHandle>(() => ({ position: [0, 0, 0], strength, subtract, color: null }));
  handle.position[0] = position[0];
  handle.position[1] = position[1];
  handle.position[2] = position[2];
  handle.strength = strength;
  handle.subtract = subtract;
  handle.color = color === undefined ? null : (parseColor(color).slice(0, 3) as [number, number, number]);
  useImperativeHandle(ref, () => handle, [handle]);
  useEffect(() => {
    field.cubes.add(handle);
    return () => {
      field.cubes.delete(handle);
    };
  }, [field, handle]);
  return null;
});
/** drei's MarchingPlane: a field along one low face of the parent `<MarchingCubes>`; its ref is a live handle. */
export const MarchingPlane = /* @__PURE__ */ forwardRef<MarchingPlaneHandle, MarchingPlaneProps>(function MarchingPlane(
  { planeType = 'x', strength = 0.5, subtract = 12 },
  ref,
) {
  if (!(planeType in axes)) throw rangeError("MarchingPlane planeType must be 'x', 'y' or 'z'", 'react-arguments');
  const field = useField('MarchingPlane'),
    [handle] = useState<MarchingPlaneHandle>(() => ({ planeType, strength, subtract }));
  Object.assign(handle, { planeType, strength, subtract });
  useImperativeHandle(ref, () => handle, [handle]);
  useEffect(() => {
    field.planes.add(handle);
    return () => {
      field.planes.delete(handle);
    };
  }, [field, handle]);
  return null;
});
