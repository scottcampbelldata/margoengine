# @margoengine/points

Large point clouds and instanced sprites for Margo Engine, WebGPU: the counterparts of Three.js `Points`, `PointsMaterial`, `Sprite` and `SpriteMaterial`, built for big scans: the browser test culls and draws a 2,000,000-point cloud under a 500,000-point budget.

Build from source with `npm run build` in `packages/points`.

```ts
import {Engine} from '@margoengine/core';
import {PointsPlugin, PointCloud, SpriteBatch, atlasRect} from '@margoengine/points';

const engine = await Engine.create(canvas);
const points = PointsPlugin.attach(engine, {pointBudget: 2_000_000});

// Any {positions, colors?, normals?} works, including the point-cloud output of @margoengine/loaders.
const cloud = points.add(new PointCloud({
  positions,                       // Float32Array, xyz per point (used in place)
  colors,                          // RGB or RGBA, floats 0..1 or a Uint8Array 0..255
  material: {size: 2, shape: 'round', edl: true},
}));
cloud.attach(mesh);                // follow a core mesh's world matrix

// Change 100 points: only those 1200 bytes are written to the GPU.
cloud.updatePositions(5000, newXyz);

// Thousands of camera-facing sprites in one draw call.
const labels = points.add(new SpriteBatch({material: {map: await createImageBitmap(atlasImage)}}));
labels.add({position: [0, 2, 0], size: 0.5, uv: atlasRect(3, 4, 4)});

// CPU picking of the nearest drawn point.
canvas.addEventListener('click', event => {
  const hit = points.pick(event.offsetX, event.offsetY, {radius: 8});
  if (hit) console.log(hit.index, hit.position);
});
```

## How it works

- **Blocks.** `new PointCloud()` splits the points into spatially compact blocks of at most `blockSize` points (median splits along the longest axis, like a kd-tree) and records each block's bounds. Each frame the plugin transforms every block's bounds by the model matrix and frustum-culls it on the CPU against `camera.planes`.
- **Point budget and level of detail.** The points inside each block are shuffled once with a seeded PRNG, so the first `k` slots of a block are an even random sample of it. Visible blocks share `pointBudget` in proportion to their projected screen area, and blocks that need less than their share give the rest to the others. Each block then draws a prefix of its slots: one `draw(4, k, 0, firstSlot)` call per visible block. This is the progressive subsampling Potree uses, without its octree files.
- **GPU data.** Positions (f32 xyz), packed RGBA8 colors, optional f32 sizes and the shuffled slot order live in storage buffers; the vertex shader expands each point into a quad (a 4-vertex triangle strip per instance). The arrays stay in your order, so `updatePositions`, `updateColors` and `updateSizes` call `writeBuffer` on exactly the changed byte range. Position updates also grow the affected blocks' bounds.
- **Shapes and shading.** Square points cover exactly `size x size` pixels. Round points are an antialiased disc with an extra pixel of quad. A `map` (any `GPUTexture`, or an `ImageBitmap`, canvas, image, video or `ImageData` that the plugin uploads as `rgba8unorm-srgb`) is sampled across the point, with `alphaTest` or blending. `shading: 'sphere'` lights each point as a sphere impostor and writes its curved depth with `frag_depth`. `edl: true` adds eye-dome lighting: points also write their view depth into an `r32float` target and a full-screen pass multiplies the color by `exp(-300 * strength * mean(max(0, log2 d - log2 d_neighbor)))` over 8 neighbors.
- **Depth.** Points test against the scene with reversed-Z `greater-equal` and opaque points write depth, so they hide behind meshes and occlude each other. Transparent materials blend without writing depth.
- **Orthographic cameras.** Everything is read from `camera.matrix`, so any projection whose clip w is constant (such as `CameraProjection` from `@margoengine/cameras`) works without a dependency on it: world-unit sizes use the matrix's pixels per world unit and stay the same at every depth, sphere impostors write linear depth, eye-dome lighting shades linear depth steps (scaled like the log steps a perspective camera with the same zoom would give), block budgets ignore distance, and picking breaks ties by distance from the near plane (`depth` is then measured from the near plane).
- **Sprites.** A `SpriteBatch` keeps 16 floats per sprite (position, rotation, size, pivot, atlas UV rectangle, color) in one storage buffer and draws every sprite with one instanced call. Quads face the camera using the camera's right and up vectors; with `sizeUnits: 'pixels'` (Three.js `sizeAttenuation: false`) they are expanded in screen space instead.
- **Colors.** Material and sprite colors take `'#rrggbb'` (sRGB) or linear `[r, g, b]`, like `PbrMaterial`. Per-point colors are sRGB by default, which matches the loaders package and 8-bit scanner data; set `colorSpace: 'linear'` otherwise. Output is sRGB-encoded in the shader on non `-srgb` canvas formats, the same way core does it.
- **Device loss.** `onDeviceRestored` rebuilds every buffer, pipeline and uploaded texture from the CPU copies. `dispose` (and `engine.removePlugin`) destroys them all. Clouds and batches stay registered, so a plugin can be reused.
- **SSR.** Nothing touches `window`, `navigator` or GPU globals at import or construction time.

## Loader interop

`PointCloud` accepts the object `@margoengine/loaders` returns for PLY, PCD, XYZ and other point clouds without importing that package: `{kind: 'points', positions: Float32Array, colors?: Float32Array (sRGB rgb 0..1), normals?: Float32Array}`. Pass it straight in: `new PointCloud({...loaded, material: {size: 2}})`. Normals are kept on `cloud.normals` but not used for shading.

## Options

`PointsPlugin`

| Option | Default | |
| --- | --- | --- |
| `pointBudget` | 1,000,000 | Most points drawn per frame across all clouds |
| `edlStrength`, `edlRadius` | 1, 1.4 px | Eye-dome lighting |
| `order` | 10 | Frame graph order: after the scene, before fat lines (20) and post (30) |
| `name` | `'points'` | Unique per engine |

`PointCloud`

| Option | Default | |
| --- | --- | --- |
| `positions` | required | xyz per point |
| `colors`, `colorComponents` | none, inferred | RGB or RGBA, float 0..1 or Uint8 0..255 |
| `sizes` | none | Per-point multiplier of `material.size` |
| `blockSize` | 16384 | Points per culling block |
| `colorSpace` | `'srgb'` | Of per-point colors |
| `reorder` | false | Permute the arrays into block order for sequential GPU reads; `sourceIndex` maps back |
| `cullMargin` | 0 | World units added to the frustum test |
| `seed` | 1 | Shuffle seed |

`PointsMaterial` (`SpriteMaterial` shares the first block)

| Option | Default | |
| --- | --- | --- |
| `color`, `opacity` | white, 1 | |
| `map`, `mapFilter` | null, `'linear'` | GPUTexture or image source |
| `alphaTest` | 0 | |
| `transparent`, `blending` | false (sprites: true), `'normal'` | `'additive'` also available |
| `depthTest`, `depthWrite` | true, `!transparent` | |
| `size` | 4 | Diameter in pixels, or world units with `sizeUnits: 'world'` |
| `sizeUnits` / `sizeAttenuation` | `'pixels'` / false | Sprites default to `'world'` |
| `minPixelSize`, `maxPixelSize` | 1, 256 | |
| `shape` | `'square'` | or `'round'` |
| `vertexColors` | true | |
| `shading` | `'flat'` | or `'sphere'` |
| `edl` | false | |

Sprites: `add({position, size, rotation, center, color, opacity, uv})`, `set(index, ...)`, `remove(index)` (moves the last sprite into the slot), `clear()`. `SpriteMaterial.rotation` adds to every sprite.

## Limits

- WebGPU only. On the WebGL2 backend the plugin warns once and draws nothing.
- One cloud's positions must fit one storage binding: `maxStorageBufferBindingSize / 12` points (about 11 million at the default 128 MiB limit). Split bigger clouds into several `PointCloud`s.
- Picking is CPU-side over the points drawn in the latest frame; meshes do not occlude it.
- Block bounds only grow on updates; call `rebuild()` to tighten them or to include points that turned finite. Non-finite points are never drawn. A `reorder`ed cloud cannot be rebuilt.
- Per-point colors are stored as RGBA8, so HDR vertex colors are clamped to 0..1.
- No mipmaps on maps. A `GPUTexture` you pass is created on a device the plugin does not own: after a device loss the material draws untextured (with a one-time warning) until you assign a new texture. Uploaded image sources are rebuilt automatically.
- Transparent points and sprites are not sorted per point. Use `alphaTest` or additive blending for order-independent results. Round antialiased edges of opaque points write depth.
- No point-size compensation for subsampled blocks yet, and no octree streaming from disk (all points are in memory).

## Tests

`npm test` in `packages/points` runs Node checks: chunking (coverage, block sizes, bounds, determinism, non-finite points) on random data and the real PCL `bunny.pcd` scan, even subsampling of shuffled prefixes, bounds growth, frustum culling against core `Camera.planes` with a randomized no-false-negative check, screen area, budget water-filling invariants, projection and picking against brute force, orthographic screen area and picking, color packing, ranges, atlas cells, `PointCloud` and `SpriteBatch` bookkeeping, materials, SSR safety and the WebGL2 warning.

`npm run test:browser` (a real-GPU script, not in CI) renders with a real engine in Chromium (or Edge via `BROWSER_CHANNEL`): exact square coverage at 2 to 16 px, round coverage within 4% of the disc area with empty corners, per-point byte and float colors, depth against a core mesh and between points, attachment to a mesh, size attenuation, a 2,000,000 point cloud culled and drawn within a 500,000 point budget, subrange updates that issue exactly one `writeBuffer` per changed range, sprites that stay square after an orbit with the right atlas cell, rotation, pivot and pixel size, 5000 sprites in one draw call, textured points with alpha test, sphere shading, eye-dome lighting, CPU picking, an orthographic camera (world sizes equal at two depths, sphere impostor depth against a box, EDL at a depth step, nearer-point picking), zero WebGPU validation errors, device restore and dispose. It saves `test-results/points-gallery.png` and `test-results/points-browser.json`.

MIT licensed.
