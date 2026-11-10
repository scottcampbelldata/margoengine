/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';
import { SpriteLayer, type SpriteLayerOptions } from './index.js';
import { Sprite, type SpriteOptions } from './sprite.js';

/** A resizable image. Borders are left, top, right, bottom in source texels. */
export interface SliceOptions extends SpriteOptions {
  rect: readonly [number, number, number, number];
  width: number;
  height: number;
  /** Default zero borders (a repeating fill). */
  borders?: readonly [number, number, number, number];
  /** Stretch the middle regions, or repeat them at native size. Default stretch. */
  middle?: 'stretch' | 'repeat';
  /** Pattern translation in destination units. Default 0. */
  scrollX?: number;
  scrollY?: number;
  /** Destination units per source texel in repeated regions. Default 1. */
  tileScaleX?: number;
  tileScaleY?: number;
}

/** Mutable dimensions and transforms, read on every frame by SliceLayer. */
export class SliceSprite extends Sprite {
  declare rect: readonly [number, number, number, number];
  width: number;
  height: number;
  borders: readonly [number, number, number, number];
  middle: 'stretch' | 'repeat';
  scrollX: number;
  scrollY: number;
  tileScaleX: number;
  tileScaleY: number;
  constructor(options: SliceOptions) {
    super(options);
    this.width = options.width;
    this.height = options.height;
    this.borders = options.borders ?? [0, 0, 0, 0];
    this.middle = options.middle ?? 'stretch';
    this.scrollX = options.scrollX ?? 0;
    this.scrollY = options.scrollY ?? 0;
    this.tileScaleX = options.tileScaleX ?? 1;
    this.tileScaleY = options.tileScaleY ?? 1;
  }
}

/** CPU layout shared with the GPU packer; at most nine instances, regardless of repeat count. */
export function sliceParts(s: SliceSprite): SpriteOptions[] {
  const [l, t, r, b] = s.borders,
    [rx, ry, w, h] = s.rect;
  if (
    !s.rect.every(Number.isInteger) ||
    rx < 0 ||
    ry < 0 ||
    w <= 0 ||
    h <= 0 ||
    !s.borders.every((v) => Number.isInteger(v) && v >= 0) ||
    l + r > w ||
    t + b > h ||
    ![s.width, s.height, s.scrollX, s.scrollY, s.tileScaleX, s.tileScaleY].every(Number.isFinite) ||
    s.width < 0 ||
    s.height < 0 ||
    s.tileScaleX <= 0 ||
    s.tileScaleY <= 0 ||
    !['stretch', 'repeat'].includes(s.middle)
  )
    throw rangeError('Invalid nine-slice dimensions or borders', 'sprite-options');
  const kx = l + r ? Math.min(1, s.width / (l + r)) : 1,
    ky = t + b ? Math.min(1, s.height / (t + b)) : 1,
    xs = [0, l * kx, s.width - r * kx, s.width],
    ys = [0, t * ky, s.height - b * ky, s.height],
    us = [rx, rx + l, rx + w - r, rx + w],
    vs = [ry, ry + t, ry + h - b, ry + h],
    out: SpriteOptions[] = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++) {
      const dw = xs[x + 1] - xs[x],
        dh = ys[y + 1] - ys[y],
        sw = us[x + 1] - us[x],
        sh = vs[y + 1] - vs[y];
      if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) continue;
      const repeatX = s.middle === 'repeat' && x === 1,
        repeatY = s.middle === 'repeat' && y === 1,
        px = s.flipX ? s.width - xs[x + 1] : xs[x],
        py = s.flipY ? s.height - ys[y + 1] : ys[y];
      out.push({
        x: s.x,
        y: s.y,
        z: s.z,
        rotation: s.rotation,
        pivotX: (s.pivotX * s.width - px) / dw,
        pivotY: (s.pivotY * s.height - py) / dh,
        scaleX: (s.scaleX * dw) / sw,
        scaleY: (s.scaleY * dh) / sh,
        flipX: s.flipX,
        flipY: s.flipY,
        rect: [us[x], vs[y], sw, sh],
        tint: s.tint,
        alpha: s.alpha,
        page: s.page,
        visible: s.visible,
        params: [
          repeatX ? dw / (sw * s.tileScaleX) : -1,
          repeatY ? dh / (sh * s.tileScaleY) : -1,
          repeatX && s.scrollX ? -s.scrollX / (sw * s.tileScaleX) : 0,
          repeatY && s.scrollY ? -s.scrollY / (sh * s.tileScaleY) : 0,
        ],
      });
    }
  return out;
}

/** Layer options. Normal maps and custom fragment effects use their own SpriteLayer. */
export type SliceLayerOptions = Omit<SpriteLayerOptions, 'shader' | 'normals'>;

const sliceShader = (pages: boolean, smooth: boolean) => ({
  code: `
${
  smooth
    ? `fn sliceSample(p:vec2f,s:SpriteInput)->vec4f{
  let dims=vec2f(textureDimensions(atlas));
  return textureSampleGrad(atlas,filtered,clamp(p,s.low+0.5,s.high+0.5)/dims${pages ? ',s.page' : ''},s.dx/dims*abs(s.params.xy),s.dy/dims*abs(s.params.xy));
}`
    : ''
}
fn effect(c:vec4f,s:SpriteInput)->vec4f{
  if(all(s.params.xy==vec2f(0))){return c;}
  let size=s.high-s.low+1;
  let uv=fract((s.texel-s.low)/size*abs(s.params.xy)+s.params.zw);
  let p=s.low+uv*size;
  ${
    smooth
      ? `// Repeated cell boundaries interpolate last-to-first, never into adjacent atlas cells.
  let edge=max(s.low+0.5-p,p-s.high-0.5);
  let weight=select(vec2f(0),max(edge,vec2f(0)),s.params.xy>vec2f(0));
  let shift=select(-size,size,p<s.low+0.5);
  let a=mix(sliceSample(p,s),sliceSample(p+vec2f(shift.x,0),s),weight.x);
  let b=mix(sliceSample(p+vec2f(0,shift.y),s),sliceSample(p+shift,s),weight.x);
  let f=mix(a,b,weight.y);
  return select(vec4f(encode(f.rgb/f.a)*s.tint.rgb,f.a*s.tint.a),vec4f(0),f.a==0);`
      : `return textureLoad(atlas,vec2i(clamp(floor(p),s.low,s.high)),${pages ? 's.page,' : ''}0)*s.tint;`
  }
}`,
});

/** Ordinary, sliced and scrolling tiled images share one instanced draw, atlas pages and draw order. */
export class SliceLayer extends SpriteLayer {
  private readonly sliced = new Map<SliceSprite, Sprite[]>();
  constructor(options: SliceLayerOptions) {
    super({ ...options, shader: sliceShader(Array.isArray(options.atlas), options.filter === 'linear') });
  }
  static override attach(instance: EngineKernel, options: SliceLayerOptions): SliceLayer {
    const layer = new SliceLayer(options);
    engineRuntime(instance).use(layer);
    return layer;
  }
  /** Adds a sliced image. Zero borders with middle repeat makes a tiling sprite. */
  addSlice(options: SliceOptions): SliceSprite {
    const s = new SliceSprite(options),
      parts = sliceParts(s).map((p) => this.add(p));
    while (parts.length < 9) parts.push(this.add({ visible: false }));
    this.sliced.set(s, parts);
    return s;
  }
  removeSlice(sprite: SliceSprite): boolean {
    const parts = this.sliced.get(sprite);
    if (!parts) return false;
    for (const p of parts) this.remove(p);
    return this.sliced.delete(sprite);
  }
  override clearSprites(): void {
    this.sliced.clear();
    super.clearSprites();
  }
  override onPreUpdate(delta: number): void {
    super.onPreUpdate(delta);
    for (const [sprite, parts] of this.sliced) {
      const layout = sliceParts(sprite);
      // Keep all nine slots allocated, even when a resize collapses one of the regions.
      while (parts.length < 9) parts.push(this.add({ visible: false }));
      for (let i = 0; i < parts.length; i++) {
        if (i < layout.length) Object.assign(parts[i], layout[i]);
        else parts[i].visible = false;
      }
    }
  }
}
