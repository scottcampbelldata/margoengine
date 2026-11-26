# margo-convert

The asset pipeline for [Margo Engine](https://margoengine.com): one command that imports, optimises, compresses and
packages models, textures and audio for the web and for each export target.

```sh
npx margo-convert build ./assets --out dist                  # web preset (default)
npx margo-convert build ./assets --out dist --preset mobile
npx margo-convert optimize helmet.glb                       # one model -> helmet.optimized.glb
npx margo-convert playable dist --out playable.html          # one-file playable ad: MRAID hooks, size budget
```

## Build and optimize

`build` takes a folder (or one file) and writes optimised copies, a manifest and a size report to `--out` (default
`dist`). `optimize` does the same for one model. Both take `--preset`:

| Preset | Models | Textures | Audio |
| --- | --- | --- | --- |
| `web` (default) | quantised, meshopt-compressed GLB; static meshes merged; empty nodes removed | up to 2048 px, WebP (lossless for normal and data maps) | WAV and FLAC to Ogg Vorbis if ffmpeg is installed |
| `mobile` | as `web` | up to 1024 px at power-of-two sizes, WebP quality 72 | as `web`, mono, at most 22.05 kHz |
| `unity` | plain GLB, hierarchy and empty nodes kept, no required extensions | PNG/JPEG up to 4096 px, multiples of 4 | kept |
| `unreal` | as `unity` | PNG/JPEG at power-of-two sizes up to 4096 px | kept |
| `godot` | as `unity` | PNG/JPEG up to 4096 px | kept |
| `roblox` | as `unity` | PNG/JPEG up to 1024 px | Ogg Vorbis if ffmpeg is installed, otherwise WAV is reported (Roblox takes mp3 and ogg) |

See [docs/guides/asset-pipeline.md](../../docs/guides/asset-pipeline.md) for examples of each.

What happens to a model (`.glb` or `.gltf` with its external files):

- **Prune.** Texture coordinate sets no material reads, tangents without a normal map, then unused nodes, meshes,
  materials, textures, samplers, images, skins and cameras. Nodes that carry nothing are removed only for the web
  presets (game engines use empty nodes as attachment points).
- **Dedupe.** Identical images (by content), samplers, textures, materials and meshes are merged.
- **Weld.** Identical vertices are merged (every attribute and morph target equal), unreferenced vertices and
  triangles with no area are dropped, vertices are numbered in order of first use.
- **Merge** (web presets). Static, unskinned meshes that share a material and attribute layout become one primitive,
  baked into world space. Safe means: no animation on the node or an ancestor, no morph targets, no node extensions,
  and the mesh used by one node only (shared meshes stay instanced).
- **Reorder** (every preset). Triangles in the order the GPU's vertex cache and early depth test read fastest, then
  vertices in order of first use, from `@margoengine/geometry/optimize`. A `BLEND` primitive keeps its triangle order, which
  decides how it layers. The pass counts as `reorderedPrimitives`; `reorder: false` in a preset's `model` turns it off.
- **Quantise** (web presets, KHR_mesh_quantization). Positions to 16-bit with the mesh bounds folded into the node
  transform (one scale on all axes, so normals stay correct; a node with children or animation gets a child node for
  the mesh), normals and tangents to 8 bits, texture coordinates in 0..1 to 16 bits, colours and skin weights to 8
  bits. Meshes with morph targets are left alone; skinned meshes keep float positions.
- **Compress** (web presets, EXT_meshopt_compression). Vertex attributes and triangle indices are written with the
  meshopt codecs by an encoder written for Margo from the extension specification (`@margoengine/exporters/meshopt`);
  Margo's decoder (`@margoengine/decoders/meshopt`) reads them, and so do other glTF loaders that support the
  extension. The output lists the extension as required.
- A model is never written larger than it came in, and a model that uses an extension the optimiser does not rewrite
  (Draco, `KHR_animation_pointer`, EXT_structural_metadata and similar) is copied unchanged with the reason in the
  manifest.

### Textures

Images inside models and standalone `.png` / `.jpg` files are scaled down to the preset's limit (never enlarged),
rounded down to a power of two or a multiple of 4 where the preset asks, and re-encoded:

- **Colour maps** (base colour, emissive, sheen and specular colour) are lossy WebP at the preset's quality. **Normal
  maps and every other data map** (metal/roughness, occlusion, clearcoat and so on) are lossless. Inside a model the
  role comes from the material slot that uses the image; a standalone file's from its name (`_normal`, `_n`, `rough`,
  `metal`, `orm`, `ao`, `mask`, and similar are data).
- WebP images are referenced through `EXT_texture_webp` (listed as required: there is no PNG copy). An image whose
  WebP is not smaller keeps its PNG. The game presets keep PNG and JPEG and write no texture extension; a JPEG is
  re-encoded only when it has to be resized.
- An image is never written larger than it came in unless it had to be made smaller in pixels.
- **Encoders.** Node has no WebP, AVIF or JPEG encoder. If [sharp](https://sharp.pixelplumbing.com) is already
  installed in the project, margo-convert uses it for resizing (Lanczos) and for WebP, AVIF and JPEG; it is not a
  dependency and nothing is downloaded. Without it PNG textures are still resized (area filter, colour averaged in
  linear light and weighted by alpha) and rewritten by margo-convert's own PNG writer, which picks the narrowest colour
  type and the best filter for every row; WebP, AVIF and JPEG images are left as they are and the manifest says so.
- `--max-texture 1024`, `--texture-format webp|avif|png|jpeg|keep` and `--texture-quality 80` override the preset.
  `--no-sharp` ignores an installed sharp.
- `--mipmaps` also writes `name.dds`, an uncompressed RGBA8 file with the full mip chain, for each standalone texture
  (`@margoengine/decoders/dds` reads it). WebP, PNG and JPEG hold one level, and Margo builds the others on the GPU, so
  this is off by default. KTX2 with Basis Universal compression needs an encoder, and none is installed.

### Audio

- **WAV** (8, 16, 24 and 32-bit PCM, 32 and 64-bit float) is mixed to mono and resampled when the preset asks
  (`mobile`: mono, at most 22.05 kHz) with a Hann-windowed sinc low-pass at 95% of the new Nyquist frequency, and
  written as 16-bit PCM. Other WAV encodings are left as they are.
- **Ogg Vorbis.** Node has no audio encoder. If an `ffmpeg` with `libvorbis` is on the PATH, `web`, `mobile` and
  `roblox` convert WAV and FLAC to Ogg Vorbis (quality 4, with the preset's mono and rate); without it the files pass
  through and the manifest says why. MP3, AAC, Opus and Ogg are web formats already and are never re-encoded.
  `--no-ffmpeg` ignores an installed ffmpeg.

### Manifest, size report, incremental builds

`build` writes `margo-manifest.json` and `margo-size-report.txt` to the output folder. The manifest has one entry per
input with its relative path, size and SHA-256, the status (`built`, `cached`, `copied`, `skipped`, `failed`), every
output with its path, size and SHA-256, what was done or could not be done, and counts from the model passes. It
names no times, so the same inputs and settings give the same manifest. `--hash-names` puts the first eight digits
of the content hash in output names (`Fox.fbdf9e94.glb`) for long-lived caching; the manifest maps each source to its
file.

An input is skipped when its content hash, the preset and the tool version match the previous manifest and every output
still exists with the recorded hash. Change a file, switch the preset or damage an output and only that is rebuilt;
`--force` rebuilds everything. Outputs of inputs that no longer exist are removed. A failed input is recorded and the
build goes on; the exit code is 1 if any failed.

From code: `import {build} from 'margo-convert/build'`, `import {optimizeModel} from 'margo-convert/optimize'`,
`import {PRESETS} from 'margo-convert/presets'`.

### Not done, and why

- **Draco encoding.** No Draco encoder is installed (the repository ships only the decoder), so Draco is not written.
  Meshopt covers the same job and is smaller to decode. A Draco-compressed input is copied unchanged.
- **Level of detail.** The repository has no mesh simplifier, so no LODs are generated.
- **KTX2 / Basis Universal textures.** No encoder is installed; WebP (or PNG without sharp) is written instead.
- **Audio codecs.** Without an ffmpeg that has `libvorbis`, no Ogg, MP3 or Opus is written; MP3, AAC and Opus inputs
  are never decoded, so only WAV is mixed down and resampled.

## Mesh sequences

`margo-convert sequence <folder>` turns a folder of per-frame meshes (a meshed fluid or fracture bake, one `.obj`, `.ply`
or `.stl` a frame, such as Blender's OBJ export with Animation on) into one geometry cache for `GeometryCachePlayer` of
`@margoengine/animation/geometry-cache`. Frames are ordered by the last number in each file name, read one at a time and
written a chunk at a time. Frames of one topology share a chunk; a frame whose mesh changes starts a new one.

```sh
margo-convert sequence ./fluid_mesh --out fluid.mgc --fps 24
```

Options: `--out` (default `<folder>.mgc`), `--fps` (24), `--chunk` (most frames a chunk, default the fps rounded),
`--no-normals` (the player computes smooth ones), `--no-uvs`, `--quiet`. The same from code: `convertSequence(folder,
out, {fps})` from `margo-convert/sequence`. A frame with no triangles is refused by file name. Each frame holds at most
1,000,000 vertices (the cache's chunk limit).

## Playable ads: one HTML file

`margo-convert playable` turns a built app into the single self-contained HTML file that playable-ad networks take:
no other files, and no network requests at run time.

```sh
npx vite build                                              # or any bundler: an index.html plus its files
npx margo-convert playable dist --out playable.html --budget unity
```

The input is a built app folder (its `index.html`), an HTML file, or an entry module (`.js`, `.mjs`; the page is made
for it). Every file under the folder goes in:

- **Modules**: the entry and every module it imports (static, and `import('./x.js')` with a literal) go in as text and
  load through an import map of blob URLs, so code splitting keeps working. A module that imports a package by name
  fails with code `unsupported`: bundle first.
- **Files**: `new URL('./x.wasm', import.meta.url)` (a literal first argument, as bundlers write it) is rewritten to
  the in-page asset map, and `fetch` answers a bundled file from it (a path relative to the page, or a URL made from
  `import.meta.url`) with its content type, so `WebAssembly.instantiateStreaming` and glTF loaders work unchanged.
  Images, audio, video, fonts and scripts get blob URLs, so `img.src` and `new Audio(url)` work too; other files (Wasm,
  `.glb`, `.gltf` and its buffers, `.json`, `.ktx2`) get `margo-playable:/<path>` URLs that `fetch` reads, so a `.gltf`
  finds its `.bin` beside it.
- **The page**: stylesheets become `<style>` with their `url(...)` files as data URLs; `<img src>`, `<source>` and the
  like become data URLs; classic scripts are inlined; `modulepreload` and `preload` links are dropped. Script text is
  escaped so nothing in it can end its element. Source maps, dotfiles and other HTML files stay out.
- **Size**: the report gives the file raw and gzipped and its largest parts. Over the budget the build fails
  (MargoError code `failed` with `error.report`; exit 1) unless `allowOverBudget` (`--allow-over-budget`) is set.

Budgets (`PLAYABLE_BUDGETS`, in bytes, "MB" read as 1,000,000, the stricter reading). Networks change their limits:
pass `{bytes, measure}` (or `--budget <bytes> --measure raw|gzip`) for any other figure, or `false` (`none`) for no check.

| Name | Limit | Measured | Source |
| --- | --- | --- | --- |
| `unity` (default) | 4,999,999 | raw | [Unity Ads playable specifications](https://docs.unity.com/en-us/user-acquisition/creatives/specifications/playable): one `index.html`, less than 5 MB, no network requests, MRAID 3.0 |
| `applovin` | 5,000,000 | raw | [AppLovin creative specs and guidelines](https://support.applovin.com/en/growth/promoting-your-apps/welcome-to-applovin/creative-specs-and-guidelines): one HTML file, 5 MB |
| `meta` | 2,000,000 | raw | [Meta playable ads](https://developers.facebook.com/docs/app-ads/formats/playable-ad/): a single HTML file over 2 MB is refused |
| `chartboost` | 3,000,000 | raw | [Chartboost MRAID playable](https://docs.chartboost.com/en/advertising/creatives/mraid-playable/): one bundled standalone HTML file, 3 MB |
| `liftoff` | 5,000,000 | raw | [Liftoff interactive creatives](https://docs.liftoff.io/liftoff_creatives/liftoff_creatives/interactive_api_integration): single HTML file, 5 MB |
| `moloco` | 5,000,000 | raw | [Moloco playable and IEC creative guide](https://help.moloco.com/hc/en-us/articles/24124525963799-Playable-and-Interactive-End-Card-IEC-creative-guide): single HTML file under 5 MB |
| `iab` | 300,000 | gzip | [IAB Tech Lab New Ad Portfolio (2017)](https://www.iab.com/wp-content/uploads/2019/07/IABNewAdPortfolio_FINAL_0719.pdf): full page ad on a phone over 4.5 in, max initial load 300 kB, file weight gzipped; one file is all initial load |

Unity's and Meta's figures were read from their pages on 2026-11-25; the AppLovin, Chartboost, Liftoff and Moloco
figures from those pages as quoted in [Segwise's network comparison (2026)](https://segwise.ai/blog/playable-ad-specs-by-network-2026)
and Chartboost's documentation. IAB publishes no playable-specific byte limit: its
[Playables Playbook (2019)](https://www.iab.com/wp-content/uploads/2019/05/IAB-Playables-Playbook-Final-June-2019.pdf)
points playables at MRAID 3.0, so `iab` is the New Ad Portfolio's file weight, the strictest figure here. Google Ads,
Mintegral and TikTok take a ZIP, not one file, so they have no preset.

### MRAID and the click-through

The file waits for MRAID's `ready` event and for the ad to be viewable before it runs the entry (Unity's rule; pass
`waitForViewable: false` or `--no-wait-viewable` to start at `ready`). With no MRAID it starts once the page is parsed
and visible. In the app, import the hooks from `margo-convert/playable-runtime`; the published file maps that name to
its own copy, and in a dev server the same import works without MRAID:

```js
import { onViewableChange, open, close } from 'margo-convert/playable-runtime';

const audio = new AudioContext();
onViewableChange((viewable) => (viewable ? audio.resume() : audio.suspend())); // pause and resume with the ad
document.querySelector('#install')?.addEventListener('click', () => {
  open('https://apps.apple.com/app/id000000000'); // FbPlayableAd.onCTAClick(), else mraid.open(url), else window.open
});
document.querySelector('#done')?.addEventListener('click', () => close()); // mraid.close(); false with no MRAID
```

`ready({signal})`, `whenViewable({signal})`, `isViewable()`, `hasMraid()` and `assetURL(path)` (the URL of a bundled
file by its path, for a file the code names without `new URL`) are there too. `mraidScript: true` (`--mraid-script`)
adds `<script src="mraid.js">` for containers that ask for the tag; Unity and AppLovin inject MRAID themselves. MRAID:
IAB Tech Lab,
[Mobile Rich Media Ad Interface Definitions (MRAID) Version 3.0](https://iab.com/wp-content/uploads/2017/07/MRAID_3.0_FINAL.pdf),
2017 (`getState`, the `ready` and `viewableChange` events, `isViewable`, `open`, `close`).

The same from code:

```js
import { writeFile } from 'node:fs/promises';
import { buildPlayable, playableReportText } from 'margo-convert/playable';

const { html, report } = await buildPlayable({ input: 'dist', budget: 'applovin', signal: AbortSignal.timeout(60_000) });
await writeFile('playable.html', html);
console.log(playableReportText(report)); // size raw and gzipped, the budget, the largest files
```

Not done: Web Workers that import other modules (a worker script is a blob of its own and sees no import map), a
`new URL()` whose first argument is not a literal handed to `img.src` (it gets a `margo-playable:` URL only `fetch`
reads), `XMLHttpRequest`, CSS `@import`, and minification (bundle minified first). Limits:
[docs/limits.md](../../docs/limits.md#scale).

## Thumbnail

Render one model to a PNG with no page, for server thumbnails and asset checks.

```sh
npm i webgpu sharp                                        # your choice of binding; sharp only for textured models
npx margo-convert thumbnail helmet.glb --out helmet.png --size 512
npx margo-convert thumbnail helmet.glb --out helmet.png --views front,iso   # helmet.front.png, helmet.iso.png
```

| Option | Default | What it does |
| --- | --- | --- |
| `--out <file>` | `<name>.thumb.png` | The PNG. With several views, each file adds its view: `<name>.<view>.png`. |
| `--size <px>` | `512` | Width and height, 1 to 4096. |
| `--views <list>` | `iso` | Comma-separated: `front`, `back`, `left`, `right`, `top`, `iso`. The camera fits the whole model. |
| `--gpu <module>` | `webgpu` | The WebGPU binding to import from your project, or a path to one. It exports `create(args)` or `gpu`, and optionally `globals`. |
| `--no-sharp` | off | Ignore an installed sharp. A model with textures then fails with an error. |

margo-convert ships no binding, because one is a large download that runs code when installed. A missing binding,
a textured model without sharp, and a model that uses Draco or KTX2 (their decoders need Workers) each fail with a coded
error that names the fix. For Draco or KTX2, export the model uncompressed; `margo-convert optimize` then compresses it
with meshopt, which decodes in Node. Lighting is core's default.

## Tests

`node --test tests/margo-convert-pipeline.test.js tests/margo-convert-textures.test.js tests/margo-convert-audio.test.js tests/margo-convert-paths.test.js tests/margo-convert-playable.test.js` from the repository root (part of `npm run verify`).

Apache-2.0 licensed.
