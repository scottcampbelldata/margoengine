// The bed's collider (PA-37): a fixed body in a `Physics` world whose surface is the terrain bed, edited in place as the bed
// changes. The collider is the kernel's height field, whose grid and triangulation are the bed's (see `BedGrid` in
// `@margoengine/math/fields`), so a ray, a contact and `Bed.sample` agree. A change of the bed writes the new heights into the
// field's own rows (`PhysicsCollider.setHeights`): the field keeps its memory, so editing the ground every step allocates
// nothing, and what rests on it wakes: a body sitting on ground that is eroded away falls, and one on ground a slide buries
// is lifted.
import type { Bed, BedGrid } from '@margoengine/math/fields';
import type { PhysicsBody } from '../body.js';
import type { PhysicsCollider } from '../collider.js';
import type { Vec3 } from '../math.js';
import type { Physics } from '../physics.js';
import { bedVertexCount } from './bed.js';

/** Options of {@link BedCollider}. */
export interface BedColliderOptions {
  /** Where the bed's cell origin lies in the physics world, m (default the origin). */
  position?: Vec3;
  /** Friction of the ground (default 0.8, dry soil on a rubber or wood sole). */
  friction?: number;
  /** Restitution of the ground (default 0; soil does not bounce). */
  restitution?: number;
}

/**
 * A fixed collider that follows a terrain bed. Make it with the bed as it is, then call {@link BedCollider.sync} after the
 * world has stepped the bed (or any time the bed may have changed): it moves the vertices that differ and returns how many.
 *
 * Vertices are f32 in the kernel, so far from the cell's origin an elevation or an x or z is held to the f32 spacing there
 * (about 1 mm at 8,000 m); a large world steps each region in its own cell, as the framework does.
 */
export class BedCollider {
  /** The fixed body that holds the ground. */
  readonly body: PhysicsBody;
  /** The ground's collider, a height field. */
  readonly collider: PhysicsCollider;
  private readonly heights: Float32Array;
  private readonly grid: BedGrid;

  /**
   * @param physics The world the ground goes into; load it first (`await Physics.load()`).
   * @param bed The bed as it is now; its grid fixes the mesh.
   * @throws RangeError for a bed that is not a valid grid, or elevations that are not finite.
   */
  constructor(physics: Physics, bed: Bed, options: BedColliderOptions = {}) {
    const count = bedVertexCount(bed),
      { position = [0, 0, 0], friction = 0.8, restitution = 0 } = options;
    this.grid = {
      cell: bed.cell,
      columns: bed.columns,
      rows: bed.rows,
      width: bed.width,
      depth: bed.depth,
      centre: bed.centre,
    };
    const elevations = bed.elevations;
    if (elevations.length !== count)
      throw new RangeError(
        `A bed of ${bed.columns} by ${bed.rows} cells has ${count} vertices; got ${elevations.length} elevations.`,
      );
    this.heights = Float32Array.from(elevations);
    this.body = physics.addBody(null, {
      type: 'fixed',
      position: [position[0] + bed.centre[0], position[1], position[2] + bed.centre[1]],
      colliders: {
        shape: 'heightfield',
        rows: bed.rows,
        columns: bed.columns,
        heights: this.heights,
        scale: [bed.width, 1, bed.depth],
        fixInternalEdges: true,
        friction,
        restitution,
        massless: true,
      },
    });
    this.collider = this.body.colliders[0]!;
  }

  /**
   * Moves the collider's heights to `bed`'s elevations (the same grid), in place, waking what rests on it.
   * Nothing moves when no elevation differs, so it is cheap to call every step.
   * @returns How many vertices moved.
   * @throws RangeError for a bed of another grid than the collider's.
   */
  sync(bed: Bed): number {
    const g = this.grid;
    if (
      bed.columns !== g.columns ||
      bed.rows !== g.rows ||
      bed.width !== g.width ||
      bed.depth !== g.depth ||
      bed.centre[0] !== g.centre[0] ||
      bed.centre[1] !== g.centre[1]
    )
      throw new RangeError('This bed is another grid than the collider was made on; make a new BedCollider for it.');
    const elevations = bed.elevations,
      heights = this.heights;
    let moved = 0;
    for (let i = 0; i < elevations.length; i++) {
      // Compare the f32 the kernel holds, so a change below its resolution is no change.
      const y = Math.fround(elevations[i]!);
      if (heights[i] !== y) {
        heights[i] = y;
        moved++;
      }
    }
    if (moved > 0) this.collider.setHeights(heights);
    return moved;
  }
}
