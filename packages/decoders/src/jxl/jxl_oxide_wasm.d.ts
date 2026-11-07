// The parts of the vendored jxl-oxide glue (vendor/jxl, copied into dist/jxl by scripts/build.js) that this package uses.
export class JxlImage {
  feedBytes(bytes: Uint8Array): number;
  tryInit(): boolean;
  render(keyframe?: number): RenderResult;
  free(): void;
  forceSrgb: boolean;
  readonly loaded: boolean;
}
export class RenderResult {
  /** The profile the samples are in. Empty when they are sRGB. */
  readonly iccProfile: Uint8Array;
  /** Consumes the render, so there is nothing left to free. */
  encodeToPng(): Uint8Array;
}
export default function init(options: { module_or_path: string | URL | BufferSource }): Promise<unknown>;
