import { forwardRef, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import { meshRuntime, type Geometry, type Mesh as RuntimeMesh } from '@margoengine/core/extension';
import type { PointCloud } from '@margoengine/points';
import type { Trail as NativeTrail, TrailOptions } from '@margoengine/lines/trail';
import type { LineOptions } from '@margoengine/lines';
import type { GeometryData } from '@margoengine/geometry';
import type { DecalGeometryOptions } from '@margoengine/geometry/extras';
import { Group, Mesh, GeometryResource, PbrMaterial, useFrame, type PbrMaterialProps } from './components.js';
import { Line } from './lines.js';
import { useCommit, useCreated, useScene, Context, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';
import { createField, type FieldOptions } from './effect-field.js';
import { geometrySources } from './texture-geometry.js';
import { TextureProvider } from './texture-material.js';

let serial = 0;
/** A repeatable twinkling spherical starfield, backed by native point clouds. */
export interface StarsProps extends Pick<FieldOptions, 'count' | 'seed' | 'radius' | 'depth' | 'saturation' | 'fade'> {
  count: number;
  factor?: number;
  speed?: number;
  onError?: (error: unknown) => void;
}
/** Bounded floating points; size, speed, opacity and RGB accept per-point Float32Arrays. */
export interface SparklesProps extends Omit<FieldOptions, 'kind' | 'radius' | 'depth' | 'saturation' | 'fade'> {
  onError?: (error: unknown) => void;
}
const pointOwners = new WeakMap<PointCloud, () => void>();
function Field({ options, onError, handle }: { options: FieldOptions; onError?: (error: unknown) => void; handle?: React.Ref<PointCloud> }) {
  const scene = useScene(), signature = JSON.stringify(options), data = useMemo(() => createField(options), [signature]);
  const cloud = useCreated(scene, {
    load: () => optionalPeer('@margoengine/points', () => import('@margoengine/points')),
    create(api) {
      const cloud = new api.PointCloud({ positions: data.positions, colors: data.colors, colorComponents: 4, colorFormat: 'float', sizes: data.sizes, material: { size: 1, minPixelSize: 0, shape: 'round', transparent: true, depthWrite: false, blending: 'additive', fog: false } });
      if (scene.registry?.current) cloud.attach(scene.registry.current);
      const plugin = new api.PointsPlugin({ name: `react-field:${++serial}` }); plugin.add(cloud); attachBinding(scene, plugin); pointOwners.set(cloud, () => detachBinding(scene, plugin)); return cloud;
    }, dispose(cloud) { pointOwners.get(cloud)?.(); cloud.dispose(); }, ref: handle, onError,
  }, [data, scene.world, scene.registry]);
  const elapsed = useRef(0);
  useCommit(() => { elapsed.current = 0; }, [data]);
  useFrame((_, delta) => { if (!cloud) return; elapsed.current += delta; data.step(elapsed.current); cloud.updateColors(0, data.colors, 4); if (options.kind === 'sparkles') cloud.updatePositions(0, data.positions); }, -2);
  return null;
}
/** Twinkle stars without importing a sky package or changing the scene camera. */
export const Stars = /* @__PURE__ */ forwardRef<PointCloud, Partial<StarsProps>>(function Stars({ count = 5000, factor = 4, speed = 1, onError, ...props }, ref) {
  return <Field handle={ref} onError={onError} options={{ ...props, count, kind: 'stars', size: factor, speed }} />;
});
/** Floating sparkles in the enclosing mesh's local space, rendered by the native points plugin. */
export const Sparkles = /* @__PURE__ */ forwardRef<PointCloud, Partial<SparklesProps>>(function Sparkles({ count = 100, onError, ...props }, ref) {
  return <Field handle={ref} onError={onError} options={{ ...props, count, kind: 'sparkles' }} />;
});

/** Native fading trail options, plus an optional child mesh to follow. */
export interface TrailProps extends TrailOptions {
  children?: ReactNode;
  onError?: (error: unknown) => void;
}
const trailOwners = new WeakMap<NativeTrail, () => void>();
function TrailBody({ options, handle, onError }: { options: TrailOptions; handle: React.Ref<NativeTrail>; onError?: (error: unknown) => void }) {
  const scene = useScene(), latest = useRef(options); latest.current = options;
  const trail = useCreated(scene, {
    load: () => optionalPeer('@margoengine/lines', () => Promise.all([import('@margoengine/lines'), import('@margoengine/lines/trail')]).then(([lines, trail]) => ({ ...lines, ...trail }))),
    create(api) { const trail = new api.Trail(options), plugin = new api.Lines({ name: `react-trail:${++serial}` }); plugin.add(trail); attachBinding(scene, plugin); trailOwners.set(trail, () => detachBinding(scene, plugin)); return trail; },
    dispose(trail) { trailOwners.get(trail)?.(); trail.dispose(); }, ref: handle, onError,
  }, [scene.world, scene.registry, JSON.stringify({ ...options, target: undefined }), options.target]);
  useFrame(() => { if (trail) trail.target = latest.current.target !== undefined ? latest.current.target : scene.registry?.children.values().next().value ?? scene.registry?.current ?? null; }, -3);
  return null;
}
/** Follow the first child or an explicit native target; native line options control fading and width. */
export const Trail = /* @__PURE__ */ forwardRef<NativeTrail, TrailProps>(function Trail({ children, onError, ...options }, ref) {
  return <Group><TrailBody options={options} handle={ref} onError={onError} />{children}</Group>;
});

function useSource(explicit?: MeshHandle | null) {
  const scene = useScene(), latest = useRef(explicit); latest.current = explicit;
  const [source, setSource] = useState<{ mesh: RuntimeMesh; geometry: Geometry } | null>(null);
  const sync = () => {
    const mesh = latest.current ? meshRuntime(latest.current) : scene.registry?.current;
    const geometry = mesh && (mesh === scene.registry?.current ? scene.registry.geometry ?? mesh.geometry : mesh.geometry);
    setSource(previous => mesh && geometry ? previous?.mesh === mesh && previous.geometry === geometry ? previous : { mesh, geometry } : previous === null ? previous : null);
  };
  useCommit(sync, [scene.registry, explicit]); useFrame(sync, -20);
  return { source, scene };
}
/** Native crease edges for the enclosing mesh or an explicit mesh. */
export interface EdgesProps extends Omit<LineOptions, 'positions' | 'mode'> {
  threshold?: number;
  tolerance?: number;
  onError?: (error: unknown) => void;
}
/** Extract welded crease/boundary edges and draw antialiased native line segments. */
export function Edges({ mesh, threshold = 15, tolerance, onError, ...options }: EdgesProps) {
  const { source, scene } = useSource(mesh);
  const points = useCreated(scene, { load: () => optionalPeer('@margoengine/lines', () => import('@margoengine/lines/edges')), create: api => source ? api.featureEdges(source.geometry, { angle: threshold, tolerance }) : null, dispose() {}, onError }, [source?.geometry, threshold, tolerance]);
  return points && source ? <Line {...options} points={points} segments mesh={source.mesh} onError={onError} /> : null;
}

/** Decal projector in the target mesh's local space, with all native material maps. */
export interface DecalProps extends PbrMaterialProps, DecalGeometryOptions {
  mesh?: MeshHandle;
  geometry?: GeometryData;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number] | readonly [number, number, number, number];
  scale?: number | readonly [number, number, number];
  children?: ReactNode;
  onError?: (error: unknown) => void;
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Clip a UV-bearing decal to native source triangles and retain the target's parent transform. */
export function Decal({ mesh, geometry: supplied, position = [0, 0, 0], rotation = [0, 0, 0], scale = 1, offset, backfaces, children, onError, ...material }: DecalProps) {
  const { source, scene } = useSource(mesh), at = JSON.stringify([position, rotation, scale, offset, backfaces]);
  const data = useCreated(scene, {
    load: () => optionalPeer('@margoengine/geometry', () => Promise.all([import('@margoengine/geometry'), import('@margoengine/geometry/extras')]).then(([geometry, extras]) => ({ ...geometry, ...extras }))),
    create(api) {
      if (!source) return null;
      let input = supplied;
      if (!input) {
        const saved = geometrySources.get(source.geometry), known = typeof saved === 'function' ? saved() : saved;
        if (known && 'normals' in known) input = known as GeometryData;
        else {
          const count = source.geometry.vertices.length / 6, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) { positions.set(source.geometry.vertices.subarray(i * 6, i * 6 + 3), i * 3); normals.set(source.geometry.vertices.subarray(i * 6 + 3, i * 6 + 6), i * 3); }
          input = { positions, normals, indices: source.geometry.indices, uvs: new Float32Array(count * 2) };
        }
      }
      const data = api.decalGeometry(input, identity, position, rotation, typeof scale === 'number' ? [scale, scale, scale] : scale, { offset, backfaces });
      const geometry = api.toGeometry(data); geometrySources.set(geometry, data); return geometry;
    }, dispose() {}, onError,
  }, [source?.geometry, supplied, at]);
  const value = useMemo<Scene>(() => ({ ...scene, registry: null }), [scene]);
  const [root, setRoot] = useState<MeshHandle | null>(null);
  const liveRoot = useRef<MeshHandle | null>(null);
  const bindRoot = useCallback((value: MeshHandle | null) => { liveRoot.current = value; setRoot(value); }, []);
  useCommit(() => {
    const target = mesh ? meshRuntime(mesh) : scene.registry?.current;
    if (liveRoot.current && target) liveRoot.current.setParent(target);
  }, [root, source?.mesh, mesh, scene.registry]);
  return data && source ? <Context.Provider value={value}><TextureProvider><Mesh ref={bindRoot}><GeometryResource geometry={data} /><PbrMaterial {...material} />{children}</Mesh></TextureProvider></Context.Provider> : null;
}
