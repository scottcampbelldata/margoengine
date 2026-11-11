/** Where a bundled Wasm comes from: a URL, a fetched `Response`, its bytes or a compiled `WebAssembly.Module`. */
export type BundledWasmSource = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;

/** The wasm-bindgen build a package bundles, and how its errors name the fix. */
export interface BundledWasmBuild {
  /** The library's name as errors show it. */
  name: string;
  /** What the Wasm imports: the glue module, under the name wasm-bindgen gave it. */
  imports: WebAssembly.Imports;
  /** The Wasm's file name in the package's dist, such as `solver.wasm`. */
  file: string;
  /** The package name, such as `@margoengine/physics`. */
  package: string;
  /** The load call the errors name, such as `Physics.load`. */
  call: string;
  /** The version the bundled build reports through its exported `version()`. */
  version: string;
  /** {@link interfaceHash} of the bundled Wasm. */
  interface: number;
}

/** FNV-1a over the module's exports and imports. */
export function interfaceHash(module: WebAssembly.Module): number;

/**
 * Compiles the bundled Wasm from `source`, checks it is `build`, and returns the instance's exports for the glue.
 * @throws MargoError (`failed`) when the Wasm cannot be fetched or is not the bundled build.
 */
export function instantiateBundledWasm(source: BundledWasmSource, signal: AbortSignal, build: BundledWasmBuild): Promise<WebAssembly.Exports>;
