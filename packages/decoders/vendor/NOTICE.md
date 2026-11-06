# Third-party decoders

These files are official WebAssembly builds of the projects listed below.
The `.wasm` files, `draco_wasm_wrapper.js` and `jxl_oxide_wasm.js` are unmodified. `basis/basis_transcoder.js` is modified by Margo
Engine's build (`scripts/static-embind.js`, stated with the date of the change in the file's first line): its two
embind wrapper generators, which used `new Function`, are replaced by equivalent closures so it runs under a Content
Security Policy without `'unsafe-eval'`.

| Folder | Project | License | Source |
| --- | --- | --- | --- |
| `draco/` | Draco 3D Data Compression 1.5.6, Google | Apache-2.0 | https://www.gstatic.com/draco/versioned/decoders/1.5.6/ (`draco_decoder_gltf.wasm`, `draco_wasm_wrapper_gltf.js`); project https://github.com/google/draco |
| `basis/` | Basis Universal v1_50_0_2, Binomial LLC | Apache-2.0 | https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/transcoder/build |
| `jxl/` | jxl-oxide-wasm 0.12.6, Wonwoo Choi | MIT OR Apache-2.0, used here under Apache-2.0 | https://www.npmjs.com/package/jxl-oxide-wasm/v/0.12.6; project https://github.com/tirr-c/jxl-oxide |

Apache-2.0 permits redistribution with this notice retained. The full licence text ships next to this file as
`LICENSE-Apache-2.0.txt` (also https://www.apache.org/licenses/LICENSE-2.0).

All six files are byte-identical to those official releases (sha256 checked 2026-10-24 and, for `jxl/`, 2026-11-06; values in
THIRD-PARTY-NOTICES.md).

The `jxl/` Wasm also holds the Rust crates it was built from, among them brotli-decompressor (BSD-3-Clause or MIT), flate2, miniz_oxide,
fdeflate, png, hashbrown, dlmalloc, once_cell, tracing-core and wasm-bindgen (MIT or Apache-2.0, miniz_oxide also Zlib). `jxl/LICENSE-MIT` is
the text that package ships.
