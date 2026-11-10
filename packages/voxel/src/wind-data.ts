/** Prepared per-block vertex motion, created by defineWindBlock in the optional wind entry. */
export interface VoxelBlockMotion {
  /** Foliage bends horizontally; liquid moves surface vertices vertically. */
  readonly kind: 'foliage' | 'liquid';
  /** Maximum displacement in blocks. */
  readonly amplitude: number;
  /** Angular phase change per second. */
  readonly speed: number;
  /** Spatial angular frequency in radians per block. */
  readonly frequency: number;
  /** Foliage root vertices remain fixed when true. */
  readonly rooted: boolean;
}
