/** WGSL of `margoHashCell` and `margoAlphaHash(p)`: the hashed alpha threshold at object position `p`, `scale` cells per pixel. */
export function alphaHashCode(scale: string): string;
/** A caster shader that cuts against hashed noise instead of the cutoff (a shadow primitive's `hashed`). */
export function hashedDepth(code: string): string;
