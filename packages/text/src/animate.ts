/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { eulerToQuaternion } from '@margoengine/math/quat';
import { parseColor } from './color.js';
import { Font } from './font.js';
import { layoutText, type TextLayout } from './layout.js';
import { compose, finiteArray, identity, type Mat4 } from './math.js';
import type { TextRenderer } from './renderer.js';
import { Text, type TextOptions, type TextStyleOptions } from './text.js';

/** Per-glyph animated state. */
export interface AnimatedGlyph {
  /** The grapheme cluster or shaped run of this glyph. */
  readonly cluster: string;
  /** UTF-16 offset of the glyph in the original text. */
  readonly index: number;
  /** 0-based glyph index in this animated text. */
  readonly glyphIndex: number;
  /** Original layout position [x, y, z] in local space. */
  readonly origin: readonly [number, number, number];
  /** Local displacement [dx, dy, dz] from origin in world units. */
  offset: [number, number, number];
  /** Scale multiplier: uniform number or [sx, sy, sz]. */
  scale: number | [number, number, number];
  /** Local XYZ Euler rotation in radians. */
  rotation: [number, number, number];
  /** Color override in linear RGB [r, g, b] (0..1), or undefined to use block color. */
  color?: [number, number, number];
  /** Opacity multiplier (0..1). */
  opacity: number;
  /** Whether the glyph is rendered. */
  visible: boolean;
  /** The underlying Text block that renders this glyph quad. */
  readonly text: Text;
  /** Resets offset, scale, rotation, color, opacity and visibility to base defaults. */
  reset(): void;
}

/** Options for {@link AnimatedText}. */
export interface AnimatedTextOptions extends TextOptions {
  /**
   * Pivot for glyph rotation and scaling:
   * - 'center': expands and rotates around the glyph's advance/em center.
   * - 'baseline': pivots around the pen position on the baseline.
   * Default 'center'.
   */
  pivot?: 'center' | 'baseline';
  /** If given, automatically adds the animated glyphs to this renderer. */
  renderer?: TextRenderer;
}

/** Options for {@link AnimatedText.typewriter}. */
export interface TypewriterOptions {
  /** Progress from 0 (all hidden) to 1 (all revealed). Overrides `count` if given. */
  progress?: number;
  /** Exact number of glyphs to reveal (0 to total). */
  count?: number;
  /** Whether the currently appearing glyph fades in smoothly. Default false. */
  fade?: boolean;
  /** Whether the currently appearing glyph pops in with scale. Default false. */
  pop?: boolean;
  /** Initial scale multiplier when `pop` is true. Default 1.5. */
  popScale?: number;
}

/** Options for {@link AnimatedText.wave}. */
export interface WaveOptions {
  /** Frequency of time oscillation in rad/s. Default 4. */
  speed?: number;
  /** Phase shift between successive glyphs. Default 0.3. */
  frequency?: number;
  /** Displacement amplitude in world units. Default 0.1. */
  amplitude?: number;
  /** Axis of displacement: 'x', 'y' or 'z'. Default 'y'. */
  axis?: 'x' | 'y' | 'z';
  /** Base phase offset in radians. Default 0. */
  phase?: number;
}

/** Options for {@link AnimatedText.bounce}. */
export interface BounceOptions {
  /** Oscillation speed in rad/s. Default 5. */
  speed?: number;
  /** Phase shift between successive glyphs. Default 0.4. */
  frequency?: number;
  /** Bounce height in world units. Default 0.2. */
  height?: number;
}

/** Options for {@link AnimatedText.fade}. */
export interface FadeOptions {
  /** Stagger delay between glyphs as a fraction of overall progress. Default 0.1. */
  stagger?: number;
  /** Duration of each glyph's fade as a fraction of progress. Default 0.3. */
  fadeDuration?: number;
}

/** Options for {@link AnimatedText.colorWave}. */
export interface ColorWaveOptions {
  /** Cycling speed in rad/s. Default 2. */
  speed?: number;
  /** Phase step between successive glyphs. Default 0.25. */
  frequency?: number;
  /** Sequence of linear RGB colors to cycle through. Default rainbow cycle. */
  colors?: Array<readonly [number, number, number]>;
}

const DEFAULT_RAINBOW: Array<readonly [number, number, number]> = [
  [1, 0.2, 0.2],
  [1, 0.7, 0.1],
  [0.9, 1, 0.2],
  [0.2, 0.9, 0.3],
  [0.2, 0.7, 1],
  [0.7, 0.3, 1],
];

/**
 * Animated 3D text with per-glyph control over position, scale, rotation, color and opacity.
 *
 * Each glyph in the block is driven independently while preserving global typography, wrapping,
 * alignment and baseline metrics. Built-in presets include typewriter reveals, wave motion,
 * bouncing and color waves, alongside an `each` iterator for custom procedural effects.
 */
export class AnimatedText {
  private _text: string;
  font: Font;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  ligatures: boolean;
  maxWidth: number;
  textAlign: TextOptions['textAlign'];
  anchorX: TextOptions['anchorX'];
  anchorY: TextOptions['anchorY'];
  direction: TextOptions['direction'];
  whiteSpace: TextOptions['whiteSpace'];
  overflowWrap: TextOptions['overflowWrap'];

  /** Base fill color in linear RGB [r, g, b]. Default white. */
  readonly color = new Float32Array([1, 1, 1]);
  opacity = 1;
  outlineWidth = 0;
  readonly outlineColor = new Float32Array([0, 0, 0]);
  outlineOpacity = 1;
  readonly shadowColor = new Float32Array([0, 0, 0]);
  shadowOpacity = 0;
  shadowBlur = 0;
  readonly shadowOffset = new Float32Array(2);
  billboard = false;
  onTop = false;
  visible = true;
  pivot: 'center' | 'baseline' = 'center';

  /** Block model matrix. */
  readonly matrix = identity();
  private isMatrixIdentity = true;
  private target: Mesh | null = null;
  private attachedRenderer?: TextRenderer;

  /** Animated glyph items. */
  readonly glyphs: AnimatedGlyph[] = [];
  /** Underlying Text blocks (one per non-whitespace glyph), suitable for adding to a TextRenderer. */
  readonly texts: Text[] = [];

  private _layout?: TextLayout;
  private readonly tempMat = identity();
  private readonly blockOptions: AnimatedTextOptions;

  constructor(options: AnimatedTextOptions = {}) {
    this.blockOptions = { ...options };
    const {
      text = '',
      font,
      fontSize = 1,
      lineHeight = 1.2,
      letterSpacing = 0,
      ligatures = false,
      maxWidth = Infinity,
      textAlign = 'left',
      anchorX = 'left',
      anchorY = 'top',
      direction = 'auto',
      whiteSpace = 'normal',
      overflowWrap = 'break-word',
      pivot = 'center',
      position,
      rotation,
      scale,
      matrix,
      mesh = null,
      renderer,
      ...styles
    } = options;

    this._text = text;
    this.font = font instanceof Font ? font : new Font(font);
    this.fontSize = fontSize;
    this.lineHeight = lineHeight;
    this.letterSpacing = letterSpacing;
    this.ligatures = ligatures;
    this.maxWidth = maxWidth;
    this.textAlign = textAlign;
    this.anchorX = anchorX;
    this.anchorY = anchorY;
    this.direction = direction;
    this.whiteSpace = whiteSpace;
    this.overflowWrap = overflowWrap;
    this.pivot = pivot;
    this.target = mesh;

    this.shadowOffset.set([0.04 * fontSize, -0.04 * fontSize]);
    this.setStyle(styles);

    if (matrix) this.setMatrix(matrix);
    else if (position || rotation || scale !== undefined)
      this.setTransform(position ?? [0, 0, 0], rotation ?? [0, 0, 0], scale ?? 1);

    this.rebuild();
    if (renderer) this.addTo(renderer);
  }

  get text(): string {
    return this._text;
  }
  set text(value: string) {
    if (typeof value !== 'string') throw new TypeError('text must be a string; pass text content');
    if (this._text === value) return;
    this._text = value;
    this.rebuild();
  }

  get layout(): TextLayout {
    return this._layout!;
  }

  get bounds(): { left: number; right: number; top: number; bottom: number } {
    return this._layout!.bounds;
  }

  get length(): number {
    return this.glyphs.length;
  }

  /** Sets styles across all glyphs in this block. */
  setStyle(options: TextStyleOptions): this {
    const {
      color,
      outlineColor,
      shadowColor,
      shadowOffset,
      opacity,
      outlineWidth,
      outlineOpacity,
      shadowOpacity,
      shadowBlur,
      billboard,
      onTop,
    } = options;
    if (color !== undefined) parseColor(color, this.color);
    if (outlineColor !== undefined) parseColor(outlineColor, this.outlineColor);
    if (shadowColor !== undefined) parseColor(shadowColor, this.shadowColor);
    if (shadowOffset !== undefined) {
      finiteArray(shadowOffset, 2, 'shadowOffset');
      this.shadowOffset.set(shadowOffset);
    }
    if (opacity !== undefined) this.opacity = opacity;
    if (outlineWidth !== undefined) this.outlineWidth = outlineWidth;
    if (outlineOpacity !== undefined) this.outlineOpacity = outlineOpacity;
    if (shadowOpacity !== undefined) this.shadowOpacity = shadowOpacity;
    if (shadowBlur !== undefined) this.shadowBlur = shadowBlur;
    if (billboard !== undefined) this.billboard = billboard;
    if (onTop !== undefined) this.onTop = onTop;
    return this;
  }

  /** Sets the block's local position, Euler rotation and scale. */
  setTransform(position: Vec3, rotation: Vec3 = [0, 0, 0], scale: number | Vec3 = 1): this {
    const s: Vec3 = typeof scale === 'number' ? [scale, scale, scale] : scale;
    finiteArray(position, 3, 'position');
    finiteArray(rotation, 3, 'rotation');
    finiteArray(s, 3, 'scale');
    if (s.some((v) => v === 0)) throw new RangeError('scale must be nonzero; pass positive or negative scale');
    compose(this.matrix, position, eulerToQuaternion(rotation[0], rotation[1], rotation[2]), s);
    this.isMatrixIdentity = false;
    this.apply();
    return this;
  }

  /** Sets the block's transformation matrix directly. */
  setMatrix(matrix: Mat4): this {
    finiteArray(matrix, 16, 'matrix');
    for (let i = 0; i < 16; i++) this.matrix[i] = matrix[i];
    this.isMatrixIdentity = false;
    this.apply();
    return this;
  }

  /** Attaches this text block to a core mesh. */
  attach(mesh: Mesh | null): this {
    this.target = mesh;
    for (const t of this.texts) t.attach(mesh);
    return this;
  }

  /** Adds all underlying glyph Text blocks to `renderer`. */
  addTo(renderer: TextRenderer): this {
    this.attachedRenderer = renderer;
    for (const t of this.texts) renderer.add(t);
    return this;
  }

  /** Removes all underlying glyph Text blocks from `renderer`. */
  removeFrom(renderer: TextRenderer): this {
    if (this.attachedRenderer === renderer) this.attachedRenderer = undefined;
    for (const t of this.texts) renderer.remove(t);
    return this;
  }

  /** Iterates over each glyph and calls `fn`. Updates the glyphs afterwards. */
  each(fn: (glyph: AnimatedGlyph, index: number, total: number) => void): this {
    const total = this.glyphs.length;
    for (let i = 0; i < total; i++) fn(this.glyphs[i], i, total);
    this.apply();
    return this;
  }

  /**
   * Typewriter reveal effect.
   *
   * @param progressOrOptions Progress from 0..1 or a {@link TypewriterOptions} configuration object.
   */
  typewriter(progressOrOptions: number | TypewriterOptions): this {
    const opts: TypewriterOptions =
      typeof progressOrOptions === 'number' ? { progress: progressOrOptions } : progressOrOptions;
    const total = this.glyphs.length;
    if (!total) return this;

    let targetCount = 0;
    let frac = 0;
    if (opts.progress !== undefined) {
      const p = Math.max(0, Math.min(1, opts.progress));
      const val = p * total;
      targetCount = Math.floor(val);
      frac = val - targetCount;
      if (p >= 1) {
        targetCount = total;
        frac = 0;
      }
    } else if (opts.count !== undefined) {
      targetCount = Math.max(0, Math.min(total, Math.round(opts.count)));
      frac = 0;
    } else {
      targetCount = total;
    }

    const popScale = opts.popScale ?? 1.5;
    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      if (i < targetCount) {
        g.visible = true;
        g.opacity = 1;
        g.scale = 1;
      } else if (i === targetCount && frac > 0) {
        g.visible = true;
        g.opacity = opts.fade ? frac : 1;
        g.scale = opts.pop ? 1 + (popScale - 1) * (1 - frac) : 1;
      } else {
        g.visible = false;
        g.opacity = 0;
        g.scale = 1;
      }
    }
    this.apply();
    return this;
  }

  /**
   * Moves glyphs in a traveling sinusoidal wave.
   *
   * @param time Time value in seconds.
   * @param options Wave parameters.
   */
  wave(time: number, options: WaveOptions = {}): this {
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new RangeError('time must be a finite number; pass seconds');
    const speed = options.speed ?? 4,
      freq = options.frequency ?? 0.3,
      amp = options.amplitude ?? 0.1,
      axis = options.axis ?? 'y',
      basePhase = options.phase ?? 0;
    const total = this.glyphs.length;
    const axisIndex = axis === 'x' ? 0 : axis === 'z' ? 2 : 1;

    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      g.offset[axisIndex] = Math.sin(time * speed + i * freq + basePhase) * amp;
    }
    this.apply();
    return this;
  }

  /**
   * Bounces glyphs upward in a staggered wave.
   */
  bounce(time: number, options: BounceOptions = {}): this {
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new RangeError('time must be a finite number; pass seconds');
    const speed = options.speed ?? 5,
      freq = options.frequency ?? 0.4,
      height = options.height ?? 0.2;
    const total = this.glyphs.length;

    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      g.offset[1] = Math.max(0, Math.sin(time * speed + i * freq)) * height;
    }
    this.apply();
    return this;
  }

  /**
   * Staggered fade in/out of glyphs based on `progress` (0..1).
   */
  fade(progress: number, options: FadeOptions = {}): this {
    if (typeof progress !== 'number' || !Number.isFinite(progress))
      throw new RangeError('progress must be a finite number 0..1');
    const p = Math.max(0, Math.min(1, progress)),
      stagger = options.stagger ?? 0.1,
      fadeDuration = options.fadeDuration ?? 0.3,
      total = this.glyphs.length;
    if (!total) return this;

    const span = 1 + (total - 1) * stagger;
    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      const start = (i * stagger) / span;
      const end = start + fadeDuration / span;
      if (p <= start) {
        g.opacity = 0;
        g.visible = false;
      } else if (p >= end) {
        g.opacity = 1;
        g.visible = true;
      } else {
        g.opacity = (p - start) / (end - start);
        g.visible = g.opacity > 0.001;
      }
    }
    this.apply();
    return this;
  }

  /**
   * Cycles colors across glyphs in a traveling rainbow or custom palette wave.
   */
  colorWave(time: number, options: ColorWaveOptions = {}): this {
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new RangeError('time must be a finite number; pass seconds');
    const speed = options.speed ?? 2,
      freq = options.frequency ?? 0.25,
      colors = options.colors ?? DEFAULT_RAINBOW,
      n = colors.length,
      total = this.glyphs.length;
    if (n < 2) throw new RangeError('colors must have at least 2 entries; provide color palette');

    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      const t = (((time * speed + i * freq) % n) + n) % n;
      const i0 = Math.floor(t) % n;
      const i1 = (i0 + 1) % n;
      const f = t - Math.floor(t);
      const c0 = colors[i0],
        c1 = colors[i1];
      g.color = [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
    this.apply();
    return this;
  }

  /** Resets all glyph offsets, scales, rotations, colors, opacities and visibility to initial state. */
  reset(): this {
    for (const g of this.glyphs) g.reset();
    this.apply();
    return this;
  }

  /** Recomputes layout and builds per-glyph Text instances. */
  private rebuild(): void {
    if (this.attachedRenderer) {
      for (const t of this.texts) this.attachedRenderer.remove(t);
    }
    for (const t of this.texts) t.dispose();
    this.texts.length = 0;
    this.glyphs.length = 0;

    const layout = layoutText(
      this._text,
      {
        fontSize: this.fontSize,
        lineHeight: this.lineHeight,
        letterSpacing: this.letterSpacing,
        ligatures: this.ligatures,
        maxWidth: this.maxWidth,
        textAlign: this.textAlign,
        anchorX: this.anchorX,
        anchorY: this.anchorY,
        direction: this.direction,
        whiteSpace: this.whiteSpace,
        overflowWrap: this.overflowWrap,
      },
      this.font,
    );
    this._layout = layout;

    let glyphIndex = 0;
    for (const g of layout.glyphs) {
      if (g.whitespace) continue;
      const textBlock = new Text({
        text: g.cluster,
        font: this.font,
        fontSize: this.fontSize,
        anchorX: 'left',
        anchorY: 'baseline',
        mesh: this.target,
        billboard: this.billboard,
        onTop: this.onTop,
      });
      textBlock.outlineWidth = this.outlineWidth;
      textBlock.outlineOpacity = this.outlineOpacity;
      textBlock.shadowOpacity = this.shadowOpacity;
      textBlock.shadowBlur = this.shadowBlur;
      textBlock.shadowOffset.set(this.shadowOffset);
      textBlock.outlineColor.set(this.outlineColor);
      textBlock.shadowColor.set(this.shadowColor);

      const origin: [number, number, number] = [g.x, g.y, 0];
      const item: AnimatedGlyph = {
        cluster: g.cluster,
        index: g.index,
        glyphIndex: glyphIndex++,
        origin,
        offset: [0, 0, 0],
        scale: 1,
        rotation: [0, 0, 0],
        color: undefined,
        opacity: 1,
        visible: true,
        text: textBlock,
        reset() {
          this.offset[0] = this.offset[1] = this.offset[2] = 0;
          this.scale = 1;
          this.rotation[0] = this.rotation[1] = this.rotation[2] = 0;
          this.color = undefined;
          this.opacity = 1;
          this.visible = true;
        },
      };

      this.glyphs.push(item);
      this.texts.push(textBlock);
    }

    if (this.attachedRenderer) {
      for (const t of this.texts) this.attachedRenderer.add(t);
    }

    this.apply();
  }

  /**
   * Applies all glyph offsets, scales, rotations, colors, opacities and visibility to the underlying Text instances.
   * Called automatically after animation methods.
   */
  apply(): this {
    const total = this.glyphs.length;
    if (!total) return this;
    const layout = this._layout!;
    const ascent = layout.ascent,
      descent = layout.descent;
    const isBaselinePivot = this.pivot === 'baseline';

    const m = this.tempMat;
    const baseColor = this.color;
    const blockOpacity = this.opacity;
    const isIdentity = this.isMatrixIdentity;

    for (let i = 0; i < total; i++) {
      const g = this.glyphs[i];
      const t = g.text;

      if (!this.visible || !g.visible || g.opacity <= 0) {
        t.visible = false;
        continue;
      }
      t.visible = true;

      const px = g.origin[0] + g.offset[0],
        py = g.origin[1] + g.offset[1],
        pz = g.origin[2] + g.offset[2];

      const s = g.scale;
      const sx = typeof s === 'number' ? s : s[0],
        sy = typeof s === 'number' ? s : s[1],
        sz = typeof s === 'number' ? s : s[2];

      const rot = g.rotation;
      const q = eulerToQuaternion(rot[0], rot[1], rot[2]);

      if (isBaselinePivot) {
        compose(m, [px, py, pz], q, [sx, sy, sz]);
      } else {
        // Center pivot based on advance and em metrics
        const cx = (t.layout.glyphs[0]?.advance ?? this.fontSize * 0.5) * 0.5;
        const cy = (ascent - descent) * 0.5;

        // Compose rotation and scale without translation into m
        compose(m, [0, 0, 0], q, [sx, sy, sz]);

        // Translation column: (p + c) - A * c
        m[12] = px + cx - (m[0] * cx + m[4] * cy);
        m[13] = py + cy - (m[1] * cx + m[5] * cy);
        m[14] = pz - (m[2] * cx + m[6] * cy);
        m[15] = 1;
      }

      if (isIdentity) {
        t.setMatrix(m);
      } else {
        // Multiply block matrix by glyph matrix
        const finalMat = new Float32Array(16);
        multiplyMatrices(this.matrix, m, finalMat);
        t.setMatrix(finalMat);
      }

      t.opacity = g.opacity * blockOpacity;
      if (g.color) {
        t.color[0] = g.color[0];
        t.color[1] = g.color[1];
        t.color[2] = g.color[2];
      } else {
        t.color[0] = baseColor[0];
        t.color[1] = baseColor[1];
        t.color[2] = baseColor[2];
      }
    }
    return this;
  }

  /** Releases all underlying Text resources and removes them from the renderer. */
  dispose(): void {
    if (this.attachedRenderer) {
      for (const t of this.texts) this.attachedRenderer.remove(t);
      this.attachedRenderer = undefined;
    }
    for (const t of this.texts) t.dispose();
    this.texts.length = 0;
    this.glyphs.length = 0;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
