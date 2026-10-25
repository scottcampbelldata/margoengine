// Figure export: PNG (the canvas's frame with the HTML overlays, tick labels, titles, colour bars and legends, painted
// over it at the canvas's resolution) and SVG (text and colour bars as vector elements over the frame as an embedded
// PNG; a 2D chart whose layers are all bars, heatmaps, lines or scatters of up to 50,000 points is vector throughout).
import type { Colormap } from './colormaps.js';

/** Options for `figure.toPNG()`. */
export interface PNGOptions {
  /** Paint the tick labels, titles, colour bars and legends. Default true. */
  readonly overlays?: boolean;
}

/** Options for `figure.toSVG()`. */
export interface SVGOptions {
  /** Draw a 2D chart's bars, heatmaps, lines and scatters as vector shapes. Default true (when every layer can be). */
  readonly vector?: boolean;
}

/** @internal A colour bar to paint: its bar element and colour map. */
export interface PaintedBar {
  readonly bar: HTMLElement;
  readonly map: Colormap;
}

/** @internal One text run on screen: its text, box (CSS pixels from the canvas's top-left) and style. */
export interface TextRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly font: string;
  readonly size: number;
  readonly family: string;
  readonly weight: string;
  readonly color: string;
  readonly vertical: boolean;
}

/** @internal The visible text runs under `roots`, relative to `origin`. */
export function textRuns(roots: readonly Element[], origin: DOMRect): TextRun[] {
  const runs: TextRun[] = [];
  for (const root of roots) {
    if (!root.isConnected) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none' || parent.closest('[hidden]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      runs.push({
        text,
        x: r.left - origin.left,
        y: r.top - origin.top,
        width: r.width,
        height: r.height,
        font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
        size: Number.parseFloat(style.fontSize),
        family: style.fontFamily,
        weight: style.fontWeight,
        color: style.color,
        vertical: style.writingMode.startsWith('vertical') || style.writingMode.startsWith('sideways'),
      });
    }
  }
  return runs;
}

/** @internal Paints text runs and colour bars onto a 2D context whose pixels are `scale` times CSS pixels. */
export function paintOverlays(
  g: OffscreenCanvasRenderingContext2D,
  runs: readonly TextRun[],
  bars: readonly PaintedBar[],
  origin: DOMRect,
  scale: number,
): void {
  g.save();
  g.scale(scale, scale);
  for (const { bar, map } of bars) {
    if (!bar.isConnected) continue;
    const r = bar.getBoundingClientRect(),
      x = r.left - origin.left,
      y = r.top - origin.top,
      gradient = g.createLinearGradient(0, y + r.height, 0, y),
      table = map.table(32);
    for (let k = 0; k < 32; k++)
      gradient.addColorStop(
        k / 31,
        `rgb(${Math.round(table[k * 4] * 255)} ${Math.round(table[k * 4 + 1] * 255)} ${Math.round(table[k * 4 + 2] * 255)})`,
      );
    g.fillStyle = gradient;
    g.fillRect(x, y, r.width, r.height);
    g.strokeStyle = getComputedStyle(bar).borderTopColor;
    g.strokeRect(x + 0.5, y + 0.5, r.width - 1, r.height - 1);
  }
  g.textBaseline = 'middle';
  for (const run of runs) {
    g.font = run.font;
    g.fillStyle = run.color;
    if (run.vertical) {
      // Turned text reads bottom to top.
      g.save();
      g.translate(run.x + run.width / 2, run.y + run.height / 2);
      g.rotate(-Math.PI / 2);
      g.textAlign = 'center';
      g.fillText(run.text, 0, 0);
      g.restore();
    } else {
      g.textAlign = 'left';
      g.fillText(run.text, run.x, run.y + run.height / 2);
    }
  }
  g.restore();
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @internal SVG `<text>` elements for text runs. */
export function svgText(runs: readonly TextRun[]): string {
  return runs
    .map((run) => {
      const style = `font-family="${escape(run.family)}" font-size="${run.size}" font-weight="${escape(run.weight)}" fill="${escape(run.color)}"`;
      if (run.vertical) {
        const cx = run.x + run.width / 2,
          cy = run.y + run.height / 2;
        return `<text x="${cx}" y="${cy}" ${style} text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${cx} ${cy})">${escape(run.text)}</text>`;
      }
      return `<text x="${run.x}" y="${run.y + run.height / 2}" ${style} dominant-baseline="central">${escape(run.text)}</text>`;
    })
    .join('\n');
}

/** @internal SVG for colour bars: a gradient-filled, outlined rectangle each. */
export function svgBars(bars: readonly PaintedBar[], origin: DOMRect): string {
  return bars
    .filter(({ bar }) => bar.isConnected)
    .map(({ bar, map }, i) => {
      const r = bar.getBoundingClientRect(),
        table = map.table(16);
      const stops = Array.from(
        { length: 16 },
        (_, k) =>
          `<stop offset="${k / 15}" stop-color="rgb(${Math.round(table[k * 4] * 255)},${Math.round(table[k * 4 + 1] * 255)},${Math.round(table[k * 4 + 2] * 255)})"/>`,
      ).join('');
      return `<linearGradient id="sciviz-bar-${i}" x1="0" y1="1" x2="0" y2="0">${stops}</linearGradient><rect x="${r.left - origin.left}" y="${r.top - origin.top}" width="${r.width}" height="${r.height}" fill="url(#sciviz-bar-${i})" stroke="${escape(getComputedStyle(bar).borderTopColor)}"/>`;
    })
    .join('\n');
}

/** @internal Base64 of bytes, for data URLs. */
export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** @internal `#rrggbb` of an sRGB triple (0..1). */
export const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export { escape as escapeXML };
