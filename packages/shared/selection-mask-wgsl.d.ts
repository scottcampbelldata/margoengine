/**
 * WGSL: the packed mask at `@group(group) @binding(binding)`, `margoMaskPresent()` (false for a zeroed stand-in),
 * `margoMaskOn(i)`, `margoMaskHidden(on)` and `margoMaskColor(linear colour, on)`, the same maths as `maskColor`.
 */
export function maskWgsl(group: number, binding: number): string;
