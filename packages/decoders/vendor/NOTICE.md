# Third-party decoders

These files are official WebAssembly builds, as redistributed by the `three` package (0.181.0, `examples/jsm/libs`).
Both `.wasm` files and `draco_wasm_wrapper.js` are unmodified. `basis/basis_transcoder.js` is modified by Margo
Engine's build (`scripts/static-embind.js`, stated with the date of the change in the file's first line): its two
embind wrapper generators, which used `new Function`, are replaced by equivalent closures so it runs under a Content
Security Policy without `'unsafe-eval'`.

| Folder | Project | License | Source |
| --- | --- | --- | --- |
| `draco/` | Draco 3D Data Compression, Google | Apache-2.0 | https://github.com/google/draco |
| `basis/` | Basis Universal, Binomial LLC | Apache-2.0 | https://github.com/BinomialLLC/basis_universal |

Apache-2.0 permits redistribution with this notice retained. The full licence text ships next to this file as
`LICENSE-Apache-2.0.txt` (also https://www.apache.org/licenses/LICENSE-2.0).

## meshoptimizer decoder

`meshopt.js` is a TypeScript port of the meshoptimizer reference vertex/index decoder and filters
(https://github.com/zeux/meshoptimizer), used under the MIT License:

> Copyright (c) Arseny Kapoulkine
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
