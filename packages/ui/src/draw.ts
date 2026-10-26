import type { Font, TextLayout } from '@margoengine/text';
import type { Rgba } from './color.js';

/** A filled and outlined rounded rectangle, in device pixels. */
export interface RectCommand {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in pixels. */
  radius: number;
  fill: Rgba;
  border: Rgba;
  /** Outline width in pixels, drawn inside the rectangle. 0 for none. */
  borderWidth: number;
  /** Edge softness in pixels; above 0 makes a soft shadow instead of a crisp shape. */
  blur: number;
}

/** A laid-out block of text. `layout` is in UI units, y up from the block's top-left; `scale` turns it into pixels. */
export interface TextCommand {
  type: 'text';
  /** Top-left of the block in pixels. */
  x: number;
  y: number;
  layout: TextLayout;
  scale: number;
  font: Font;
  color: Rgba;
  /** Outline width in pixels around each glyph; 0 for none. */
  outlineWidth: number;
  outlineColor: Rgba;
}

/** Start clipping to a rectangle in pixels, inside any clip already active. Matched by an {@link UnclipCommand}. */
export interface ClipCommand {
  type: 'clip';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** End the innermost {@link ClipCommand}. */
export interface UnclipCommand {
  type: 'unclip';
}

/** One step of a {@link DrawList}. */
export type DrawCommand = RectCommand | TextCommand | ClipCommand | UnclipCommand;

/** Options for {@link DrawList.rect}; colours default to transparent. */
export interface RectStyle {
  fill?: Rgba;
  border?: Rgba;
  /** UI units. */
  borderWidth?: number;
  /** UI units. */
  radius?: number;
  /** UI units; makes the rectangle a soft shadow. */
  blur?: number;
}

const CLEAR: Rgba = [0, 0, 0, 0];

/**
 * What a {@link Ui} draws, as plain data in back-to-front order: rounded rectangles, text blocks and clip regions in
 * device pixels. A renderer ({@link UiRenderer}) turns it into GPU draws; tests can read `commands` directly. The
 * methods take UI units and apply the list's `scale` and pixel snapping.
 */
export class DrawList {
  /** The commands in draw order. Reused: do not keep it across a `clear()`. */
  readonly commands: DrawCommand[] = [];
  /** Device pixels per UI unit. */
  scale = 1;
  /** Multiplies the alpha of everything added; set by the UI while it draws a fading widget. */
  alpha = 1;
  /** Changes whenever the list is rebuilt, so a renderer can skip uploading an unchanged one. */
  version = 0;
  private clips: { x0: number; y0: number; x1: number; y1: number }[] = [];

  /** Empty the list and start a new version at `scale` pixels per UI unit. */
  clear(scale: number): void {
    this.commands.length = 0;
    this.clips.length = 0;
    this.alpha = 1;
    this.scale = scale;
    this.version++;
  }

  private fade(color: Rgba, alpha: number): Rgba {
    return alpha === 1 ? color : [color[0], color[1], color[2], color[3] * alpha];
  }

  /** A rounded rectangle with its edges snapped to whole pixels. */
  rect(x: number, y: number, width: number, height: number, style: RectStyle): void {
    const s = this.scale,
      x0 = Math.round(x * s),
      y0 = Math.round(y * s),
      x1 = Math.round((x + width) * s),
      y1 = Math.round((y + height) * s),
      blur = (style.blur ?? 0) * s;
    if (x1 <= x0 || y1 <= y0) return;
    const a = this.alpha,
      fill = this.fade(style.fill ?? CLEAR, a),
      border = this.fade(style.border ?? CLEAR, a);
    if (fill[3] <= 0 && (border[3] <= 0 || !style.borderWidth)) return;
    this.commands.push({
      type: 'rect',
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      radius: Math.min((style.radius ?? 0) * s, (x1 - x0) / 2, (y1 - y0) / 2),
      fill,
      border,
      borderWidth: style.borderWidth ? Math.max(1, Math.round(style.borderWidth * s)) : 0,
      blur,
    });
  }

  /** A text block whose top-left is at (x, y) UI units. Empty layouts add nothing. */
  text(
    x: number,
    y: number,
    layout: TextLayout,
    font: Font,
    color: Rgba,
    outline?: { width: number; color: Rgba },
  ): void {
    if (!layout.glyphs.length || color[3] * this.alpha <= 0) return;
    this.commands.push({
      type: 'text',
      x: Math.round(x * this.scale),
      y: Math.round(y * this.scale),
      layout,
      scale: this.scale,
      font,
      color: this.fade(color, this.alpha),
      outlineWidth: outline ? outline.width * this.scale : 0,
      outlineColor: this.fade(outline?.color ?? CLEAR, this.alpha),
    });
  }

  /** Clip what follows to a rectangle in UI units until the matching {@link DrawList.popClip}. */
  pushClip(x: number, y: number, width: number, height: number): void {
    const s = this.scale,
      outer = this.clips.at(-1),
      x0 = Math.max(Math.round(x * s), outer?.x0 ?? -Infinity),
      y0 = Math.max(Math.round(y * s), outer?.y0 ?? -Infinity),
      x1 = Math.min(Math.round((x + width) * s), outer?.x1 ?? Infinity),
      y1 = Math.min(Math.round((y + height) * s), outer?.y1 ?? Infinity);
    const clip = { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    this.clips.push(clip);
    this.commands.push({ type: 'clip', x: clip.x0, y: clip.y0, width: clip.x1 - clip.x0, height: clip.y1 - clip.y0 });
  }

  /** End the innermost clip. */
  popClip(): void {
    if (!this.clips.pop()) return;
    this.commands.push({ type: 'unclip' });
  }
}
