export declare const defaultClear: number[];
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
