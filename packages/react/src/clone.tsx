import { forwardRef, useEffect, useRef, type RefObject } from 'react';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr';
import { renderLayers, setRenderLayers } from '../../shared/layers.js';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, report, useMesh, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<Clone>`: the transform and events apply to a group that holds the copy. */
export interface CloneProps extends MeshProps {
  /** The mesh, group or model root to copy (a ref works too), with everything under it. Null draws nothing. */
  object: MeshRef | RefObject<MeshRef | null> | null;
  /** Gets errors of the model copies (they load `@margoengine/animation`). Default: the Canvas onError. */
  onError?: (error: unknown) => void;
}
function parentOf(scene: Scene, mesh: EngineMesh): number {
  return scene.engine.store.parents[mesh.id];
}
function under(scene: Scene, mesh: EngineMesh, root: EngineMesh): boolean {
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++)
    if (id === root.id) return true;
  return false;
}
// The local transform, from the store inputs the setters wrote, so a copy starts exactly where the source is now.
function copyTransform(scene: Scene, from: EngineMesh, to: EngineMesh): void {
  const t = scene.engine.store.transforms,
    a = from.id;
  to.setPosition([t.x[a], t.y[a], t.z[a]]);
  to.setQuaternion([t.qx[a], t.qy[a], t.qz[a], t.qw[a]]);
  to.setScale([t.sx[a], t.sy[a], t.sz[a]]);
}
interface Copy {
  meshes: EngineMesh[];
  models: PBRModel[];
  dispose(): void;
}
function copyTree(scene: Scene, source: EngineMesh, group: EngineMesh, onError: (error: unknown) => void): Copy {
  const { engine, resources } = scene,
    layers = renderLayers(),
    copies = new Map<number, EngineMesh>([[parentOf(scene, source), group]]),
    copy: Copy = {
      meshes: [],
      models: [],
      dispose() {
        disposed = true;
        for (const model of copy.models) {
          resources.models.delete(model);
          for (const models of resources.lighting.values()) {
            models.get(model)?.();
            models.delete(model);
          }
          if (!model.disposed) model.dispose();
        }
        for (const mesh of copy.meshes.reverse()) if (engine.meshes.get(mesh.id) === mesh) mesh.dispose();
        copy.models.length = copy.meshes.length = 0;
      },
    };
  let disposed = false;
  // Model nodes are copied with their model, never as plain meshes.
  const models = [...resources.models].filter((model) => !model.disposed && under(scene, model.root, source)),
    owned = new Set<number>();
  for (const model of models)
    for (const node of [model.root, ...model.nodes, ...model.primitives.map((primitive) => primitive.node)])
      if (node) owned.add(node.id);
  // Parents before children: walk down from the source.
  const order: EngineMesh[] = [],
    meshes = [...engine.meshes.values()].filter((mesh) => !owned.has(mesh.id) && under(scene, mesh, source));
  const visit = (parent: number) => {
    for (const mesh of meshes)
      if (parentOf(scene, mesh) === parent) {
        order.push(mesh);
        visit(mesh.id);
      }
  };
  visit(parentOf(scene, source));
  for (const mesh of order) {
    const to = (scene.world ?? engine).createMesh() as EngineMesh;
    to.setParent(copies.get(parentOf(scene, mesh)) ?? group);
    copy.meshes.push(to);
    copies.set(mesh.id, to);
    copyTransform(scene, mesh, to);
    if (mesh.geometry) to.setGeometry(mesh.geometry);
    if (mesh.material) to.setMaterial(mesh.material);
    to.visible = mesh.visible;
    const mask = layers.masks.get(mesh);
    if (mask !== undefined) setRenderLayers(to, mask);
  }
  if (models.length)
    optionalPeer('@margoengine/animation', () => import('@margoengine/animation/skeleton-utils'))
      .then(async ({ cloneModel }) => {
        for (const model of models) {
          if (disposed || model.disposed) return;
          const clone = (await cloneModel(model as never)) as unknown as PBRModel;
          if (disposed || engine.disposed) {
            clone.dispose();
            return;
          }
          copy.models.push(clone);
          // Material values as the source shows them now (a <Model materials> override included).
          model.primitives.forEach((primitive, i) => {
            const to = clone.primitives[i]?.material,
              from = primitive.material;
            if (to && to !== from)
              Object.assign(to, from, {
                base: [...from.base],
                factors: [...from.factors],
                emission: [...from.emission],
                settings: [...from.settings],
              });
          });
          const parent = copies.get(parentOf(scene, model.root as unknown as EngineMesh)) ?? group;
          (clone.root as unknown as EngineMesh).setParent(parent);
          clone.root.visible = model.root.visible;
          resources.models.add(clone);
          for (const [effect, lit] of resources.lighting) lit.set(clone, clone.addLighting(effect));
        }
      })
      .catch(onError);
  return copy;
}
function CloneBinding({ object, onError }: Pick<CloneProps, 'object' | 'onError'>) {
  const scene = useScene(),
    registry = useMesh(),
    latestError = useRef(onError);
  latestError.current = onError;
  useEffect(() => {
    let copy: Copy | null = null;
    const build = (group: EngineMesh) => {
      copy?.dispose();
      copy = null;
      const source = (object && 'current' in object ? object.current : object) as unknown as EngineMesh | null;
      if (!source || scene.engine.meshes.get(source.id) !== source) return;
      try {
        if (under(scene, group, source))
          throw rangeError('Clone cannot hold a copy of its own ancestor; place it outside the object it copies', 'react-arguments');
        copy = copyTree(scene, source, group, (error) => report(scene, error, latestError.current));
      } catch (error) {
        report(scene, error, latestError.current);
      }
    };
    // Kept registered: a group created again (StrictMode, a Suspense reveal) gets a fresh copy.
    registry.attachments.add(build);
    const group = live(registry);
    if (group) build(group);
    return () => {
      registry.attachments.delete(build);
      copy?.dispose();
    };
  }, [scene, registry, object]);
  return null;
}
/**
 * A copy of a mesh, group or loaded model with everything under it, as drei's `<Clone>`: plain meshes share their
 * geometry and material with the source, models are independent copies (`cloneModel` of `@margoengine/animation`, so
 * each can play its own animation) that share the source's GPU buffers and textures. The copy starts at the source's
 * current local transforms, visibility and render layers and does not follow later changes; pass a new `object` to
 * copy again. The props place the copy like a group's.
 */
export const Clone = /* @__PURE__ */ forwardRef<MeshRef, CloneProps>(function Clone({ object, onError, children, ...props }, ref) {
  return (
    <Mesh {...props} ref={ref}>
      <CloneBinding object={object} onError={onError} />
      {children}
    </Mesh>
  );
});
