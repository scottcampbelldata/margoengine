/** Validate packed triangle geometry without loading its renderer. */
export function validatePreparedGeometry(data: { vertices: Float32Array; indices: Uint32Array }): void;
/** Validate an already checked vertex range. */
export function checkPreparedVertices(vertices: Float32Array, from: number, to: number): void;
