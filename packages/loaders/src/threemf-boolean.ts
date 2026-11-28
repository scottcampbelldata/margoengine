// Reads the 3MF Consortium's Boolean Operations Extension (https://github.com/3MFConsortium/spec_booleans): the shapes
// made by union, difference and intersection, and the meshes they name.
import { read3MF, type ThreeMFOptions, type ThreeMFResult } from './threemf.js';
import { booleanStage } from './threemf-boolean-read.js';
import type { ThreeMFVolumeSamples } from './threemf-volumetric.js';
import type { BinaryInput } from './util.js';

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
  /**
   * With `parse3MFEvaluated`, when the object has volume data: reads it at points in the object's own coordinates,
   * which `transform` takes to the shape's.
   */
  sample?(positions: ArrayLike<number>): Promise<ThreeMFVolumeSamples>;
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

/** Options of {@link parse3MFBoolean}. */
export interface ThreeMFBooleanOptions extends ThreeMFOptions {
  /** Evaluate each boolean shape and add its surface to the result. Default true. */
  evaluate?: boolean;
}

/** The result of {@link parse3MFBoolean}. */
export interface ThreeMFBooleanResult extends ThreeMFResult {
  /** Every boolean shape, each after the shapes it reads. */
  shapes: ThreeMFBooleanShape[];
}

/**
 * Parses a 3MF package with the boolean operations extension. Each boolean shape is evaluated exactly by
 * `@margoengine/mesh-edit` and its surface joins the result's triangles where the build places it, with the colours of
 * the surfaces it came from; the shapes are returned beside them with their operands' triangles and placements. A base
 * that is a displacement mesh or a level set is not evaluated here (`parse3MFEvaluated` evaluates one).
 *
 * @throws LoaderError for what the extension rules out (an unknown operation, a property on a shape, a base that is not
 * a `model` shape or has alternatives, an operand that is not a plain `model` mesh, a shape that reads itself or a later
 * object), an input that is not a closed solid, a base this entry does not evaluate, a built level set, and what
 * `parse3MF` throws.
 */
export async function parse3MFBoolean(
  input: BinaryInput,
  options: ThreeMFBooleanOptions = {},
): Promise<ThreeMFBooleanResult> {
  const stage = booleanStage(options),
    read = await read3MF(input, options, stage.hooks);
  return { ...read, shapes: stage.shapes };
}
