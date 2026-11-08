// The root entry holds only bindings that need no optional package (core, the stage, math, cache and selection are
// installed with @margoengine/react), so webpack and Turbopack build it with no optional peer installed. A binding that
// needs @margoengine/<name> is imported from @margoengine/react/<name>; tests/optional-peer-reach.test.js checks both.
export * from './components.js';
export * from './hooks.js';
export * from './views.js';
export { Sun, type SunProps } from './sun.js';
export { Center, type CenterProps } from './center.js';
export { extend, type MargoElements, type DirectionalLightProps } from './intrinsics.js';
