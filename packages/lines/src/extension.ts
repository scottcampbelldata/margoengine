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
