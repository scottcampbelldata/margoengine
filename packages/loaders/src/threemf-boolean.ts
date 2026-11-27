// Reads the 3MF Consortium's Boolean Operations Extension (https://github.com/3MFConsortium/spec_booleans): the shapes
// made by union, difference and intersection, and the meshes they name.
import { LoaderError } from './types.js';
import { read3MF, type ThreeMFModel, type ThreeMFOptions, type ThreeMFResult } from './threemf.js';
import type { BinaryInput } from './util.js';

const F = '3MF';
const OPERATIONS = ['union', 'difference', 'intersection'] as const;

/** An object a boolean shape reads. */
export interface ThreeMFBooleanOperand {
  objectId: string;
  /** Its model part, when not the root. */
  modelPath?: string;
  /** Twelve numbers as a 3MF transform writes them, applied before the operation. */
  transform: Float64Array;
  /** Its triangles in its own coordinates and the model's unit; absent for a shape without them. */
  mesh?: { positions: Float32Array; indices: Uint32Array };
}

/** A boolean shape: `operands` applied to `base` in order. */
export interface ThreeMFBooleanShape {
  objectId: string;
  modelPath?: string;
  name?: string;
  operation: (typeof OPERATIONS)[number];
  base: ThreeMFBooleanOperand;
  operands: ThreeMFBooleanOperand[];
  /**
   * Each place the build puts the shape: twelve numbers as a 3MF transform writes them, from the shape's coordinates to
   * the result's units. None for a shape that only another shape reads.
   */
  instances: Float64Array[];
}

/** The result of {@link parse3MFBoolean}. */
export interface ThreeMFBooleanResult extends ThreeMFResult {
  /** Every boolean shape, each after the shapes it reads. */
  shapes: ThreeMFBooleanShape[];
}

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};

/**
 * Parses a 3MF package with the boolean operations extension. Meshes the build places come as {@link ThreeMFResult}
 * gives them; each boolean shape is returned with its operands' triangles and its placements. The operations are not
 * evaluated: a boolean shape adds no triangles.
 *
 * @throws LoaderError for what the extension rules out (an unknown operation, a property on a shape, a base that is not
 * a `model` shape or has alternatives, an operand that is not a plain `model` mesh, a shape that reads itself or a later
 * object) and what `parse3MF` throws.
 */
export async function parse3MFBoolean(input: BinaryInput, options: ThreeMFOptions = {}): Promise<ThreeMFBooleanResult> {
  const shapes: ThreeMFBooleanShape[] = [],
    listed = new Map<ThreeMFModel, Map<string, ThreeMFBooleanShape>>(),
    /** Objects with a shape of another extension, which no operand may have. */
    extended = new Map<ThreeMFModel, Set<string>>(),
    current = new Map<ThreeMFModel, string>();
  let built = 0;
  const read = await read3MF(input, options, {
    booleans: true,
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
            if (!isBase && (!target!.mesh || extended.get(owner)?.has(objectId)))
              bad(`${what} must be a plain triangle mesh`);
            const mesh = target!.mesh,
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
        }
      }
    },
    bucket: () => '',
    corner() {},
    group() {},
  });
  return { ...read, shapes };
}
