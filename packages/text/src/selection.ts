import { type LayoutGlyph, type TextLayout } from './layout.js';

/** A local-space highlight box, sorted by line and then visual x. */
export interface SelectionRect {
  /** Zero-based line number. */
  line: number;
  /** Left edge in world units. */
  left: number;
  /** Right edge in world units. */
  right: number;
  /** Line box top in world units. */
  top: number;
  /** Line box bottom in world units. */
  bottom: number;
}

function edge(g: LayoutGlyph, offset: number, end: boolean): number {
  let distance = end ? g.advance : 0;
  if (offset <= g.index) distance = 0;
  else if (offset >= g.index + g.length) distance = g.advance;
  else if (g.carets) {
    const stops = [[0, 0], ...g.carets, [g.length, g.advance]];
    for (let i = 1; i < stops.length; i++) if (offset <= g.index + stops[i][0]) {
      distance = stops[offset === g.index + stops[i][0] || end ? i : i - 1][1];
      break;
    }
  }
  return g.rtl ? g.x + g.advance - distance : g.x + distance;
}

/**
 * Rectangles covering UTF-16 [start,end), across wrapping and visual bidi runs.
 * Reversed ranges are accepted. Offsets clamp to the source and partial graphemes
 * expand outward; shaped runs use their internal caret stops. Empty ranges return [].
 * Local clip bounds, when present, intersect every box. Does not mutate the layout.
 */
export function getSelectionRects(layout: TextLayout, start: number, end: number): SelectionRect[] {
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new RangeError('Selection offsets must be finite; pass UTF-16 source offsets');
  if (start === end) return [];
  [start, end] = [Math.max(0, Math.min(layout.text.length, Math.floor(Math.min(start, end)))),
    Math.max(0, Math.min(layout.text.length, Math.ceil(Math.max(start, end))))];
  if (start === end) return [];
  const out: SelectionRect[] = [];
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const spans: Array<[number, number]> = [];
    let previous: [number, number] | undefined;
    for (let k = line.firstGlyph; k < line.firstGlyph + line.glyphCount; k++) {
      const g = layout.glyphs[k];
      if (!g.length || g.index >= end || g.index + g.length <= start) { previous = undefined; continue; }
      const a = edge(g, start, false), b = edge(g, end, true);
      if (previous) { previous[0] = Math.min(previous[0], a, b); previous[1] = Math.max(previous[1], a, b); }
      else { previous = [Math.min(a, b), Math.max(a, b)]; spans.push(previous); }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let current: SelectionRect | undefined;
    for (const [left, right] of spans) {
      // Join touching advance boxes; a visual hole across unselected bidi text remains separate.
      if (current && left <= current.right + 1e-12 * Math.max(1, Math.abs(left), Math.abs(current.right)))
        current.right = Math.max(current.right, right);
      else { current = { line: i, left, right, top: line.top, bottom: line.bottom }; out.push(current); }
    }
  }
  const clip = layout.clipRect;
  if (!clip) return out;
  return out.map(r => ({ ...r, left: Math.max(r.left, clip[0]), bottom: Math.max(r.bottom, clip[1]),
    right: Math.min(r.right, clip[2]), top: Math.min(r.top, clip[3]) }))
    .filter(r => r.left < r.right && r.bottom < r.top);
}
