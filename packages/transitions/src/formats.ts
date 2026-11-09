// A valid render-attachment texture still needs a float color output, and core's MSAA path needs resolve support.
// Format capabilities: https://www.w3.org/TR/webgpu/#plain-color-formats
export function floatOutput(format: GPUTextureFormat, samples: number): boolean {
  return (
    /^(?:(?:r|rg|rgba)(?:8|16|32)(?:unorm|snorm|float)(?:-srgb)?|bgra8unorm(?:-srgb)?|rgb10a2unorm|rg11b10ufloat)$/.test(
      format,
    ) && !(samples > 1 && /32float$/.test(format))
  );
}
