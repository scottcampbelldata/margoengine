'use client';
import { useRef } from 'react';
import { PbrMaterial as CoreMaterial, type Geometry, type Mesh as EngineMesh } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel, PreparedGeometry } from '@margoengine/gltf-pro';
import type { TransmissionOptions } from '@margoengine/materials';
import { PbrMaterial, type PbrMaterialProps } from './components.js';
import { live, useMesh, useResourceEffect, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

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
    if (!length) throw new RangeError('MeshTransmissionMaterial: geometry normals must be nonzero');
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
      let api: typeof import('@margoengine/gltf-pro') | undefined,
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
        throw new Error('MeshTransmissionMaterial: only one transmission material may attach to a Mesh');
      registry.geometryOverride = override;
      const attach = (target: EngineMesh) => override(target, registry.geometry ?? target.geometry);
      registry.attachments.add(attach);
      void (async () => {
        const modules = await Promise.all([
          optionalPeer('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro')),
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
      props.color,
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
    throw new RangeError('MeshTransmissionMaterial: factor must be between 0 and 1');
  return (
    <>
      <PbrMaterial color={props.color} roughness={props.roughness} metalness={props.metalness} />
      {factor > 0 && <TransmissionBinding {...props} factor={factor} />}
    </>
  );
}
