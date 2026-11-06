# Third-party encoders

These files are official WebAssembly builds of the projects listed below. The `.wasm` files and `draco_encoder_wrapper.js`
are unmodified. `basis_encoder.js` is byte-identical here and modified by Margo Engine's build (`scripts/static-embind.js`,
stated with the date of the change in the built file's first line): its two embind wrapper generators, which used
`new Function`, are replaced by equivalent closures so it runs under a Content Security Policy without `'unsafe-eval'`.

| Folder | Project | License | Source |
| --- | --- | --- | --- |
| `draco-encoder/` | Draco 3D Data Compression 1.5.7, Google | Apache-2.0 | https://github.com/google/draco/tree/1.5.7/javascript (`draco_encoder.wasm`, `draco_encoder_wrapper.js`) |
| `basis-encoder/` | Basis Universal v1_50_0_2, Binomial LLC | Apache-2.0 | https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/encoder/build (`basis_encoder.wasm`, `basis_encoder.js`) |

Apache-2.0 permits redistribution with this notice retained. The full licence text ships next to this file as
`LICENSE-Apache-2.0.txt` (also https://www.apache.org/licenses/LICENSE-2.0).

The files are byte-identical to those official releases (sha256 checked 2026-11-06; values in THIRD-PARTY-NOTICES.md).
