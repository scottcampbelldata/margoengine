import { MargoError } from '@margoengine/math/errors';
import type {
  Physics,
  PhysicsBody,
  PhysicsCollider,
  WheelGroundContact,
  WheelGroundMaterial,
} from '@margoengine/physics';
import type { RoadMesh } from './index.js';

/** Measured limits at dry and fully wet endpoints on one road surface. */
export interface RoadTraction {
  readonly dry: number;
  readonly wet: number;
  /** Yielding substrate, with the same measured footprint as the optional vehicle contact model. */
  readonly soil?: WheelGroundMaterial['soil'];
}

/** Friction state of a physical collider, including a varying wetness service when supplied. */
export interface RoadSurfaceOptions {
  readonly traction: RoadTraction;
  /** 0 for dry and 1 for fully wet. Default 0. A callback can read the physics clock's held weather samples. */
  readonly wetness?: number | ((point: WheelGroundContact['point']) => number);
}

/** Settings for a collider that uses exactly the triangles of a built road or banked road. */
export interface RoadColliderOptions extends RoadSurfaceOptions {
  /** Offset from the physics world origin, m. Default [0, 0, 0]. */
  readonly position?: WheelGroundContact['point'];
}

export function roadGrip(traction: RoadTraction, wetness = 0): number {
  const { dry, wet } = traction;
  if (!(Number.isFinite(dry) && Number.isFinite(wet) && wet >= 0 && dry >= wet))
    throw new MargoError('state', 'Choose finite road grip coefficients with 0 ≤ wet ≤ dry.');
  if (!(Number.isFinite(wetness) && wetness >= 0 && wetness <= 1))
    throw new MargoError('state', 'Choose normalized road wetness between 0 and 1.');
  return dry + (wet - dry) * wetness;
}

/** Per-collider measured tyre grip and soil response. Pass `sample` as a Vehicle's `groundMaterial`. */
export class RoadSurfaces {
  private readonly materials = new WeakMap<PhysicsCollider, RoadSurfaceOptions>();

  /** Bind traction to an existing static road, moving deck, or terrain collider. */
  register(collider: PhysicsCollider, options: RoadSurfaceOptions): this {
    roadGrip(options.traction, typeof options.wetness === 'number' ? options.wetness : 0);
    const { traction, wetness } = options;
    this.materials.set(collider, { traction: { ...traction, soil: traction.soil && { ...traction.soil } }, wetness });
    return this;
  }

  /** Add one fixed, edge-corrected collider using the visible road's original bank and curb geometry. */
  add(physics: Physics, road: RoadMesh, options: RoadColliderOptions): PhysicsBody {
    const dry = roadGrip(options.traction);
    if (typeof options.wetness === 'number') roadGrip(options.traction, options.wetness);
    const { geometry } = road;
    const source = geometry.vertices;
    const vertices = new Float32Array(source.length / 2);
    for (let i = 0; i < source.length; i += 6) vertices.set(source.subarray(i, i + 3), i / 2);
    const body = physics.addBody(null, {
      type: 'fixed',
      position: options.position,
      colliders: { shape: 'trimesh', vertices, indices: geometry.indices, fixInternalEdges: true, friction: dry },
    });
    this.register(body.colliders[0]!, options);
    return body;
  }

  /** A sample is absent for other colliders, leaving their existing Vehicle behavior in place. */
  readonly sample = (contact: WheelGroundContact): WheelGroundMaterial | undefined => {
    const material = this.materials.get(contact.collider);
    if (!material) return;
    const wetness = typeof material.wetness === 'function' ? material.wetness(contact.point) : material.wetness;
    return { grip: roadGrip(material.traction, wetness), soil: material.traction.soil };
  };
}
