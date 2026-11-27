// The reader of the 3MF Boolean Operations Extension as hooks of the core reader, so that `parse3MFBoolean` and
// `parse3MFEvaluated` share it.
import type { ThreeMFBooleanOperand, ThreeMFBooleanOptions, ThreeMFBooleanShape } from './threemf-boolean.js';
import { booleanMesh } from './threemf-csg.js';
import type { ThreeMFExtension, ThreeMFModel } from './threemf.js';
import { LoaderError } from './types.js';
import { limits, throwIfAborted } from './util.js';

const F = '3MF';
const OPERATIONS = ['union', 'difference', 'intersection'] as const;

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};

/**
 * The boolean reader's hooks. `others` says that hooks before these turn displacement meshes, level sets and lattices
 * into triangles, so such an object may be a base.
 */
export function booleanStage(options: ThreeMFBooleanOptions, others = false) {
  const evaluate = options.evaluate !== false;
  const shapes: ThreeMFBooleanShape[] = [],
    listed = new Map<ThreeMFModel, Map<string, ThreeMFBooleanShape>>(),
    /** Objects with a shape of another extension, which no operand may have. */
    extended = new Map<ThreeMFModel, Set<string>>(),
    current = new Map<ThreeMFModel, string>();
  let built = 0;
  const hooks: ThreeMFExtension = {
    booleans: true,
    welded: true,
    // A base may be another extension's shape.
    levelSets: true,
    element(model, name, a) {
      if (name === 'object') current.set(model, a.id);
      else if (name === 'displacementmesh' || name === 'beamlattice' || name === 'levelset') {
        let ids = extended.get(model);
        if (!ids) extended.set(model, (ids = new Set()));
        ids.add(current.get(model)!);
      }
    },
    instance(model, object, m, scale) {
      if (evaluate && object.levelSet && !others)
        throw new LoaderError(
          F,
          'unsupported',
          `object ${object.id.slice(0, 32)} is a volumetric level set; parse3MFBoolean meshes none (parse3MFEvaluated from @margoengine/loaders/threemf-evaluate does; evaluate: false reads the shapes)`,
        );
      const found = listed.get(model)?.get(object.id);
      if (!found) return;
      found.instances.push(m.map((v) => v * scale));
      built++;
    },
    hasGeometry: () => built > 0,
    async ready(_read, { models, partPath }) {
      const root = models.values().next().value;
      // A part that another names is finished before the part that names it.
      for (const model of [...models.values()].reverse()) {
        const own = new Map<string, ThreeMFBooleanShape>(),
          order = [...model.objects.keys()],
          modelPath = partPath(model);
        listed.set(model, own);
        for (const object of model.objects.values()) {
          const { id, boolean: data } = object;
          if (!data) continue;
          const label = `boolean shape ${id.slice(0, 32)}`;
          if (!OPERATIONS.includes(data.operation as (typeof OPERATIONS)[number]))
            bad(`${label} has the unknown operation ${data.operation.slice(0, 32)}`);
          if (object.mesh || object.components.length) bad(`${label} also has a mesh or components`);
          if (object.pid !== undefined || object.pindex !== undefined) bad(`${label} takes no pid or pindex`);
          if (!data.operands.length) bad(`${label} needs a boolean element`);
          const operand = (reference: (typeof data.operands)[number], isBase: boolean): ThreeMFBooleanOperand => {
            const { objectId, path, transform } = reference;
            if (path !== undefined && model !== root) bad(`${label}: only the root model part may name another part`);
            const owner = path ? models.get(path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())! : model,
              target = owner.objects.get(objectId),
              what = `${label}: object ${objectId.slice(0, 32)}`;
            // Defined before it is named, so no shape reads itself.
            if (!target || (owner === model && order.indexOf(objectId) >= order.indexOf(id)))
              bad(`${what} is not defined before it`);
            if (target!.type !== 'model' || target!.components.length || target!.alternatives.length)
              bad(`${what} must be a model shape without components or alternatives`);
            if (!isBase && (!target!.mesh || target!.boolean || extended.get(owner)?.has(objectId)))
              bad(`${what} must be a plain triangle mesh`);
            const mesh = target!.boolean ? undefined : target!.mesh,
              ownerPath = partPath(owner);
            return {
              objectId,
              ...(ownerPath === undefined ? {} : { modelPath: ownerPath }),
              transform,
              ...(mesh ? { mesh: { positions: mesh.vertices.result(), indices: mesh.triangles.result() } } : {}),
            };
          };
          const shape: ThreeMFBooleanShape = {
            objectId: id,
            ...(modelPath === undefined ? {} : { modelPath }),
            ...(object.name === undefined ? {} : { name: object.name }),
            operation: data.operation as ThreeMFBooleanShape['operation'],
            base: operand(data.base, true),
            operands: data.operands.map((o) => operand(o, false)),
            instances: [],
          };
          own.set(id, shape);
          shapes.push(shape);
          if (!evaluate) continue;
          throwIfAborted(options.signal, F);
          const inputs = [data.base, ...data.operands].map(({ objectId, path, transform }) => {
            const owner = path ? models.get(path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())! : model,
              target = owner.objects.get(objectId)!;
            if ((!others && extended.get(owner)?.has(objectId)) || !target.mesh)
              throw new LoaderError(
                F,
                'unsupported',
                `${label}: its base ${objectId.slice(0, 32)} is a displacement mesh, a level set or another extension's shape, which parse3MFBoolean does not evaluate (parse3MFEvaluated from @margoengine/loaders/threemf-evaluate does; evaluate: false reads the shapes)`,
              );
            return { model: owner, object: target, transform };
          });
          // Later shapes read this one as a mesh.
          object.mesh = await booleanMesh(model, id, shape.operation, inputs, limits(options, F).maxTriangles);
        }
      }
    },
    bucket: () => '',
    corner() {},
    group() {},
  };
  return { hooks, shapes };
}
