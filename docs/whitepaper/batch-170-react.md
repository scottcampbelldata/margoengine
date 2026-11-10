# Batch 170 React work counts (2026-11-10)

`Mesh` used object-rest destructuring to construct an events object on every render. Event lookup already reads
only the twelve declared pointer names. Retaining the immutable props in the existing latest-events ref removes
the redundant own-key enumeration and property copy. Transform writes, subscriptions and render scheduling stay
unchanged. The retained reference lasts until the next render or unmount, as the copied record did.

The 10,000-mesh StrictMode regression in `packages/react/test/declarative.test.js` instruments the forwarded render's
props with a Proxy. React still owns the surrounding lifecycle; the wrapper only counts ownKeys. One explicit
rerender enumerates 20,000 props objects on the parent, zero after this change. Both pass the same exact byte
comparison of all 90,000 transform values (position, rotation and scale), including negative zero. Existing tests
cover live pointer callback replacement and removal, StrictMode and disposal.

Reproduce after `npm run build:packages`:
`node --experimental-test-module-mocks --test --test-timeout=120000 --test-name-pattern=10000 packages/react/test/declarative.test.js`.
The standard React benchmark now includes both the existing 1,000-mesh case and the required 10,000-mesh case.
No benchmark was run.

## React Three Fiber comparison harness

The rival is React Three Fiber 9.8.2 on three.js r186 and React 19.3.1, installed outside this repository in
`engine-bench` (`npm install --save-exact @react-three/fiber@9.8.2`). Its adapter, `engine-bench/margo-bench/r3f.js`,
is registered as `r3f` in `engine-bench/margo-bench/engines.json`. It draws the same `react` scene as Margo
(`bench/scenes/margo.js`): n boxes declared as React elements, each with its own box geometry and standard material,
the catalog's palette, sun and ambient light, re-rendered every frame with new rotations. It uses only R3F's
documented public API (`extend`, `createRoot`, `configure`, `render`, `flushSync`, `advance`) with
`frameloop: 'never'`, so each harness frame is one reconcile plus one draw. Its source was never read.

`scripts/parity-smoke-browser.mjs --standard=react` runs the standard React cases once per engine, inside the GPU
lock, with no timing phase. Smoke on 2026-11-10 (`test-results/bp170-react-smoke.json`, not committed), first
harness frame after mount:

| Case | Margo (WebGPU) | R3F (WebGL2) |
| --- | --- | --- |
| `react-1000` | 1,000 meshes, 1,000 draw calls; 1,002 buffer writes (96,256 bytes) | 1,000 meshes, 1,000 draw calls |
| `react-10000` | 10,000 meshes, 10,000 draw calls; 10,002 buffer writes (960,256 bytes) | 10,000 meshes, 10,000 draw calls |

Draw work is equal: neither side batches separately declared geometries. The first Margo frame also draws its
initial frame again (two passes); a second frame on the same page draws one pass of 1,000 draws with 1,001 writes
(checked once by hand, not a committed count). WebGL uniform calls are not counted, so the per-mesh write counts
are not compared. These counts are not a speed result. Timing pending the quiet rerun:
`npm run bench -- react --engines=margo,r3f --runs=5`.

Research compared the React team, *Components and Hooks must be pure* (living documentation, accessed 2026-11-10),
https://react.dev/reference/rules/components-and-hooks-must-be-pure, with Ecma International TC39,
*ECMAScript 2025 Language Specification*, CopyDataProperties (2025),
https://tc39.es/ecma262/2025/multipage/abstract-operations.html#sec-copydataproperties.
Props are immutable render inputs; object rest copies enumerable own properties, whereas the existing live handler
lookup needs only named reads. No other engine or companion source was read or copied.
