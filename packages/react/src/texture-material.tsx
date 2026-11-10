import { useMemo, Suspense, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { Material as NativeMaterial, MaterialMesh, MaterialOptions, MeshGeometry, Texture, TransmissionOptions } from '@margoengine/materials';
import { useLoader } from './hooks.js';
import { Context, live, report, useCommit, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { geometrySources } from './texture-geometry.js';
import type { PbrMaterialProps } from './components.js';
import { modelPicking } from './picking.js';
import { textureLoaders, identity, own, nextId } from './texture-cache.js';
import { separateRoughness } from './roughness-feature.js';
/** Supplies map bindings to root material children without importing optional peers from the root entry. */
export function TextureProvider({ children }: { children?: ReactNode }) {
  const scene = useScene();
  const value = useMemo(() => ({ ...scene, mappedMaterial: MappedMaterial }), [scene]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
/** Native mapped PBR material, loaded through Suspense with all slots available in every Scene. */
export function MappedPbrMaterial(props: PbrMaterialProps) {
  return <Suspense fallback={null}><MappedMaterial {...props} /></Suspense>;
}

/** Lazy target used by the root material without bringing optional packages into the root import. */
export function MappedMaterial(props: PbrMaterialProps & { transmissionOptions?: TransmissionOptions }) {
  const loaders = textureLoaders(useScene().assetCache);
  const names = ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'metalRoughnessMap'] as const;
  const key = JSON.stringify(names.map((name) => {
    const value = props[name];
    return value && typeof value === 'object' ? identity(value) : value;
  }));
  let loader = loaders.get('maps:' + key);
  if (!loader) {
    loader = async (_, { engine, fetch, signal }) => {
      const api = await optionalPeer('@margoengine/materials', () => import('@margoengine/materials'));
      const result: Texture[] = [], owned: Texture[] = [];
      try {
        for (const name of names) {
          const value = props[name];
          if (!value) continue;
          if (value instanceof api.Texture) result.push(value);
          else {
            let texture: Texture;
            if (typeof value === 'string' || value instanceof URL) texture = await api.loadTexture(value, { fetch, signal });
            else {
              const blob = value instanceof Blob ? value : new Blob([value instanceof ArrayBuffer ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()]);
              const bitmap = await createImageBitmap(blob);
              texture = new api.Texture(bitmap, {}, true);
            }
            result.push(texture); owned.push(texture);
          }
        }
        signal.throwIfAborted(); own(engine, owned); return result;
      } catch (error) { owned.forEach((texture) => texture.dispose()); throw error; }
    };
    loaders.set('maps:' + key, loader);
  }
  const textures = useLoader(loader, key);
  let i = 0;
  const maps = Object.fromEntries(names.map((name) => [name, props[name] ? textures[i++] : null]));
  return <TextureMaterial color={props.color ?? '#ffffff'} roughness={props.roughness} metalness={props.metalness} emissive={props.emissive} emissiveIntensity={props.emissiveIntensity} transmissionOptions={props.transmissionOptions} {...maps} />;
}

/** Native material options plus a borrowed material and optional UV geometry. */
export interface TextureMaterialProps extends Omit<MaterialOptions, 'color'> {
  color?: string | readonly number[];
  /** Caller-owned material of any native class. The binding clones it and leaves its maps untouched. */
  material?: NativeMaterial;
  /** Roughness from green, independently of metalness. */
  roughnessMap?: Texture | null;
  /** Explicit UV-bearing geometry for a core Mesh whose geometry does not contain UVs. */
  geometry?: MeshGeometry;
  /** Optional transmission capture and volume controls, including caller-owned GPU extension maps. */
  transmissionOptions?: TransmissionOptions;
  onError?: (error: unknown) => void;
}
/** Any native material on a React Mesh, in its owning Scene on WebGPU and the WebGL2 compatibility device. */
export function TextureMaterial({ material, geometry: supplied, onError, roughnessMap, transmissionOptions, ...options }: TextureMaterialProps) {
  const scene = useScene(), registry = useMesh();
  const key = JSON.stringify(Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value !== 'object')));
  const references = Object.values(options).filter((value) => value && typeof value === 'object');
  const signature = references.map((value) => identity(value as object)).join();
  useCommit(() => {
    const lease = { active: true, closed: false };
    let mesh: MaterialMesh | undefined;
    let owner: Parameters<NonNullable<typeof registry.geometryOverride>>[0] | undefined;
    let surface: NativeMaterial | undefined;
    let api: typeof import('@margoengine/materials') | undefined;
    let revision = 0;
    let releaseRoughness: (() => void) | undefined;
    const detach = () => {
      if (!mesh) return;
      scene.resources.models.delete(mesh);
      for (const values of scene.resources.lighting.values()) { values.get(mesh)?.(); values.delete(mesh); }
      if (owner && Object.getOwnPropertyDescriptor(owner, source)?.value === mesh) Reflect.deleteProperty(owner, source);
      owner = undefined;
      mesh.dispose(); mesh = undefined;
    };
    const override = (target: Parameters<NonNullable<typeof registry.geometryOverride>>[0], geometry: Parameters<NonNullable<typeof registry.geometryOverride>>[1]) => {
      const generation = ++revision;
      detach();
      target.setGeometry(api ? null : geometry);
      queueMicrotask(() => {
        if (!api || !lease.active || lease.closed || generation !== revision || !geometry || live(registry) !== target) return;
        try {
          const input = supplied ?? geometrySources.get(geometry);
          const data = typeof input === 'function' ? input() : input;
          if (!data) throw new TypeError('TextureMaterial requires UV geometry; pass geometry or use Box, Sphere or Plane.');
          const plugin = { name: 'react:texture-mesh:' + nextId(), setup() {
            mesh = api!.createMesh(scene.engine as unknown as EngineKernel, data, surface!);
            if (transmissionOptions) {
              for (const primitive of mesh.primitives) primitive.material.transmission = transmissionOptions;
              api!.install(mesh);
            }
            mesh.root.setParent(target);
            owner = target;
            Object.defineProperty(target, source, { value: mesh, configurable: true });
            scene.resources.picking ??= modelPicking;
            scene.resources.models.add(mesh);
            for (const [effect, values] of scene.resources.lighting) values.set(mesh, mesh.addLighting(effect));
          } };
          (scene.world ?? scene.engine).use(plugin);
          // The setup owner is only a synchronous scene scope; the model and draw queue own their resources.
          (scene.world ?? scene.engine).removePlugin(plugin.name);
        } catch (error) { detach(); report(scene, error, onError); }
      });
    };
    if (registry.geometryOverride) throw new TypeError('TextureMaterial requires one material owner per Mesh; remove the extra material.');
    registry.geometryOverride = override;
    const attach = (target: Parameters<typeof override>[0]) => override(target, registry.geometry ?? target.geometry);
    registry.attachments.add(attach);
    void optionalPeer('@margoengine/materials', () => import('@margoengine/materials')).then((module) => {
      if (!lease.active || lease.closed || scene.engine.disposed) return;
      api = module;
      surface = material ? material.clone() : new api.Material(options as MaterialOptions);
      if (material) for (const [name, value] of Object.entries(options)) Reflect.set(surface, name, value);
      if (roughnessMap) {
        if (surface.metalRoughnessMap && surface.metalRoughnessMap !== roughnessMap) {
          if (surface.shading === 'standard') {
            const previous = surface.features;
            surface.features = [...previous, separateRoughness(roughnessMap, new api.Texture({ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }))];
            releaseRoughness = () => { surface!.features = previous; };
          }
        } else {
          surface.metalRoughnessMap = roughnessMap;
          const shader = surface.shader.bind(surface);
          surface.shader = (code, group) => shader(code, group).replaceAll('mr.b*f.factors.y', 'f.factors.y');
        }
      }
      const target = live(registry);
      if (target) attach(target);
    }).catch((error) => { if (lease.active) report(scene, error, onError); });
    return () => {
      lease.active = false;
      lease.closed = true;
      ++revision;
      registry.attachments.delete(attach);
      if (registry.geometryOverride === override) delete registry.geometryOverride;
      detach(); releaseRoughness?.(); surface?.dispose();
      const target = live(registry);
      if (target) target.setGeometry(registry.geometry ?? null);
    };
  }, [scene.engine, scene.world, registry, material, supplied, roughnessMap, transmissionOptions, key, signature]);
  return null;
}
const source = Symbol.for('margoengine.pbr-source.v1');
