import { useRef, Suspense } from 'react';
import { PbrMaterial as CoreMaterial, type Geometry, type Mesh as EngineMesh } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel, PreparedGeometry } from '@margoengine/gltf/pbr';
import type { TransmissionOptions } from '@margoengine/materials';
import { PbrMaterial, type PbrMaterialProps } from './components.js';
import { colorKey, live, report, useMesh, useResourceEffect, useScene } from './internal.js';
import type * as ReflectorModule from '@margoengine/environment/reflector-pbr';
import type { MeshReflector as NativeMeshReflector } from '@margoengine/environment/reflector-pbr';
import type { NormalMapImage } from '@margoengine/environment/reflector';
import { optionalPeer } from './optional.js';
import { modelPicking } from './picking.js';
import { MappedMaterial } from './texture-material.js';
import { fault, rangeError } from '../../shared/errors.js';
import type { Borrowable } from '../../shared/borrowed.js';

export { BatchedMesh, BatchedItem, type BatchedMeshProps, type BatchedItemProps } from './batched.js';
export { Mask, useMask, type MaskProps, type MaskStencil } from './mask.js';

/** Props of the MeshTransmissionMaterial component; every prop is optional unless noted. */
export interface MeshTransmissionMaterialProps extends PbrMaterialProps, Omit<TransmissionOptions, 'opaqueColor'> {
  onError?: (error: unknown) => void;
}
const source = Symbol.for('margoengine.pbr-source.v1');
/** Convert an existing procedural geometry once; never read a GPU buffer back. */
function prepared(geometry: Geometry): PreparedGeometry {
  const count = geometry.vertices.length / 6,
    vertices = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) {
    const at = i * 6,
      out = i * 20,
      nx = geometry.vertices[at + 3],
      ny = geometry.vertices[at + 4],
      nz = geometry.vertices[at + 5],
      length = Math.hypot(nx, ny, nz);
    if (!length) throw rangeError('MeshTransmissionMaterial: geometry normals must be nonzero', 'react-arguments');
    vertices.set(
      [
        geometry.vertices[at],
        geometry.vertices[at + 1],
        geometry.vertices[at + 2],
        1,
        nx / length,
        ny / length,
        nz / length,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
      ],
      out,
    );
  }
  return { vertices, indices: geometry.indices };
}
function TransmissionBinding(props: MeshTransmissionMaterialProps) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(props);
  latest.current = props;
  useResourceEffect(
    (lease) => {
      let api: typeof import('@margoengine/gltf/pbr') | undefined,
        materials: typeof import('@margoengine/materials') | undefined;
      let model: PBRModel | undefined,
        mesh: EngineMesh | null = null,
        previous: PropertyDescriptor | undefined,
        revision = 0;
      const base = new CoreMaterial(props);
      const releaseModel = () => {
        if (!model) return;
        if (mesh && Object.getOwnPropertyDescriptor(mesh, source)?.value === model) {
          if (previous) Object.defineProperty(mesh, source, previous);
          else Reflect.deleteProperty(mesh, source);
        }
        scene.resources.models.delete(model);
        for (const values of scene.resources.lighting.values()) {
          values.get(model)?.();
          values.delete(model);
        }
        model.dispose();
        model = undefined;
      };
      const report = (error: unknown) => {
        try {
          latest.current.onError?.(error);
        } finally {
          scene.engine.onError(error);
        }
      };
      const override = (target: EngineMesh, geometry: Geometry | null) => {
        const generation = ++revision;
        releaseModel();
        mesh = target;
        if (!api || !materials) {
          target.setGeometry(geometry);
          return;
        }
        target.setGeometry(null);
        // Layout cleanup and recreation can pass through null in one commit.
        // Build only the final geometry, after StrictMode reactivates its lease.
        queueMicrotask(() => {
          if (
            !lease.active ||
            lease.closed ||
            generation !== revision ||
            scene.engine.disposed ||
            live(registry) !== target ||
            !geometry
          )
            return;
          try {
            const doc = {
              asset: { version: '2.0' },
              materials: [
                {
                  doubleSided: true,
                  pbrMetallicRoughness: {
                    baseColorFactor: Array.from(base.data.subarray(0, 4)),
                    roughnessFactor: base.data[4],
                    metallicFactor: base.data[5],
                  },
                },
              ],
              nodes: [{ mesh: 0 }],
              meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
              scenes: [{ nodes: [0] }],
              scene: 0,
            };
            model = api!.parsePreparedPBR(scene.engine as unknown as EngineKernel, doc, [[prepared(geometry)]]);
            // Only helper nodes belong to the PBR model. Rendering and picking
            // borrow the original mesh, retaining its handlers and hierarchy.
            model.root.setParent(target);
            for (const primitive of model.primitives) primitive.node = target;
            for (const primitive of model.primitives)
              primitive.material.transmission = {
                factor: props.factor ?? 1,
                ior: props.ior,
                transmissionTexture: props.transmissionTexture,
                volume: props.volume,
              };
            materials!.install(model);
            previous = Object.getOwnPropertyDescriptor(target, source);
            Object.defineProperty(target, source, { value: model, configurable: true });
            scene.resources.picking ??= modelPicking;
            scene.resources.models.add(model);
            for (const [effect, values] of scene.resources.lighting) values.set(model, model.addLighting(effect));
          } catch (error) {
            releaseModel();
            if (live(registry) === target) target.setGeometry(geometry);
            report(error);
          }
        });
      };
      if (registry.geometryOverride)
        throw fault(
          'attached',
          'MeshTransmissionMaterial: only one transmission material may attach to a Mesh; remove the extra one',
          'react-usage',
        );
      registry.geometryOverride = override;
      const attach = (target: EngineMesh) => override(target, registry.geometry ?? target.geometry);
      registry.attachments.add(attach);
      void (async () => {
        const modules = await Promise.all([
          optionalPeer('@margoengine/gltf/pbr', () => import('@margoengine/gltf/pbr')),
          optionalPeer('@margoengine/materials', () => import('@margoengine/materials')),
        ]);
        if (!lease.active || scene.engine.disposed) return;
        [api, materials] = modules;
        const target = live(registry);
        if (target) attach(target);
      })().catch((error) => {
        if (lease.active && !scene.engine.disposed) report(error);
      });
      return () => {
        ++revision;
        registry.attachments.delete(attach);
        if (registry.geometryOverride === override) delete registry.geometryOverride;
        releaseModel();
        const target = live(registry);
        if (target) target.setGeometry(registry.geometry ?? null);
      };
    },
    [
      scene.engine,
      scene.resources,
      registry,
      colorKey(props.color),
      props.roughness,
      props.metalness,
      props.factor,
      props.ior,
      props.transmissionTexture,
      props.volume,
    ],
  );
  return null;
}
/** Native transmission/volume for procedural Mesh geometry. Zero is exact PbrMaterial. */
export function MeshTransmissionMaterial({ factor = 1, ...props }: MeshTransmissionMaterialProps) {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 1)
    throw rangeError('MeshTransmissionMaterial: factor must be between 0 and 1', 'react-arguments');
  if (props.map || props.normalMap || props.roughnessMap || props.emissiveMap || props.metalRoughnessMap)
    return (
      <Suspense fallback={null}>
        <MappedMaterial {...props} transmissionOptions={{ ...props, factor }} />
      </Suspense>
    );
  return (
    <>
      <PbrMaterial color={props.color} roughness={props.roughness} metalness={props.metalness} />
      {factor > 0 && <TransmissionBinding {...props} factor={factor} />}
    </>
  );
}

/** Props of `<MeshReflectorMaterial>`: the mesh's own `PbrMaterial` props plus the reflection's; every prop is optional. */
export interface MeshReflectorMaterialProps extends PbrMaterialProps {
  /** Capture size in pixels along the canvas's longer side (drei's buffer size), 8 to 4096. Default 256. */
  resolution?: number;
  /** Reflection weight: multiplies the Fresnel reflectance; the weight is clamped to 1. At least 0. Default 1. */
  mixStrength?: number;
  /** How much the blurred image replaces the sharp one, times the surface `roughness` (default 1); clamped to 1. Default 1. */
  mixBlur?: number;
  /** Contrast of the reflection about linear 0.5; 1 leaves it. At least 0. Default 1. */
  mixContrast?: number;
  /** 0: the reflection follows the Fresnel reflectance; 1: it reflects as a mirror at every angle. Default 0. */
  mirror?: number;
  /** Box blur in capture pixels: [x, y] or one number for both; 0 draws it sharp. Default [0, 0]. */
  blur?: number | readonly [number, number];
  /** Depth units per world unit of a reflected point's distance from the plane; above 0 the reflection fades and blurs with it. Default 0. */
  depthScale?: number;
  /** Depth where the fade and depth blur start. Default 0.9. */
  minDepthThreshold?: number;
  /** Depth where the reflection has faded out and the blur is full. Default 1. */
  maxDepthThreshold?: number;
  /** Blur weight added to the depth's, 0 to 1. Default 0.25. */
  depthToBlurRatioBias?: number;
  /** Moves the mirror plane along the surface normal (world units) without moving the surface. Default 0. */
  reflectorOffset?: number;
  /** Image offset in screen fractions per unit of `distortionMap` x and y. Default 0.03. */
  distortion?: number;
  /**
   * A tangent-space normal map that distorts the reflection: `(device) => GPUTexture` (made again after a device
   * restore), a 2D GPUTexture (dropped and reported once after a restore) or RGBA8 pixels. Default none.
   */
  distortionMap?: Borrowable<GPUTexture> | NormalMapImage | null;
  /** Layer mask the capture draws (@margoengine/cameras/layers). Default every layer. */
  layers?: number;
  /** Called with the native MeshReflector of `@margoengine/environment/reflector-pbr` once it is attached. */
  onCreated?: (reflector: NativeMeshReflector) => void;
  onError?: (error: unknown) => void;
}

const reflectorPair = (blur: number | readonly [number, number]): [number, number] =>
  typeof blur === 'number' ? [blur, blur] : [blur[0], blur[1]];

// The rectangle of a flat geometry in its local XY plane: centre and size; null when empty or not flat in XY.
function flatRectangle(geometry: Geometry): { centre: [number, number, number]; width: number; height: number } | null {
  const v = geometry.vertices;
  if (!v.length) return null;
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (let i = 0; i < v.length; i += 6) {
    x0 = Math.min(x0, v[i]);
    x1 = Math.max(x1, v[i]);
    y0 = Math.min(y0, v[i + 1]);
    y1 = Math.max(y1, v[i + 1]);
    z0 = Math.min(z0, v[i + 2]);
    z1 = Math.max(z1, v[i + 2]);
  }
  const width = x1 - x0,
    height = y1 - y0;
  if (!(width > 0 && height > 0) || z1 - z0 > 1e-6 * Math.max(width, height)) return null;
  return { centre: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], width, height };
}

function ReflectorBinding({ settings }: { settings: MeshReflectorMaterialProps & { resolution: number } }) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(settings);
  latest.current = settings;
  useResourceEffect(
    (lease) => {
      let api: typeof ReflectorModule | undefined,
        native: NativeMeshReflector | undefined,
        shape: Geometry | null | undefined,
        owner: EngineMesh | undefined;
      const { engine } = scene;
      const drop = () => {
        native?.dispose();
        native = undefined;
        shape = undefined;
      };
      const sync = () => {
        const mesh = live(registry),
          s = latest.current;
        if (!api || !lease.active || engine.disposed) return;
        try {
          if (!mesh || mesh !== owner) drop();
          owner = mesh ?? undefined;
          if (!mesh) return;
          const geometry = registry.geometry ?? null;
          if (geometry !== shape) {
            const rectangle = geometry && flatRectangle(geometry);
            if (!native) {
              native = new api.MeshReflector({ parent: mesh, exclude: [mesh], resolution: 1 });
              (scene.world ?? engine).use(native as unknown as Parameters<EngineKernel['use']>[0]);
              s.onCreated?.(native);
            }
            // Reported once per geometry: the reflection stays hidden until the geometry is flat.
            shape = geometry;
            native.node.visible = !!rectangle;
            if (geometry && !rectangle)
              throw rangeError(
                'MeshReflectorMaterial needs a flat geometry in its local XY plane (a PlaneGeometry); turn the Mesh to face the way the surface should',
                'react-arguments',
              );
            if (rectangle) {
              native.node.setPosition(rectangle.centre);
              native.width = rectangle.width;
              native.height = rectangle.height;
            }
          }
          if (!native) return;
          const canvas = engine.canvas,
            longer = Math.max(1, canvas.width, canvas.height);
          if (!(Number.isFinite(s.resolution) && s.resolution >= 8 && s.resolution <= 4096))
            throw rangeError('MeshReflectorMaterial resolution must be 8 to 4096; pass the capture size in pixels', 'react-arguments');
          native.resolution = Math.min(2, s.resolution / longer);
          native.mixStrength = s.mixStrength ?? 1;
          native.mixBlur = (s.mixBlur ?? 1) * (s.roughness ?? 1);
          native.mixContrast = s.mixContrast ?? 1;
          native.mirror = s.mirror ?? 0;
          native.blurSize = reflectorPair(s.blur ?? 0);
          native.depthScale = s.depthScale ?? 0;
          native.minDepthThreshold = s.minDepthThreshold ?? 0.9;
          native.maxDepthThreshold = s.maxDepthThreshold ?? 1;
          native.depthToBlurRatioBias = s.depthToBlurRatioBias ?? 0.25;
          native.reflectorOffset = s.reflectorOffset ?? 0;
          native.distortion = s.distortion ?? 0.03;
          if (native.normalMap !== (s.distortionMap ?? undefined)) native.normalMap = s.distortionMap ?? undefined;
          native.layers = s.layers ?? 0xffffffff;
          native.f0 = reflectorF0(s.color, s.metalness ?? 0);
        } catch (error) {
          report(scene, error, latest.current.onError);
        }
      };
      void optionalPeer('@margoengine/environment', () => import('@margoengine/environment/reflector-pbr'))
        .then((module) => {
          if (!lease.active || engine.disposed) return;
          api = module;
          sync();
        })
        .catch((error) => {
          if (lease.active && !engine.disposed) report(scene, error, latest.current.onError);
        });
      scene.frames.callbacks.add(sync);
      return () => {
        scene.frames.callbacks.delete(sync);
        drop();
      };
    },
    [scene, registry],
  );
  return null;
}

// F0 of the surface underneath: 0.04 for a dielectric, the base colour for a metal, mixed by metalness (glTF 2.0
// metallic-roughness, Appendix B).
function reflectorF0(color: PbrMaterialProps['color'], metalness: number): [number, number, number] {
  const base = color === undefined ? [1, 1, 1] : typeof color === 'string' ? hexLinear(color) : [color[0], color[1], color[2]];
  const m = Math.min(1, Math.max(0, metalness));
  return [0, 1, 2].map((i) => Math.min(1, Math.max(0, 0.04 * (1 - m) + base[i] * m))) as [number, number, number];
}
function hexLinear(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

/**
 * drei's MeshReflectorMaterial: the mesh's own lit `PbrMaterial` (color, roughness, metalness, maps) with a planar
 * reflection drawn over it, weighted by the Fresnel reflectance and `mixStrength`, optionally blurred, faded with depth
 * and distorted. The mesh's geometry must be flat in its local XY plane (a `<PlaneGeometry>`; turn the mesh, e.g.
 * `rotation={[-Math.PI / 2, 0, 0]}` for a floor); the reflection shows on its +Z side. Built on `MeshReflector` of
 * `@margoengine/environment/reflector-pbr`; WebGPU and the WebGL2 compatibility layer.
 */
export function MeshReflectorMaterial({ resolution = 256, ...props }: MeshReflectorMaterialProps) {
  const { color, roughness, metalness, map, normalMap, roughnessMap, metalRoughnessMap, emissiveMap, emissive, emissiveIntensity, envMap, envMapIntensity } = props;
  return (
    <>
      <PbrMaterial
        {...{ color, roughness, metalness, map, normalMap, roughnessMap, metalRoughnessMap, emissiveMap, emissive, emissiveIntensity, envMap, envMapIntensity }}
      />
      <ReflectorBinding settings={{ ...props, resolution }} />
    </>
  );
}
