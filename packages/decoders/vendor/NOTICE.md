# Third-party decoders

These files are official WebAssembly builds, as redistributed by the `three` package (0.181.0, `examples/jsm/libs`).
Both `.wasm` files and `draco_wasm_wrapper.js` are unmodified. `basis/basis_transcoder.js` is modified by Margo
Engine's build (`scripts/static-embind.js`, stated in the file's first line): its two embind wrapper generators, which
used `new Function`, are replaced by equivalent closures so it runs under a Content Security Policy without
`'unsafe-eval'`.

| Folder | Project | License | Source |
| --- | --- | --- | --- |
| `draco/` | Draco 3D Data Compression, Google | Apache-2.0 | https://github.com/google/draco |
| `basis/` | Basis Universal, Binomial LLC | Apache-2.0 | https://github.com/BinomialLLC/basis_universal |

Apache-2.0 permits redistribution with this notice retained. Full text: https://www.apache.org/licenses/LICENSE-2.0
