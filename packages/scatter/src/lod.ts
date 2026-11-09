/** Inclusive outer LOD limit, shared by CPU capacity budgeting and generated WGSL rejection. */
export function outsideLod(distance: number, limit: number): boolean;
export function outsideLod(distance: string, limit: string): string;
export function outsideLod(distance: number | string, limit: number | string): boolean | string {
  return typeof distance === 'number' ? distance > (limit as number) : `${distance}>${limit}`;
}

/**
 * Lower bound on GPU distance from the eye to a packed tile. Inputs are the uploaded f32 origin/side/eye.
 * WGSL permits either rounding direction, division error, reassociation and subnormal flushing:
 * https://www.w3.org/TR/WGSL/#floating-point-accuracy
 * Eight f32 epsilons enclose multiply/divide/add placement and subtract/dot/inverseSqrt/divide distance error.
 * The absolute distance allowance covers flushed squared components (sqrt(4 * 2^-126)). This is an allocation
 * bound only: the GPU still makes every exact ring/fade decision and the explicit drawn cap still applies.
 */
export function tileDistance(x: number, z: number, side: number, eyeX: number, eyeZ: number): number {
  const epsilon = 2 ** -20,
    dx = Math.max(0, x - eyeX, eyeX - x - side) - (Math.abs(x) + side) * epsilon,
    dz = Math.max(0, z - eyeZ, eyeZ - z - side) - (Math.abs(z) + side) * epsilon;
  return Math.max(0, Math.hypot(Math.max(0, dx), Math.max(0, dz)) * (1 - epsilon) - 2 ** -62);
}
