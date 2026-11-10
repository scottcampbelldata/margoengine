import { Line, type LineOptions } from './line.js';
import type { LineExtension } from './extension.js';

/** A width multiplier per point, with draw-on progress measured along world-space arc length. */
export interface StrokeOptions extends LineOptions {
  /** One non-negative multiplier per point. Default 1 at every point. */
  widths?: ArrayLike<number>;
  /** Fraction of the length to reveal, from 0 to 1. Default 1. */
  progress?: number;
}

/** Optional fat stroke. Widths, dashes, colours, depth and picking work together. */
export class Stroke extends Line {
  private scales = new Float32Array(0);
  private reveal = 1;
  private revision = 0;

  constructor(options: StrokeOptions = {}) {
    const { widths, progress = 1, ...line } = options;
    super(line);
    this.setWidths(widths ?? new Float32Array(this.count).fill(1));
    this.progress = progress;
    this.extension = this.strokeExtension();
  }

  /** Visible fraction of world-space arc length. Values outside 0..1 reject. */
  get progress(): number {
    return this.reveal;
  }
  set progress(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Stroke progress must be 0..1');
    if (this.reveal !== value) {
      this.reveal = value;
      this.revision++;
    }
  }

  /** Returns an independent copy. Use setWidths to change the stroke. */
  get widths(): Float32Array {
    return this.scales.slice();
  }

  /** Replace the owned width multipliers, one finite non-negative value per point. */
  setWidths(widths: ArrayLike<number>): this {
    if (widths.length !== this.count) throw new RangeError('Stroke widths need one multiplier per point');
    const next = new Float32Array(widths.length);
    for (let i = 0; i < next.length; i++) {
      const value = widths[i];
      if (!Number.isFinite(value) || value < 0 || value > 3.4e38)
        throw new RangeError('Stroke widths must be finite and non-negative');
      next[i] = value;
    }
    this.scales = next;
    this.revision++;
    return this;
  }

  /** Replacing the point count resets widths to 1; same-count edits retain them. */
  override setPositions(positions: ArrayLike<number>, colors?: ArrayLike<number> | null): this {
    super.setPositions(positions, colors);
    if (this.scales && this.scales.length !== this.count) this.setWidths(new Float32Array(this.count).fill(1));
    return this;
  }

  protected strokeExtension(): LineExtension {
    return {
      key: 'stroke',
      entries: [{ binding: 3, visibility: 3, buffer: { type: 'read-only-storage', minBindingSize: 32 } }],
      shader: strokeShader,
      create: (device) => {
        const data = new Float32Array(4 + Math.max(4, Math.ceil(this.points.length / 16) * 4));
        const buffer = device.createBuffer({ size: data.byteLength, usage: 128 | 8 });
        let revision = -1;
        return {
          entries: [{ binding: 3, resource: { buffer } }],
          update: () => {
            if (revision === this.revision) return;
            data[0] = this.reveal;
            data.set(this.scales, 4);
            device.queue.writeBuffer(buffer, 0, data);
            revision = this.revision;
          },
          dispose: () => buffer.destroy(),
        };
      },
    };
  }
}

/** @internal Shared by the texture entry so width and reveal remain composable. */
export function strokeShader(code: string): string {
  return (
    `struct StrokeData { params:vec4f, widths:array<f32> }
@group(1) @binding(3) var<storage,read> stroke:StrokeData;
` + code
  )
    .replace(
      'let rawA=halfWidth(ca);let rawB=halfWidth(cb);',
      'let rawA=halfWidth(ca)*mix(stroke.widths[ia],stroke.widths[ib],ta);let rawB=halfWidth(cb)*mix(stroke.widths[ia],stroke.widths[ib],tb);',
    )
    .replace('let hwA=max(rawA,0.5);let hwB=max(rawB,0.5);', 'let hwA=max(rawA,0.0);let hwB=max(rawB,0.0);')
    .replace(
      /(@fragment fn fragment\(i:Out\)[^{]+\{)/,
      '$1\n  if(stroke.params.x<=0.0 || (stroke.params.x<1.0 && i.dist>style.b.y*stroke.params.x)){discard;}',
    );
}
