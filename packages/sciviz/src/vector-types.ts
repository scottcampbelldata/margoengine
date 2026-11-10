/** Owned publication geometry in data coordinates. Colours are sRGB RGBA per vertex. */
export interface VectorGeometry {
  /** Triangle soup, connected line strip, or point centres. */
  readonly kind: 'triangles' | 'line' | 'points';
  /** Interleaved xyz. */
  readonly positions: ArrayLike<number>;
  /** Interleaved sRGB RGBA, default opaque light blue. */
  readonly colors?: ArrayLike<number>;
  /** CSS line width or point diameter, default 2 or 3. */
  readonly width?: number;
  /** CSS diameter per point, overrides width. */
  readonly sizes?: ArrayLike<number>;
  /** Round or square point markers, default round. */
  readonly shape?: 'round' | 'square';
  /** Independent vertex pairs instead of a connected line strip. Default false. */
  readonly segments?: boolean;
}
