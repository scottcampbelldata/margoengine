import { createContext, forwardRef, useContext, useMemo, useRef, type ReactNode } from 'react';
import { PbrMaterial as Material, type Geometry, type Mesh as EngineMesh } from '@margoengine/core/extension';
import { Mesh, PbrMaterial, type MeshProps, type MeshRef } from './components.js';
import { live, useCommit, useMesh, useScene, type Registry } from './internal.js';
import { fault, rangeError } from '../../shared/errors.js';

interface Item {
  mesh: EngineMesh;
  tint: Material;
}
interface Batch {
  registry: Registry;
  items: Set<Item>;
  limit: number;
  range: number;
  sync(): void;
}
const InstancesContext = /* @__PURE__ */ createContext<Batch | null>(null);
/** Shared geometry and material children plus instances. Transforms and events also work on the container. */
export interface InstancesProps extends MeshProps {
  /** Maximum drawn instances, default 1000. Extra mounted instances retain their refs and children. */
  limit?: number;
  /** Draw the first `range` mounted instances, at most `limit`. Default all. */
  range?: number;
  /** Optional caller-owned geometry, instead of a geometry child. */
  geometry?: Geometry;
  /** Optional caller-owned material, instead of a material child. Default white PBR. */
  material?: Material;
}
/** One native mesh in the shared geometry draw, with independent transform, tint, visibility, children and events. */
export interface InstanceProps extends MeshProps {
  /** sRGB hex or linear RGB multiplier of the shared material, default white. */
  color?: string | readonly number[];
  /** Hide this instance and its children. Default true. */
  visible?: boolean;
}
function count(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw rangeError(`${label} must be a nonnegative safe integer; omit it to draw all instances`, 'react-arguments');
  return value;
}
function Prototype({ children, geometry, material, limit, range }: InstancesProps) {
  const registry = useMesh(),
    scene = useScene();
  const batch = useMemo<Batch>(() => {
    const items = new Set<Item>();
    return {
      registry,
      items,
      limit: 1000,
      range: Infinity,
      sync() {
        const root = live(registry);
        if (!root) return;
        const source = root.material.data;
        let index = 0;
        for (const { mesh, tint } of items) {
          if (scene.engine.meshes.get(mesh.id) !== mesh) continue;
          mesh.setGeometry(index++ < Math.min(this.limit, this.range) ? (registry.geometry ?? null) : null);
          const data = mesh.material.data;
          for (let i = 0; i < source.length; i++) data[i] = source[i] * (i < 3 ? tint.data[i] : 1);
        }
      },
    };
  }, [registry, scene.engine]);
  const capacity = count(limit, 1000, 'Instances limit'),
    drawn = count(range, Infinity, 'Instances range');
  useCommit(() => {
    batch.limit = capacity;
    batch.range = drawn;
    batch.sync();
  }, [batch, capacity, drawn]);
  useCommit(() => {
    if (registry.geometryOverride)
      throw fault(
        'attached',
        'Instances needs one plain PBR prototype; remove the extra geometry owner',
        'react-usage',
      );
    const override = (mesh: EngineMesh) => {
      mesh.setGeometry(null);
      batch.sync();
    };
    registry.geometryOverride = override;
    registry.attachments.add(override);
    const root = live(registry);
    if (root) override(root);
    const sync = () => batch.sync();
    scene.frames.callbacks.add(sync);
    // Outlines (and any child that decorates each instance) read the drawn instance meshes.
    const drawn = () =>
      [...batch.items]
        .map((i) => i.mesh)
        .filter((m) => scene.engine.meshes.get(m.id) === m && m.geometry)
        .slice(0, Math.min(batch.limit, batch.range));
    registry.instanceMeshes = drawn;
    return () => {
      if (registry.instanceMeshes === drawn) delete registry.instanceMeshes;
      scene.frames.callbacks.delete(sync);
      registry.attachments.delete(override);
      if (registry.geometryOverride === override) delete registry.geometryOverride;
    };
  }, [registry, batch, scene.frames]);
  useCommit(() => {
    if (!material) return;
    let previous: Material | undefined;
    const attach = (root: EngineMesh) => {
      previous = root.material;
      root.setMaterial(material);
      batch.sync();
    };
    registry.attachments.add(attach);
    const root = live(registry);
    if (root) attach(root);
    return () => {
      registry.attachments.delete(attach);
      const current = live(registry);
      if (current && previous && current.material === material) current.setMaterial(previous);
    };
  }, [registry, batch, material]);
  useCommit(() => {
    if (!geometry) return;
    const previous = registry.geometry;
    registry.geometry = geometry;
    batch.sync();
    return () => {
      if (registry.geometry === geometry) registry.geometry = previous;
      batch.sync();
    };
  }, [registry, geometry, batch]);
  return <InstancesContext.Provider value={batch}>{children}</InstancesContext.Provider>;
}
/** Same-geometry meshes are one native instanced draw per scene/pass on both WebGPU and WebGL2. */
export const Instances = /* @__PURE__ */ forwardRef<MeshRef, InstancesProps>(function Instances(
  { children, geometry, material, limit, range, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <PbrMaterial color="#ffffff" />
      <Prototype geometry={geometry} material={material} limit={limit} range={range}>
        {children}
      </Prototype>
    </Mesh>
  );
});
function InstanceBinding({ batch, color, visible }: { batch: Batch; color: InstanceProps['color']; visible: boolean }) {
  const registry = useMesh(),
    tint = useMemo(() => new Material({ color: color ?? '#ffffff' }), [color]);
  const item = useRef<Item | null>(null);
  useCommit(() => {
    const attach = (mesh: EngineMesh) => {
      if (item.current) batch.items.delete(item.current);
      mesh.setMaterial(new Material());
      mesh.visible = visible;
      item.current = { mesh, tint };
      batch.items.add(item.current);
      batch.sync();
    };
    registry.attachments.add(attach);
    const mesh = live(registry);
    if (mesh) attach(mesh);
    return () => {
      registry.attachments.delete(attach);
      if (item.current) {
        batch.items.delete(item.current);
        item.current = null;
      }
      batch.sync();
    };
  }, [batch, registry]);
  useCommit(() => {
    if (item.current) {
      item.current.tint = tint;
      item.current.mesh.visible = visible;
      batch.sync();
    }
  }, [batch, tint, visible]);
  return null;
}
/** A stable native mesh ref; use the regular pointer handlers, Group parents and useFrame imperative setters. */
export const Instance = /* @__PURE__ */ forwardRef<MeshRef, InstanceProps>(function Instance(
  { color, visible = true, children, ...props },
  ref,
) {
  const batch = useContext(InstancesContext);
  if (!batch)
    throw fault('state', 'Instance requires Instances; place it below an <Instances> provider', 'react-usage');
  return (
    <Mesh {...props} ref={ref}>
      <InstanceBinding batch={batch} color={color} visible={visible} />
      {children}
    </Mesh>
  );
});

/** A source of `<Merged>`: a native mesh (a ref's `current`) or its geometry and optional material. */
export interface MergedSource {
  geometry: Geometry | null;
  material?: Material | null;
}
/** One instance component of `<Merged>`: an `<Instance>` of its source's geometry and material. */
export type MergedInstance = ReturnType<typeof forwardRef<MeshRef, InstanceProps>>;
/** Props of `<Merged>`. */
export interface MergedProps<T extends readonly MergedSource[] | Record<string, MergedSource>> {
  /** The sources: an array (children get one component per source, in order) or a record (children get a record of components). */
  meshes: T;
  /** Maximum drawn instances of each source. Default 1000. */
  limit?: number;
  /** Draw the first `range` mounted instances of each source. Default all. */
  range?: number;
  /** Called with the instance components; returns the scene that uses them. */
  children: (
    ...components: T extends readonly MergedSource[] ? MergedInstance[] : [Record<keyof T & string, MergedInstance>]
  ) => ReactNode;
}
const MergedContext = /* @__PURE__ */ createContext<readonly Batch[]>([]);
function Collect({ children }: { children: ReactNode }) {
  const batch = useContext(InstancesContext)!,
    parent = useContext(MergedContext),
    list = useMemo(() => [...parent, batch], [parent, batch]);
  return <MergedContext.Provider value={list}>{children}</MergedContext.Provider>;
}
function instanceOf(index: number): MergedInstance {
  return forwardRef<MeshRef, InstanceProps>(function MergedInstance(props, ref) {
    // The batches of the nearest <Merged>, one per source in order.
    const batch = useContext(MergedContext)[index];
    if (!batch)
      throw fault(
        'state',
        'A Merged instance must render inside its <Merged>; render it from the children function',
        'react-usage',
      );
    return (
      <InstancesContext.Provider value={batch}>
        <Instance {...props} ref={ref} />
      </InstancesContext.Provider>
    );
  });
}
/**
 * drei's Merged: one instanced draw per source mesh, with a component per source that places one instance of it.
 * Each source is drawn as an `<Instances>` of its geometry and material (white PBR when it has none), so every
 * instance accepts the `<Instance>` props: transform, `color`, `visible`, children, ref and pointer handlers.
 */
export function Merged<T extends readonly MergedSource[] | Record<string, MergedSource>>({
  meshes,
  limit,
  range,
  children,
}: MergedProps<T>) {
  const keys = Array.isArray(meshes) ? null : Object.keys(meshes),
    sources: readonly MergedSource[] = keys
      ? keys.map((key) => (meshes as Record<string, MergedSource>)[key])
      : (meshes as readonly MergedSource[]);
  for (const source of sources)
    if (!source?.geometry)
      throw fault(
        'state',
        'Merged needs a geometry on every mesh; pass mounted meshes or { geometry, material }',
        'react-usage',
      );
  const shape = (keys ?? []).join('\u0000') + ':' + sources.length,
    components = useMemo(() => sources.map((_, index) => instanceOf(index)), [shape]);
  const made = keys ? [Object.fromEntries(keys.map((key, index) => [key, components[index]]))] : components;
  let tree: ReactNode = (children as (...args: unknown[]) => ReactNode)(...made);
  for (let index = sources.length - 1; index >= 0; index--)
    tree = (
      <Instances
        geometry={sources[index].geometry!}
        material={sources[index].material ?? undefined}
        limit={limit}
        range={range}
      >
        <Collect>{tree}</Collect>
      </Instances>
    );
  return <MergedContext.Provider value={[]}>{tree}</MergedContext.Provider>;
}
