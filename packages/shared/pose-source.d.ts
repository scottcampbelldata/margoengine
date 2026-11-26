/** A primitive's current pose, evaluated on the CPU. */
export interface PrimitivePose {
  /**
   * The primitive's vertices at the pose, in its node's space and gltf/pbr's layout: 20 floats per vertex, position at
   * 0 and normal at 4 posed, the rest as in `primitive.vertices`. One array per primitive, rewritten in place.
   */
  readonly vertices: Float32Array;
  /** Changes whenever `vertices` was rewritten. */
  readonly revision: number;
}
/**
 * Evaluates the pose from the deformer's current inputs (node matrices, morph weights, cache frame), cached while they
 * are unchanged. Undefined when this deformer is not the one writing `primitive.deformed`, or cannot pose on the CPU.
 */
export type PoseSource = () => PrimitivePose | undefined;
/** Registers `source` as the CPU pose of `primitive`. */
export function setPoseSource(primitive: object, source: PoseSource): void;
/** Removes `source` if it is still the one registered for `primitive`. */
export function clearPoseSource(primitive: object, source: PoseSource): void;
/** The current pose of `primitive` from its registered source, or undefined when it has none (or the source declines). */
export function posedVertices(primitive: object): PrimitivePose | undefined;
