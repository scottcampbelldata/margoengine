export declare const defaultClear: number[];
/** A CSS `#rgb` or `#rrggbb` string as a 24-bit integer, or -1 for any other string, alpha forms included. */
export declare function hexColor(color: string): number;
/** The clear value of `color` for a display-encoded target: its sRGB bytes as given. */
export declare function clearColorValue(color: string | false | undefined): readonly number[];
/** An sRGB byte (0 to 255) as linear light (IEC 61966-2-1). */
export declare const toLinear: (v: number) => number;
/**
 * The clear value of `color` for a draw that may clear a capture's target of colour format `capture` (not the
 * frame's own): decoded from sRGB for a float or `-srgb` capture, the bytes as given for anything else and for none.
 * Core's own clear colour (`color` not a string) takes the same path.
 */
export declare function captureClearColor(
  color: string | false | undefined,
  capture?: string | false,
): readonly number[];
export declare function clearDraw(
  device: GPUDevice,
  cache: Map<string, GPURenderPipeline>,
  pass: GPURenderPassEncoder,
  options: {
    formats: readonly GPUTextureFormat[];
    values?: readonly (readonly number[])[];
    depthFormat?: GPUTextureFormat;
    writeDepth?: boolean;
    samples?: number;
    writeColor?: boolean;
    tint?: readonly number[];
  },
): void;
/** Drops every colour bind group cached for `device` in this copy of the module; returns their buffers to destroy. */
export declare function releaseClears(device: GPUDevice): GPUBuffer[];
