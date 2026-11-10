/** 'glTF' magic, little-endian. */
export const GLB_MAGIC: number;
/** JSON chunk type. */
export const GLB_JSON: number;
/** BIN chunk type. */
export const GLB_BIN: number;
/** Throws a coded error when a BIN chunk is more than 3 bytes longer than buffer 0's byteLength (GLB padding). */
export function checkBinChunk(chunkLength: number, byteLength: unknown): void;
/** True when `bytes` start with the GLB magic. */
export function isGLB(bytes: Uint8Array): boolean;
/** The chunks of a whole GLB file, JSON first, BIN (if any) second; header, bounds, alignment and order checked. */
export function glbChunks(bytes: Uint8Array): { type: number; data: Uint8Array }[];
