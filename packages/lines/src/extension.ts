import type { Camera } from '@margoengine/core';
import type { LineBatches } from './batch.js';
import type { Lines } from './lines.js';

/** Internal contract for optional line entries. The base renderer never imports their implementation. */
export interface LineExtension {
  readonly key: string;
  readonly entries: GPUBindGroupLayoutEntry[];
  shader(code: string, picking?: boolean): string;
  create(device: GPUDevice): {
    entries: GPUBindGroupEntry[];
    update(): void;
    dispose(): void;
  };
}

/**
 * Internal contract for an optional entry that widens every line's Frame uniform (`lines/tiles`). The entry installs it
 * in `lineFrame` on first use, never on import, so a page that does not import it uploads and compiles the base Frame
 * and the base renderers carry only these calls.
 */
export interface FrameExtension {
  /** Rewrites a finished line shader (every variant, batches and picking) for the wider Frame. */
  shader(code: string): string;
  /**
   * Lines' turn before it writes or draws a frame, and LinePicking's before a pick: rebuilds its Frame layout, buffer,
   * data and compiled shaders once for the wider Frame (again after a device restore).
   */
  lines(lines: Lines): void;
  /** The same for LineBatches, with its shader text. */
  batches(batches: LineBatches, shader: string): void;
  /** Writes the Frame uniform in place of the base rows (`fillFrame`'s arguments). */
  fill(
    data: Float32Array,
    matrix: ArrayLike<number>,
    camera: Camera,
    width: number,
    height: number,
    ratio: number,
    viewHeight: number,
    encode: number,
  ): void;
}

/** The installed frame extension, read by Lines, LineBatches and LinePicking when they build their Frame. */
export const lineFrame: { hook?: FrameExtension } = {};
