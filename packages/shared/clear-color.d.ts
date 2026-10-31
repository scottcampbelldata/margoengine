export declare const defaultClear: number[];
/** A `#rrggbb` string as a 24-bit integer, or -1 for any other string. */
export declare function hexColor(color: string): number;
export declare function clearColorValue(color: string | false | undefined): readonly number[];
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
