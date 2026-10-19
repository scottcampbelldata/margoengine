// Internal protocol: optional packages are separate bundles, so a registry symbol
// identifies the same writer without adding either package as a dependency.
export const shadowPrimitivesInto = Symbol.for('@margoengine/internal/shadowPrimitivesInto');
// A core mesh with receiveShadow false adds 0.25 to its instance's doubleSided factor (0 or 1), core's i.material.z.
// The test allows for interpolation error; core's `i.material.z<0.5` single-sided test keeps its meaning.
export const coreReceives = 'fract(i.material.z+0.125)<0.25';
// Patch for it only in core-shaped shaders while the engine has such a mesh, so other scenes keep their exact WGSL.
export const unshadowedCore = (engine, source) => !!engine?.unshadowed && source.includes('i.material.z<0.5');
