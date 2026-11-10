// Figure export: PNG (the canvas's frame with the HTML overlays, tick labels, titles, colour bars and legends, painted
// over it at the canvas's resolution) and SVG (text and colour bars as vector elements over the frame as an embedded
// PNG; a 2D chart whose layers are all bars, heatmaps, lines or scatters of up to 50,000 points is vector throughout).
import type { Colormap } from './colormaps.js';
import type { EngineKernel } from '@margoengine/core';

/** @internal Copy the fresh canvas frame to an owned buffer before awaiting GPU completion. */
export async function captureGPU(
  engine: EngineKernel,
  canvas: HTMLCanvasElement,
  render: () => void,
): Promise<ImageBitmap> {
  const device = engine.gpu!,
    context = canvas.getContext('webgpu') as unknown as GPUCanvasContext,
    configuration = context.getConfiguration()!;
  const { width, height } = canvas,
    format = configuration.format;
  // Capture commands are encoded during the canvas texture's lifetime. Copying to
  // an owned buffer before awaiting avoids stale and automatically expired images.
  if (!((configuration.usage ?? 0x10) & 0x01)) {
    // Reconfiguration expires the old canvas texture. Finish already submitted
    // compatibility replay before destroying the target those commands reference.
    await device.queue.onSubmittedWorkDone();
    context.configure({ ...configuration, usage: (configuration.usage ?? 0x10) | 0x01 });
  }
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  try {
    render();
    const texture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    // Mapping orders both deferred compatibility replay and native GPU execution.
    // Unlike a canvas texture, this target remains owned across browser tasks.
    await buffer.mapAsync(1);
    const mapped = new Uint8Array(buffer.getMappedRange()),
      pixels = new Uint8ClampedArray(width * height * 4),
      bgra = format.startsWith('bgra');
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const from = y * bytesPerRow + x * 4,
          to = (y * width + x) * 4;
        pixels[to] = mapped[from + (bgra ? 2 : 0)];
        pixels[to + 1] = mapped[from + 1];
        pixels[to + 2] = mapped[from + (bgra ? 0 : 2)];
        pixels[to + 3] = mapped[from + 3];
      }
    buffer.unmap();
    const output = new OffscreenCanvas(width, height),
      outputContext = output.getContext('2d')!;
    outputContext.putImageData(new ImageData(pixels, width, height), 0, 0);
    return await createImageBitmap(output);
  } finally {
    buffer.destroy();
  }
}

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
  /** @internal Optional outline prepared by the math entry. */
  readonly math?: { readonly path: string; readonly width: number; readonly height: number };
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
    for (const element of [root, ...root.querySelectorAll('[data-sciviz-math]')]) {
      const value = element.getAttribute('data-sciviz-math');
      if (!value || element.closest('[hidden]')) continue;
      const style = getComputedStyle(element),
        r = element.getBoundingClientRect();
      if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue;
      runs.push({
        text: '',
        x: r.left - origin.left,
        y: r.top - origin.top,
        width: r.width,
        height: r.height,
        font: '',
        size: 0,
        family: '',
        weight: '',
        color: style.color,
        vertical: false,
        math: JSON.parse(value),
      });
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      if (parent.closest('[data-sciviz-math]')) continue;
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

/** @internal A legend swatch on screen: its box (CSS pixels from the canvas's top-left), colour and roundness. */
export interface Swatch {
  readonly points?: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly round: boolean;
}

/** @internal The visible legend swatches under `roots`, relative to `origin`. */
export function swatches(roots: readonly Element[], origin: DOMRect): Swatch[] {
  const out: Swatch[] = [];
  for (const root of roots)
    for (const element of root.querySelectorAll<HTMLElement>('[data-sciviz-swatch]')) {
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(element);
      out.push({
        x: r.left - origin.left,
        y: r.top - origin.top,
        width: r.width,
        height: r.height,
        color: style.backgroundColor,
        round:
          element.dataset.scivizShape === 'dot' ||
          style.borderTopLeftRadius === '50%' ||
          Number.parseFloat(style.borderTopLeftRadius) >= r.width / 2,
        points: element.dataset.scivizPolygon?.split(',').map(Number),
      });
    }
  return out;
}

/** @internal Paints text runs and colour bars onto a 2D context whose pixels are `scale` times CSS pixels. */
export function paintOverlays(
  g: OffscreenCanvasRenderingContext2D,
  runs: readonly TextRun[],
  bars: readonly PaintedBar[],
  origin: DOMRect,
  scale: number,
  boxes: readonly Swatch[] = [],
): void {
  g.save();
  g.scale(scale, scale);
  for (const box of boxes) {
    g.fillStyle = box.color;
    if (box.points) {
      g.beginPath();
      for (let i = 0; i < box.points.length; i += 2) {
        const x = box.x + box.points[i] * box.width,
          y = box.y + box.points[i + 1] * box.height;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
    } else if (box.round) {
      g.beginPath();
      g.arc(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, 0, Math.PI * 2);
      g.fill();
    } else g.fillRect(box.x, box.y, box.width, box.height);
  }
  for (const { bar, map } of bars) {
    if (!bar.isConnected) continue;
    const r = bar.getBoundingClientRect(),
      x = r.left - origin.left,
      y = r.top - origin.top,
      gradient = g.createLinearGradient(0, y + r.height, 0, y),
      stops = map.gradientStops(32);
    for (const { offset, color } of stops)
      gradient.addColorStop(offset, `rgb(${color.map((v) => Math.round(v * 255)).join(' ')})`);
    g.fillStyle = gradient;
    g.fillRect(x, y, r.width, r.height);
    g.strokeStyle = getComputedStyle(bar).borderTopColor;
    g.strokeRect(x + 0.5, y + 0.5, r.width - 1, r.height - 1);
  }
  g.textBaseline = 'middle';
  for (const run of runs) {
    if (run.math) {
      g.save();
      g.translate(run.x, run.y);
      g.scale(run.width / run.math.width, run.height / run.math.height);
      g.fillStyle = run.color;
      g.fill(new Path2D(run.math.path));
      g.restore();
      continue;
    }
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
      if (run.math)
        return `<svg x="${run.x}" y="${run.y}" width="${run.width}" height="${run.height}" viewBox="0 0 ${run.math.width} ${run.math.height}" preserveAspectRatio="none"><path d="${escape(run.math.path)}" fill="${escape(run.color)}"/></svg>`;
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

/** @internal SVG for legend swatches. */
export function svgSwatches(boxes: readonly Swatch[]): string {
  return boxes
    .map((b) =>
      b.points
        ? `<polygon points="${Array.from({ length: b.points.length / 2 }, (_, i) => `${b.x + b.points![i * 2] * b.width},${b.y + b.points![i * 2 + 1] * b.height}`).join(' ')}" fill="${escape(b.color)}"/>`
        : b.round
          ? `<circle cx="${b.x + b.width / 2}" cy="${b.y + b.height / 2}" r="${b.width / 2}" fill="${escape(b.color)}"/>`
          : `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${escape(b.color)}"/>`,
    )
    .join('\n');
}

/** @internal SVG for colour bars: a gradient-filled, outlined rectangle each. */
export function svgBars(bars: readonly PaintedBar[], origin: DOMRect): string {
  return bars
    .filter(({ bar }) => bar.isConnected)
    .map(({ bar, map }, i) => {
      const r = bar.getBoundingClientRect(),
        entries = map.gradientStops(32);
      const stops = entries
        .map(
          ({ offset, color }) =>
            `<stop offset="${offset}" stop-color="rgb(${color.map((v) => Math.round(v * 255)).join(',')})"/>`,
        )
        .join('');
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
