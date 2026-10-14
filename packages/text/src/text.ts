import type {Mesh} from '@margoengine/core';
import {parseColor, type ColorInput} from './color.js';
import {Font, type FontOptions} from './font.js';
import {caretRect, hitTest, layoutText, validateLayoutOptions, type AnchorX, type AnchorY, type LayoutOptions, type TextAlign, type TextDirection, type TextLayout} from './layout.js';
import {eulerToQuaternion} from '@margoengine/math/quat';
import {compose, finiteArray, identity, type Mat4} from './math.js';

type Vec3 = readonly [number, number, number];

export interface TextStyleOptions {
  /** Fill color. Default white. */
  color?: ColorInput;
  /** 0..1, applied to fill, outline and shadow. Default 1. */
  opacity?: number;
  /** Outline width in world units (like fontSize); clamped to about 0.14 em by the SDF range. Default 0. */
  outlineWidth?: number;
  /** Default black. */
  outlineColor?: ColorInput;
  /** 0..1. Default 1. */
  outlineOpacity?: number;
  /** Default black. */
  shadowColor?: ColorInput;
  /** 0..1; 0 disables the shadow. Default 0. */
  shadowOpacity?: number;
  /** Shadow softness in world units; clamped with the outline to the SDF range. Default 0. */
  shadowBlur?: number;
  /** Shadow offset in the text plane, world units, x right and y up. Default [0.04, -0.04] times fontSize at construction. */
  shadowOffset?: readonly [number, number];
  /** Face the camera at the block's origin instead of following the model matrix's rotation. Default false. */
  billboard?: boolean;
  /** Skip the depth test and draw over the scene. Default false. */
  onTop?: boolean;
}

export interface TextOptions extends LayoutOptions, TextStyleOptions {
  text?: string;
  /** A shared Font or options for a new one. Default sans-serif. */
  font?: Font | FontOptions;
  visible?: boolean;
  /** Follow this core mesh's world matrix; the text's own transform is then relative to the mesh. */
  mesh?: Mesh | null;
  position?: Vec3;
  /** XYZ Euler angles in radians. */
  rotation?: Vec3;
  scale?: number | Vec3;
  /** Local matrix (column-major); overrides position, rotation and scale. */
  matrix?: Mat4;
}

interface Owner {remove(text: Text): void}

// Range checks of Text.validate, which runs for every drawn text every frame.
const unit = (value: unknown, name: string): void => {if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError(`${name} must be 0..1`);};
const extent = (value: unknown, name: string): void => {if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);};
const LAYOUT_KEYS = ['fontSize', 'lineHeight', 'letterSpacing', 'maxWidth', 'textAlign', 'anchorX', 'anchorY', 'direction', 'whiteSpace', 'overflowWrap'] as const;

/**
 * A block of SDF text in 3D, like troika-three-text's `Text`. Every field may be changed at any time; the
 * layout is recomputed on the next frame (or the next `layout` read) only when a layout field changed.
 */
export class Text {
  text: string;
  font: Font;
  fontSize = 1; lineHeight = 1.2; letterSpacing = 0; maxWidth = Infinity;
  textAlign: TextAlign = 'left'; anchorX: AnchorX = 'left'; anchorY: AnchorY = 'top'; direction: TextDirection = 'auto';
  whiteSpace: 'normal' | 'nowrap' = 'normal'; overflowWrap: 'normal' | 'break-word' = 'break-word';
  /** Linear RGB. */
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
  visible: boolean;
  /** Local matrix; the model matrix is this, or the attached mesh's world matrix times this. */
  readonly matrix = identity();
  private target: Mesh | null = null;
  private owner?: Owner;
  private cached?: TextLayout;
  private readonly snapshot: unknown[] = [];
  private layoutRevision = 0;

  constructor(options: TextOptions = {}) {
    const {text = '', font, visible = true, mesh = null, position, rotation, scale, matrix, ...rest} = options;
    this.text = text; this.visible = visible;
    this.font = font instanceof Font ? font : new Font(font);
    this.shadowOffset.set([0.04 * (rest.fontSize ?? 1), -0.04 * (rest.fontSize ?? 1)]);
    this.set(rest);
    if (matrix) this.setMatrix(matrix);
    else if (position || rotation || scale !== undefined) this.setTransform(position ?? [0, 0, 0], rotation ?? [0, 0, 0], scale ?? 1);
    this.attach(mesh);
  }

  /** Applies any subset of layout and style options. */
  set(options: LayoutOptions & TextStyleOptions & {text?: string; font?: Font}): this {
    const {color, outlineColor, shadowColor, shadowOffset, text, font, ...rest} = options;
    if (text !== undefined) this.text = text;
    if (font !== undefined) {if (!(font instanceof Font)) throw new TypeError('font must be a Font'); this.font = font;}
    if (color !== undefined) parseColor(color, this.color);
    if (outlineColor !== undefined) parseColor(outlineColor, this.outlineColor);
    if (shadowColor !== undefined) parseColor(shadowColor, this.shadowColor);
    if (shadowOffset !== undefined) {finiteArray(shadowOffset, 2, 'Shadow offset'); this.shadowOffset.set(shadowOffset);}
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) (this as unknown as Record<string, unknown>)[key] = value;
    this.validate(); return this;
  }

  /** Throws when a field is out of range. Called each frame the text is drawn. */
  validate(): void {
    if (typeof this.text !== 'string') throw new TypeError('Text must be a string');
    if (!(this.font instanceof Font)) throw new TypeError('font must be a Font');
    validateLayoutOptions(this);
    unit(this.opacity, 'opacity'); unit(this.outlineOpacity, 'outlineOpacity'); unit(this.shadowOpacity, 'shadowOpacity');
    extent(this.outlineWidth, 'outlineWidth'); extent(this.shadowBlur, 'shadowBlur');
    finiteArray(this.color, 3, 'Color'); finiteArray(this.outlineColor, 3, 'Outline color'); finiteArray(this.shadowColor, 3, 'Shadow color'); finiteArray(this.shadowOffset, 2, 'Shadow offset');
    if (typeof this.billboard !== 'boolean' || typeof this.onTop !== 'boolean' || typeof this.visible !== 'boolean') throw new TypeError('billboard, onTop and visible must be boolean');
  }

  /** Sets the local matrix from a position, XYZ Euler rotation (radians) and uniform or per-axis scale. */
  setTransform(position: Vec3, rotation: Vec3 = [0, 0, 0], scale: number | Vec3 = 1): this {
    const s: Vec3 = typeof scale === 'number' ? [scale, scale, scale] : scale;
    finiteArray(position, 3, 'Position'); finiteArray(rotation, 3, 'Rotation'); finiteArray(s, 3, 'Scale');
    if (s.some(v => v === 0)) throw new RangeError('Scale must be nonzero');
    compose(this.matrix, position, eulerToQuaternion(rotation[0], rotation[1], rotation[2]), s); return this;
  }
  setPosition(position: Vec3): this {finiteArray(position, 3, 'Position'); this.matrix[12] = position[0]; this.matrix[13] = position[1]; this.matrix[14] = position[2]; return this;}
  setMatrix(matrix: Mat4): this {finiteArray(matrix, 16, 'Text matrix'); for (let i = 0; i < 16; i++) this.matrix[i] = matrix[i]; return this;}

  /** Follow a core mesh's world matrix (hidden with it), or null for world space. */
  attach(mesh: Mesh | null): this {
    if (mesh !== null && (typeof mesh !== 'object' || typeof mesh.check !== 'function')) throw new TypeError('Expected a Margo Engine mesh');
    mesh?.check(); this.target = mesh; return this;
  }
  get attachedMesh(): Mesh | null {return this.target;}

  /** Bumped every time the layout is recomputed. */
  get layoutVersion(): number {return this.layoutRevision;}

  /**
   * The current layout in the block's local space (x right, y up, world units, origin at the anchor):
   * glyph advance boxes, line boxes and total bounds, for hit testing and caret placement. Measures with
   * the font, so it needs a browser (OffscreenCanvas or a DOM canvas).
   */
  get layout(): TextLayout {
    const snapshot = this.snapshot;
    let changed = !this.cached || !Object.is(this.text, snapshot[0]) || !Object.is(this.font, snapshot[1]) || !Object.is(this.font.revision, snapshot[2]);
    if (!changed) for (let i = 0; i < LAYOUT_KEYS.length; i++) if (!Object.is(this[LAYOUT_KEYS[i]], snapshot[i + 3])) {changed = true; break;}
    if (changed) {
      const values = [this.text, this.font, this.font.revision, ...LAYOUT_KEYS.map(key => this[key])];
      this.cached = layoutText(this.text, this, this.font);
      snapshot.length = 0; snapshot.push(...values); this.layoutRevision++;
    }
    return this.cached!;
  }

  /** UTF-16 caret offset nearest to a local point. */
  hitTest(x: number, y: number): number {return hitTest(this.layout, x, y);}
  /** Local caret position for a UTF-16 offset. */
  caretRect(index: number): {x: number; top: number; bottom: number; line: number} {return caretRect(this.layout, index);}

  /** @internal */
  bind(owner: Owner | undefined): void {
    if (owner && this.owner && this.owner !== owner) throw new Error('Text already belongs to another TextRenderer');
    this.owner = owner;
  }

  /** Removes the text from its renderer and releases its GPU buffers. It can be added again later. */
  dispose(): void {this.owner?.remove(this);}
}
