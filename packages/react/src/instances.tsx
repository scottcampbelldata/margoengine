import { createContext, forwardRef, useContext, useMemo, useRef } from 'react';
import { PbrMaterial as Material, type Geometry, type Mesh as EngineMesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Mesh, PbrMaterial, type MeshProps, type MeshRef } from './components.js';
import { live, useCommit, useMesh, useScene, type Registry } from './internal.js';

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
const InstancesContext = createContext<Batch | null>(null);
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
    throw new RangeError(`${label} must be a nonnegative safe integer; omit it to draw all instances.`);
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
      throw new MargoError('attached', 'Instances needs one plain PBR prototype; remove the extra geometry owner.');
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
    return () => {
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
export const Instances = forwardRef<MeshRef, InstancesProps>(function Instances(
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
export const Instance = forwardRef<MeshRef, InstanceProps>(function Instance(
  { color, visible = true, children, ...props },
  ref,
) {
  const batch = useContext(InstancesContext);
  if (!batch) throw new MargoError('state', 'Instance requires Instances; place it below an <Instances> provider.');
  return (
    <Mesh {...props} ref={ref}>
      <InstanceBinding batch={batch} color={color} visible={visible} />
      {children}
    </Mesh>
  );
});
