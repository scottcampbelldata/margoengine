# Content Security Policy

Core and stage compile the Rust transform kernel, so every Margo engine page under a strict CSP needs `'wasm-unsafe-eval'`. For a same-origin app, serve this HTTP response header:

```http
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'
```

Add `'wasm-unsafe-eval'` to the existing `script-src` directive rather than replacing your application's policy. Preserve its nonces, hashes and other required sources and directives. If several enforcing policies apply, each must permit Wasm. The permission permits Wasm compilation without enabling JavaScript `eval` or `new Function`.

The browser's [script-src documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src) describes the permission. Without it, a restricted page can throw `WebAssembly.CompileError` or `EvalError` while compiling; Emscripten can wrap that failure in a runtime abort. Core and the optional-package loaders report code `failed`, name `MargoError`, the original cause at the initialization boundary, and [CSP help](https://margoengine.com/llms/docs/csp.md). Decoder and encoder workers preserve the code and help message when sending the failure back to the caller.

## Packages and entries

| Package or entry | When it compiles Wasm |
| --- | --- |
| `@margoengine/core` | Engine creation compiles the embedded transform kernel from `packages/kernel`. Importing the module alone does not compile it. |
| `@margoengine/stage` | Creating a stage creates the core engine and therefore needs the same permission. The facade adds no separate Wasm compiler. |
| `@margoengine/physics` | `Physics.load()` initializes Rapier 3D. |
| `@margoengine/physics/next` | `loadKernel()` or its `Physics.load()` initializes Margo's Rust physics kernel. |
| `@margoengine/physics2d` | `Physics2D.load()` initializes Rapier 2D. Its separate Rust kernel currently has a test harness, not a shipping loader. |
| `@margoengine/decoders` (`DracoDecoder`), `/draco-points` | First geometry decode in a classic worker, with separate glTF and point-cloud builds. |
| `@margoengine/decoders` (`KTX2Decoder`), `/ktx2-layers`, `/ktx2-hdr`, `/ktx2-stream`, `/image` | First Basis transcode in a classic worker, or in process for `/image` in Node. `/texture` only uploads decoded textures and needs no Wasm permission of its own. |
| `@margoengine/decoders/jxl` | First decode using the Wasm worker; the native browser image path does not compile Wasm. |
| `@margoengine/decoders/meshopt-simd` | First access to `MeshoptSIMDDecoder.ready`. The TypeScript `/meshopt` entry does not compile Wasm. |
| `@margoengine/exporters/draco`, `/ktx2` | First encode, in a classic worker in the browser or in process in Node. |

The `.3dm` loader accepts an already initialized runtime owned by the caller; Margo does not compile that runtime. Apply the runtime provider's Wasm policy when loading it. `kernel-common` is linked into its consuming Rust kernels, with no independent JavaScript compiler or shared Wasm bundle.

## Workers and assets

Serve the header on worker script responses too: workers normally use the policy on their own response, not the page's policy. The decoders and encoders use served files with `importScripts` or ES module imports and do not require JavaScript `'unsafe-eval'`. Keep worker scripts, wrapper scripts and Wasm assets on permitted origins. With a same-origin deployment, `worker-src 'self'` can restrict worker creation and `connect-src 'self'` can restrict asset fetches; retain any additional origins your app actually uses. A `default-src` policy may otherwise restrict these resources too.

A wrong MIME type, a missing asset, an invalid binary and unavailable SIMD are separate failures. They retain their original errors, rather than being described as CSP failures. This change adds no fallback, retry or permission bypass.

## Regression evidence

`tests/deep-core-csp.test.js` simulates both compile and instantiate failures for core. `tests/wasm-csp.test.js` checks translation and preservation of unrelated errors. Package `tests/csp.test.js` files simulate blocked compilation at the physics, decoder and encoder initialization paths, including worker replies and decoder pool reconstruction. These are simulated policy failures, not proof of every browser's CSP implementation. The same tests run through `verify` in `check:merge`.
