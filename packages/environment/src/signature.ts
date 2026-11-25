// File signatures shared by parseEnvironmentImage and loadEnvironmentImage, kept apart from every decoder so the
// loader (dist/load.js) reads them without importing one.
export const isJPEG = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
export const isEXR = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01;
export const isHDR = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f;

export const JPEG_ERROR = 'UltraHDR JPEGs decode asynchronously: use decodeUltraHDR or loadEnvironmentImage';
export const UNKNOWN_ERROR = 'Unrecognized environment image (expected Radiance .hdr or OpenEXR)';
