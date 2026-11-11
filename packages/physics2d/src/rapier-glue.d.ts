// Rapier's wasm-bindgen glue ships without declarations. The solver chunk needs two things from it: the setter that
// hands it the instance, and the module itself, which is what the Wasm imports as `./rapier_wasm2d_bg.js`.
declare module '@dimforge/rapier2d/rapier_wasm2d_bg.js' {
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
