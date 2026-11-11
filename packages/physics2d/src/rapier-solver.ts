// The Rapier solver, a lazy chunk of its own: Physics2D.load() imports it, nothing else does. The package build bundles
// Rapier's JavaScript from @dimforge/rapier2d and copies its Wasm beside this chunk as dist/rapier2d.wasm, so the Wasm
// stays a file that bundlers emit as an asset and browsers compile while it downloads (WebAssembly.instantiateStreaming).
import * as RAPIER from '@dimforge/rapier2d';
import * as glue from '@dimforge/rapier2d/rapier_wasm2d_bg.js';
import { instantiateRapier, type RapierWasmSource } from '../../shared/rapier-wasm.js';
import type { RapierModule2D } from './rapier-types.js';

export type { RapierWasmSource };

/**
 * The Wasm this package ships, beside this chunk in dist. The literal reaches the app's bundler unchanged, which emits
 * the file as an asset; `?no-inline` keeps Vite (in library mode too) from inlining it as base64.
 */
export const defaultWasm = (): URL => new URL(/* @vite-ignore */ './rapier2d.wasm?no-inline', import.meta.url);
// The version of the Rapier build bundled here and a hash of its Wasm's exports and imports, swapped in by the package
// build after bundling.
declare const __RAPIER_VERSION__: string;
declare const __RAPIER_INTERFACE__: number;

/**
 * Compiles Rapier's Wasm from `source` and returns the ready module. Rapier keeps one instance per app, so the first
 * call that succeeds wins. `signal` cancels the download and the wait.
 * @throws MargoError (`failed`) when the Wasm cannot be fetched or is not Rapier's.
 */
export async function startRapier(source: RapierWasmSource, signal: AbortSignal): Promise<RapierModule2D> {
  const exports = await instantiateRapier(source, signal, {
    // What the Wasm imports: the glue module, under the name wasm-bindgen gave it.
    imports: { './rapier_wasm2d_bg.js': glue as unknown as WebAssembly.ModuleImports },
    file: 'rapier2d.wasm',
    package: '@margoengine/physics2d',
    call: 'Physics2D.load',
    version: __RAPIER_VERSION__,
    interface: __RAPIER_INTERFACE__,
  });
  glue.__wbg_set_wasm(exports);
  return RAPIER as unknown as RapierModule2D;
}
