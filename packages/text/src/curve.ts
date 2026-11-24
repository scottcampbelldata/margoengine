/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { multiplyMatrices } from '@margoengine/math/mat4';
import type { Vec3 } from '@margoengine/math';
import { layoutText, type TextLayout } from './layout.js';
import { Text, type TextOptions } from './text.js';
import type { TextRenderer } from './renderer.js';

/** Map a flat local text point onto a vertical cylinder. Radius sign selects bend direction; Infinity is flat. */
export function curvePoint(x: number, y: number, radius: number): [number, number, number] {
  if (![x, y].every(Number.isFinite) || Number.isNaN(radius) || radius === 0)
    throw new RangeError('Curve coordinates must be finite and radius nonzero; use Infinity for flat text');
  if (!Number.isFinite(radius)) return [x, y, 0];
  const angle = x / radius;
  // Half-angle form avoids cancellation on nearly flat cylinders.
  return [radius * Math.sin(angle), y, 2 * radius * Math.sin(angle / 2) ** 2];
}

/** Cylindrical text options, retaining all normal Text layout and appearance options. */
export interface CurvedTextOptions extends TextOptions {
  /** Signed cylinder radius in world units. Default 1. Infinity is flat. */
  curveRadius?: number;
  /** Horizontal subdivisions per glyph, integer 1..256. Default 8. */
  curveSegments?: number;
}

/** A single TextRenderer member bent continuously around its local Y axis. */
export class CurvedText extends Text {
  curveRadius: number;
  curveSegments: number;
  constructor(options: CurvedTextOptions = {}) {
    super(options);
    this.curveRadius = options.curveRadius ?? 1;
    this.curveSegments = options.curveSegments ?? 8;
  }
  override get layout(): TextLayout {
    curvePoint(0, 0, this.curveRadius);
    if (!Number.isInteger(this.curveSegments) || this.curveSegments < 1 || this.curveSegments > 256)
      throw new RangeError('curveSegments must be an integer in 1..256; reduce the glyph subdivision count');
    const layout = super.layout;
    layout.curveRadius = Number.isFinite(this.curveRadius) ? this.curveRadius : 0;
    layout.curveSegments = this.curveSegments;
    return layout;
  }
  /** Hit-test a cylinder-local surface point, before the block transform. */
  hitTestSurface(x: number, y: number, z: number): number {
    if (!Number.isFinite(z)) throw new RangeError('Surface z must be finite; pass a local surface point');
    const r = this.curveRadius;
    return this.hitTest(Number.isFinite(r) ? r * Math.atan2(x / r, 1 - z / r) : x, y);
  }
}

/** An orthogonal path frame at an arc distance, in block-local world units. */
export interface TextPathFrame {
  /** Point on the baseline path. */
  position: Vec3;
  /** Forward vector; normalized by PathText. */
  tangent: Vec3;
  /** Glyph-up vector; projected off the tangent and normalized. */
  normal: Vec3;
}

/** Arc-length path interface, compatible with adapters for analytic curves and spline frames. */
export interface TextPath {
  /** Finite positive path length. */
  length: number;
  /** Frame at distance in world units. The caller supplies distances within 0..length. */
  sample(distance: number): TextPathFrame;
}

/** Path text options. */
export interface PathTextOptions extends TextOptions {
  /** Arc-length path, with a consistent glyph-up frame. */
  path: TextPath;
  /** Distance added to the flat layout x coordinates. Default 0. */
  startOffset?: number;
  /** True repeats around a closed path; false hides glyph midpoints outside its extent. Default false. */
  closed?: boolean;
}

const unit = (v: Vec3): [number, number, number] => {
  const length = Math.hypot(...v);
  if (v.length !== 3 || !v.every(Number.isFinite) || !length)
    throw new MargoError('failed', 'Text path has a degenerate frame; supply finite nonzero tangent and normal vectors');
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Glyphs aligned to arc-length path frames, preserving wrapping, bidi order and shaped runs.
 * Call update after changing text, fonts, layout, styles or the path. Each nonspace shaped item uses one Text.
 */
export class PathText {
  /** Current unwarped layout, including source ranges and line boxes. */
  layout!: TextLayout;
  /** Underlying renderer members, in visual order. */
  readonly texts: Text[] = [];
  private renderer?: TextRenderer;
  private disposed = false;
  /** Mutable owned settings; update applies changes atomically. */
  readonly options: PathTextOptions;
  constructor(options: PathTextOptions) { this.options = { ...options }; this.update(); }
  /** Atomically rebuild the path placement from options. */
  update(options: Partial<PathTextOptions> = {}): this {
    if (this.disposed) throw new MargoError('disposed', 'PathText is disposed; create a new PathText');
    const settings = { ...this.options, ...options }, path = settings.path;
    if (!path || !(path.length > 0) || !Number.isFinite(path.length) || !Number.isFinite(settings.startOffset ?? 0))
      throw new RangeError('Text path length must be positive and offset finite; supply an arc-length path');
    if (settings.billboard) throw new MargoError('unsupported', 'Path frames set glyph orientation; set billboard to false');
    const base = new Text(settings), layout = layoutText(base.text, settings, base.font), next: Text[] = [];
    for (const g of layout.glyphs) {
      if (g.whitespace) continue;
      let distance = g.x + g.advance / 2 + (settings.startOffset ?? 0);
      if (settings.closed) distance = ((distance % path.length) + path.length) % path.length;
      else if (distance < 0 || distance > path.length) continue;
      const frame = path.sample(distance), t = unit(frame.tangent);
      if (frame.position.length !== 3 || !frame.position.every(Number.isFinite))
        throw new MargoError('failed', 'Text path position is invalid; supply three finite coordinates');
      const projection = frame.normal[0] * t[0] + frame.normal[1] * t[1] + frame.normal[2] * t[2];
      const n = unit([frame.normal[0] - projection * t[0], frame.normal[1] - projection * t[1], frame.normal[2] - projection * t[2]]);
      const z = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
      const matrix = new Float32Array([t[0],t[1],t[2],0,n[0],n[1],n[2],0,z[0],z[1],z[2],0,
        frame.position[0] - t[0] * g.advance / 2 + n[0] * g.y,
        frame.position[1] - t[1] * g.advance / 2 + n[1] * g.y,
        frame.position[2] - t[2] * g.advance / 2 + n[2] * g.y,1]);
      const text = new Text({ ...settings, text: g.cluster, font: base.font, maxWidth: Infinity,
        anchorX: 'left', anchorY: 'baseline', direction: g.rtl ? 'rtl' : 'ltr' });
      text.setMatrix(multiplyMatrices(base.matrix, matrix, new Float32Array(16)));
      next.push(text);
    }
    for (const text of this.texts) text.dispose();
    this.texts.splice(0, this.texts.length, ...next);
    Object.assign(this.options, settings);
    this.layout = layout;
    if (this.renderer) for (const text of this.texts) this.renderer.add(text);
    return this;
  }
  /** Attach the glyphs to a renderer. */
  addTo(renderer: TextRenderer): this {
    if (this.disposed) throw new MargoError('disposed', 'PathText is disposed; create a new PathText');
    if (this.renderer && this.renderer !== renderer) for (const text of this.texts) this.renderer.remove(text);
    for (const text of this.texts) renderer.add(text);
    this.renderer = renderer;
    return this;
  }
  /** Detach the glyphs; this object remains reusable. */
  removeFrom(renderer: TextRenderer): this {
    for (const text of this.texts) renderer.remove(text);
    if (this.renderer === renderer) this.renderer = undefined;
    return this;
  }
  /** Release glyph renderer memberships. */
  dispose(): void { for (const text of this.texts) text.dispose(); this.texts.length = 0; this.renderer = undefined; this.disposed = true; }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}
