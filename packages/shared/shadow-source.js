// Internal protocol: optional packages are separate bundles, so a registry symbol
// identifies the same writer without adding either package as a dependency.
export const shadowPrimitivesInto = Symbol.for('@margoengine/internal/shadowPrimitivesInto');
