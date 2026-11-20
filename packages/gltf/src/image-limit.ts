/**
 * Most pixels one glTF image may decode to: 8192 x 8192 (256 MiB as RGBA8), the side every WebGPU device supports
 * (`maxTextureDimension2D` 8192). A film close-up's 8K map loads; a side over the device's limit is still refused at
 * upload, and all images together stay within the decoded budget (4x `maxDownloadBytes`). 4096 x 4096 before 2026-11-17.
 */
export const MAX_IMAGE_PIXELS = 67_108_864;
