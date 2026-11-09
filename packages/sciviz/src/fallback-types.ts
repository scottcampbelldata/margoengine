// Type-only seam: the root never loads a fallback implementation.
import type { Engine } from '@margoengine/core/extension';
import type { Colormap } from './colormaps.js';
import type { Drawable, GlContext } from './render.js';

/** @internal Resources owned by one native WebGL2 layer. */
export interface FallbackDraw {
  update(uniform: Float32Array): void;
  draw(context: GlContext): void;
  dispose(): void;
}

/** @internal Implemented only by the optional WebGL2 entry. */
export interface FallbackBackend {
  setup(engine: Engine): void;
  render(context: GlContext, drawables: readonly Drawable[]): void;
  surface(
    data: ArrayLike<number>,
    nx: number,
    ny: number,
    colormap: Colormap,
  ): FallbackDraw & {
    setHeights(data: Float32Array): void;
  };
  rects(rects: Float32Array, colours: Uint32Array): FallbackDraw;
}
