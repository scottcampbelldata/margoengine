// The terrain-bed contract of the physics framework (docs/physics-framework.md, section 4, "terrain bed"; PA-37): one bed
// elevation that erosion, slides and craters write and that colliders, water and hooves read. A bed is a regular grid of
// elevations at its vertices, laid out as the physics kernel's height field is (rows along z, columns along x, column
// major) and cut into triangles the way the kernel cuts it, so a collider, a ray and `sample` all see one surface. Types
// only: this entry has no code, so importing it costs nothing.

/** An integer origin cell of a large world: three whole numbers (see `FlowCell`). */
type BedCell = readonly [number, number, number];

/**
 * Where a bed's grid lies and how fine it is. The grid has `columns` cells along x and `rows` along z, so
 * `(columns + 1) * (rows + 1)` vertices. Vertex (row r, column c) sits at
 * `x = centre[0] - width / 2 + width * c / columns` and `z = centre[1] - depth / 2 + depth * r / rows`, and its elevation is
 * element `r + (rows + 1) * c` of the elevations. Each cell is two triangles split along the diagonal from (r + 1, c) to
 * (r, c + 1), the kernel's split.
 */
export interface BedGrid {
  /** The origin cell `centre` is an offset from; a reader in another cell converts through the cell difference. */
  readonly cell: BedCell;
  /** Cells along x. */
  readonly columns: number;
  /** Cells along z. */
  readonly rows: number;
  /** The grid's size along x, m. */
  readonly width: number;
  /** The grid's size along z, m. */
  readonly depth: number;
  /** The grid's centre, [x, z] m from the cell's origin. */
  readonly centre: readonly [number, number];
}

/** What a bed gives at a point: the elevation of the surface and the unit normal of the triangle there. */
export interface BedSample {
  /** Elevation above the datum, m (y up). */
  elevation: number;
  /** The surface's unit normal, pointing up. */
  normal: [number, number, number];
}

/**
 * The terrain bed: a grid of elevations that can be sampled anywhere. `sample` is pure: the same point and the same
 * elevations give the same answer. Outside the grid the bed continues at its border's elevation (a point is clamped onto the
 * grid), so a reader never falls off the world; a body that must stop at the edge puts a wall there.
 */
export interface Bed extends BedGrid {
  /** The vertex elevations, m, in the grid's layout. A reader that keeps this must re-read it after the world's memory grows. */
  readonly elevations: ArrayLike<number>;
  /** The surface at (x, z) m from the cell's origin. Writes into `out` when given (no allocation) and returns it. */
  sample(x: number, z: number, out?: BedSample): BedSample;
}
