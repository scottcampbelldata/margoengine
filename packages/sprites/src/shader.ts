// Custom fragment code per sprite layer, and ready-made effects: flash, outline, dissolve and palette swap. The code is
// a WGSL function `effect` the layer calls on each texel, so an app that draws plain sprites ships none of this.
import { rangeError, typeError } from '../../shared/errors.js';
import type { SpriteShader } from './index.js';
import { parseTint } from './sprite.js';

export type { SpriteShader } from './index.js';

/**
 * Wraps WGSL that defines `fn effect(color: vec4f, sprite: SpriteInput) -> vec4f` for a layer's `shader` option.
 * `color` is the tinted texel in atlas bytes over 255, straight alpha; return the colour to draw, alpha 0 to drop it.
 * `SpriteInput` holds `texel` (vec2f, atlas texels), `cell` (vec2i, the texel read), `low` and `high` (vec2f, the
 * rectangle's first and last texel), `params` (vec4f, the sprite's `params`), `tint` (vec4f, its tint and alpha) and `time` (f32, the layer's `time`).
 * `spriteTexel(sprite, offset: vec2i) -> vec4f` reads an untinted neighbour, transparent outside the rectangle.
 * @throws TypeError when `code` is not a string that defines `fn effect`.
 */
export function spriteShader(code: string): SpriteShader {
  if (typeof code !== 'string' || !/\bfn\s+effect\s*\(/.test(code))
    throw typeError('A sprite shader defines fn effect(color: vec4f, sprite: SpriteInput) -> vec4f', 'sprite-options');
  return Object.freeze({ code });
}

/** `0xrrggbb` or `'#rrggbb'` as a WGSL `vec3f` of bytes over 255, the way atlas texels read. */
const rgb = (color: number | string): string => {
  const value = parseTint(color);
  return `vec3f(${(value >> 16) / 255},${((value >> 8) & 255) / 255},${(value & 255) / 255})`;
};
const fraction = (value: number, name: string): number => {
  if (!(value >= 0 && value <= 1)) throw rangeError(`Invalid ${name}`, 'sprite-options');
  return value;
};

/** Mixes each texel toward `color` (default white) by the sprite's `params[0]`, 0 to 1: hit flashes. */
export function flashShader(color: number | string = 0xffffff): SpriteShader {
  return spriteShader(
    `fn effect(c:vec4f,s:SpriteInput)->vec4f{return vec4f(mix(c.rgb,${rgb(color)},s.params.x),c.a);}`,
  );
}

/** Options of {@link outlineShader}. */
export interface OutlineOptions {
  /** Outline colour. Default black. */
  color?: number | string;
  /** Reach in texels, 1 to 4, counting diagonals. Default 1. */
  width?: number;
}

/**
 * Fills transparent texels within `width` texels of an opaque one (alpha at least 0.5) with `color`, at the sprite's
 * `params[0]` opacity, 0 to 1. The outline stays inside the sprite's rectangle: leave transparent texels around the art.
 */
export function outlineShader({ color = 0, width = 1 }: OutlineOptions = {}): SpriteShader {
  if (!Number.isInteger(width) || width < 1 || width > 4) throw rangeError('Invalid outline width', 'sprite-options');
  return spriteShader(`fn effect(c:vec4f,s:SpriteInput)->vec4f{
  if(c.a>0||s.params.x<=0){return c;}
  for(var y=-${width};y<=${width};y++){for(var x=-${width};x<=${width};x++){
    if(spriteTexel(s,vec2i(x,y)).a>=0.5){return vec4f(${rgb(color)},s.params.x);}
  }}
  return c;
}`);
}

/** Options of {@link dissolveShader}. */
export interface DissolveOptions {
  /** Colour of the band at the dissolving edge. Default orange `#ff8020`. */
  edge?: number | string;
  /** Width of that band in progress, 0 to 1. Default 0.08. */
  band?: number;
}

/**
 * Dissolves texel by texel as the sprite's `params[0]` goes from 0 (whole) to 1 (gone), in an order set by a hash of
 * each texel, with a coloured band at the edge.
 */
export function dissolveShader({ edge = 0xff8020, band = 0.08 }: DissolveOptions = {}): SpriteShader {
  fraction(band, 'dissolve band');
  // A 2D integer hash (multiply, xor-shift), so each texel gets a fixed threshold in [0, 1).
  return spriteShader(`fn effect(c:vec4f,s:SpriteInput)->vec4f{
  var h=bitcast<vec2u>(s.cell)*vec2u(1597334677u,3812015801u);
  var n=(h.x^h.y)*1597334677u;
  n=n^(n>>16u);
  let r=f32(n>>8u)/16777216.0;
  if(r<s.params.x){return vec4f(0);}
  if(s.params.x>0&&r<s.params.x+${band}){return vec4f(${rgb(edge)},c.a);}
  return c;
}`);
}

/**
 * Swaps exact colours: a texel whose untinted bytes equal `from[i]` draws as `to[i]`, then takes the sprite's tint.
 * Up to 16 pairs. Made for `filter: 'nearest'`, where texels keep their bytes.
 * @throws RangeError when the lists differ in length, are empty or hold more than 16.
 */
export function paletteShader(from: readonly (number | string)[], to: readonly (number | string)[]): SpriteShader {
  if (!from.length || from.length !== to.length || from.length > 16)
    throw rangeError('Invalid palette: 1 to 16 pairs of colours', 'sprite-options');
  const cases = from
    .map((color, i) => `if(all(abs(t.rgb-${rgb(color)})<vec3f(0.5/255))){return vec4f(${rgb(to[i])}*s.tint.rgb,c.a);}`)
    .join('\n  ');
  return spriteShader(`fn effect(c:vec4f,s:SpriteInput)->vec4f{
  let t=spriteTexel(s,vec2i(0));
  ${cases}
  return c;
}`);
}
