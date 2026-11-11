/** Where Rapier's Wasm comes from: a URL, a fetched `Response`, its bytes or a compiled `WebAssembly.Module`. */
export type RapierWasmSource = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;

/** The Rapier build a package bundles, and how its errors name the fix. */
export interface RapierBuild {
  /** What the Wasm imports: the glue module, under the name wasm-bindgen gave it. */
  imports: WebAssembly.Imports;
  /** The Wasm's file name in the package's dist, such as `rapier3d.wasm`. */
  file: string;
  /** The package name, such as `@margoengine/physics`. */
  package: string;
  /** The load call the errors name, such as `Physics.load`. */
  call: string;
  /** The Rapier version the bundled build reports. */
  version: string;
  /** {@link interfaceHash} of the bundled Wasm. */
  interface: number;
}

/** FNV-1a over the module's exports and imports. */
export function interfaceHash(module: WebAssembly.Module): number;

/**
 * Compiles Rapier's Wasm from `source`, checks it is `build`, and returns the instance's exports for the glue.
 * @throws MargoError (`failed`) when the Wasm cannot be fetched or is not the bundled build.
 */
export function instantiateRapier(source: RapierWasmSource, signal: AbortSignal, build: RapierBuild): Promise<WebAssembly.Exports>;
