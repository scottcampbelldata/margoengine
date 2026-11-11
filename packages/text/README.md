# @margoengine/text

Import `margoengine/text` from the `margoengine` package, or `@margoengine/text` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Crisp GPU text for Margo Engine: signed distance field glyphs generated at runtime from any browser font, with wrapping, alignment, anchors, outlines, soft shadows and billboards, as a WebGPU engine plugin.

Build from source with `npm run build` in `packages/text`.

SDF `Text` for Latin, Greek, Cyrillic, CJK, Hebrew, Arabic, Indic scripts and emoji (shaped by the browser; see Shaping), for labels and signage.

```ts
import {Engine, box} from 'margoengine/core';
import {TextRenderer, Text, Font} from 'margoengine/text';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const text = TextRenderer.attach(engine);

// Any font the browser can render: a CSS family, or a FontFace that is loaded and registered for you.
const inter = new Font({family: 'Inter, sans-serif', weight: 600});
const title = text.add(new Text({
  text: 'Hello, world', font: inter, fontSize: 0.5,
  maxWidth: 4, textAlign: 'center', anchorX: 'center', anchorY: 'middle',
  color: '#ffd84a', outlineWidth: 0.02, outlineColor: '#000000',
  shadowOpacity: 0.6, shadowBlur: 0.03, shadowOffset: [0.02, -0.02],
  position: [0, 2, 0],
}));

// A label that follows a mesh and always faces the camera.
const mesh = engine.createMesh().setGeometry(box());
text.add(new Text({text: 'Crate 7', fontSize: 0.2, anchorX: 'center', anchorY: 'bottom', billboard: true, mesh, position: [0, 0.6, 0]}));

// Every field can change at any time. Same-size updates reuse the GPU buffers.
title.text = 'Score: 42';
title.color.set([1, 0, 0]);

// Hit testing and carets in the block's local space.
const index = title.hitTest(0.3, -0.1);
const caret = title.caretRect(index); // {x, top, bottom, line}
title.layout.bounds;                  // {left, right, top, bottom}

// Free atlas pages when old text blocks are removed or replaced.
text.evictUnused();

// On teardown: engine.removePlugin('text') or engine.dispose().
```

## How it works

- **Glyphs on demand.** Text is split into grapheme clusters (`Intl.Segmenter`), so combining marks, flags and emoji sequences stay whole. Each new cluster is drawn once at 48 px on an OffscreenCanvas (or a canvas element), and its alpha is turned into an 8-bit signed distance field with an exact Euclidean distance transform (Felzenszwalb and Huttenlocher's lower envelope of parabolas), with sub-pixel edge positions taken from antialiased coverage. Glyphs with colored pixels, such as emoji, are kept as premultiplied RGBA bitmaps instead. Nothing touches the DOM until the first measurement, so construction is SSR-safe.
- **Growable atlases and eviction.** Glyphs are shelf-packed into a single-channel texture array (1024 px pages, 1 MB each) and emoji into an RGBA array (512 px pages), uploaded one at a time with `writeTexture`. When a page fills, the array grows by doubling its layers on the GPU, so existing glyphs never move. CPU bitmaps stay with the `Font`, so a restored device re-uploads them. When `maxPages` is reached, atlas eviction automatically frees pages no longer referenced by any active visible text block, or call `textRenderer.evictUnused()`.
- **Layout.** Font size and line height are in world units; ascent and descent come from the font bounding box with half-leading. Lines break at spaces, between ideographs and, for words wider than `maxWidth`, inside the word. Trailing spaces hang outside the line. Kerning is measured per pair with the canvas (`measureText(ab) - a - b`) and cached. Alignment is relative to the widest line; justify spreads the gap over the spaces of every line except the last of a paragraph. Right-to-left runs are reordered with a simplified Unicode bidi algorithm (UAX #9 revision 52 without explicit embeddings, isolates or overrides: strong L, R and AL classes; the weak number rules W2 to W7, so a number after Hebrew or Arabic sits on its left, Arabic-Indic digits read left to right and separators and currency signs join their number; bracket pairs, simplified; neutrals with numbers acting as R; mirrored brackets). Numbers do not decide a paragraph's direction (rule P2). Until 2026-11-10 digits counted as strong left-to-right letters, so `abc שלום 123` put the number on the wrong side of the Hebrew and Arabic-Indic digits came out reversed; the fix re-recorded the layout corpus hash in tests/layout-workcount.test.js (one corpus text changed). `text.layout` exposes every cluster's advance box, the line boxes and the total bounds.
- **One draw call per block.** Glyph quads live in a storage buffer and are expanded in the vertex shader. Shadow, outline and fill are layers of the same instanced draw (instance `i` draws glyph `i % n` in layer `i / n`), so every fill is drawn over every neighbour's outline. Antialiasing uses screen-space derivatives of the atlas coordinates, so edges stay one pixel wide at any scale or angle.
- **Blending and depth.** Premultiplied alpha blending, reversed-Z depth test (`greater-equal`) without depth writes, so overlapping glyph quads never z-fight. Blocks are sorted back to front; `onTop` blocks draw last with the depth test off.
- **Placement.** World-oriented text uses its local matrix, times the attached mesh's world matrix from `engineRuntime(engine).store.matrices`. Billboard text keeps the model's origin and scale and spans the camera's right and up vectors. Text attached to a hidden or disposed mesh is skipped.
- **Lifecycle.** `onDeviceRestored` rebuilds pipelines, buffers and atlases; `dispose` (via `removePlugin`) releases them. Texts stay registered.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `text` | `''` | |
| `font` | sans-serif | A shared `Font` or `{family, weight, style, face}` |
| `fontSize` | `1` | Em size in world units |
| `lineHeight` | `1.2` | Multiple of `fontSize` |
| `letterSpacing` | `0` | Multiple of `fontSize`, between clusters |
| `maxWidth` | `Infinity` | Wrap width in world units |
| `textAlign` | `'left'` | `'left'`, `'center'`, `'right'`, `'justify'` |
| `anchorX` | `'left'` | `'left'`, `'center'`, `'right'` |
| `anchorY` | `'top'` | `'top'`, `'middle'`, `'bottom'`, `'baseline'` (first line), `'bottom-baseline'` (last line) |
| `direction` | `'auto'` | `'ltr'`, `'rtl'`, or from the first strong character of each paragraph |
| `whiteSpace` / `overflowWrap` | `'normal'` / `'break-word'` | `'nowrap'` ignores `maxWidth`; `'normal'` lets long words overflow |
| `color`, `opacity` | white, `1` | `'#rrggbb'`, `0xrrggbb` or linear `[r, g, b]` |
| `outlineWidth`, `outlineColor`, `outlineOpacity` | `0`, black, `1` | Width in world units |
| `shadowOpacity`, `shadowColor`, `shadowBlur`, `shadowOffset` | `0`, black, `0`, `[0.04, -0.04]` em | Shadow is off until `shadowOpacity > 0` |
| `billboard` | `false` | Face the camera |
| `onTop` | `false` | Skip the depth test |
| `mesh` | `null` | Follow a core mesh |
| `position`, `rotation`, `scale`, `matrix` | identity | Local transform; rotation is XYZ Euler radians |

`TextRenderer` takes `name` (`'text'`), `order` (`22`, after the scene and lines, before post-processing), `atlasSize` (`1024`), `colorAtlasSize` (`512`) and `maxPages` (`64`, capped by `maxTextureArrayLayers`). `layoutText(text, options, measurer)`, `hitTest`, `caretRect`, `alphaToSdf`, `squaredDistanceTransform` and `ShelfPacker` are exported for use without the renderer.

## Shaping

`layoutText` reuses a run's measured prefix for its caret and the logical kerning
value when the same neighbors remain adjacent after visual ordering. Custom
measurers must be deterministic during a call. There is no cache across calls,
so changes to a measurer take effect on the next layout.

```ts
import { layoutText, type TextMeasurer } from '@margoengine/text';

let pairCalls = 0;
const measurer: TextMeasurer = {
  advance: () => 0.5,
  kerning: () => { pairCalls++; return 0; },
  metrics: () => ({ ascent: 0.8, descent: 0.2 }),
};
const layout = layoutText('AVATAR', {}, measurer);
console.log(layout.bounds.right - layout.bounds.left); // 3
console.log(pairCalls); // 5, one call per adjacent pair
```

Arabic and Indic words draw as one shaped run, so the browser's shaper forms joined letters and conjuncts. Runs do not break
across lines. `caretRect` and `hitTest` still move through a run by grapheme, measured from its prefixes. Set `ligatures: true`
for the same on Latin words (fi, fl and whatever else the font forms).

```ts
import {Text} from 'margoengine/text';
const arabic = new Text({text: '\u0633\u0644\u0627\u0645'});
const latin = new Text({text: 'office', ligatures: true});
```

## Rich text: `RichText`

`@margoengine/text/rich` turns small markup into one `Text` per styled run: `<b>`, `<i>`, `<color=#f80>`, `<size=1.5>`,
`<link=url>` and `<img=name>`, with `\<` for a literal bracket. Options: `markup`, `font`, `bold`, `italic`, `boldItalic` (default made
from `font`), `images`, `position` (default the origin), `linkColor` (default `#4080ff`), `fontSize` (1), `lineHeight` (1.2), `maxWidth`
(none), `direction` (`'ltr'`) and any `Text` style. It breaks at spaces and newlines.

```ts
import {Engine} from 'margoengine/core';
import {TextRenderer} from 'margoengine/text';
import {RichText} from 'margoengine/text/rich';
const canvas = document.querySelector('canvas')!;
const star = await createImageBitmap(await (await fetch('/star.png')).blob());
const engine = await Engine.create(canvas);
const renderer = TextRenderer.attach(engine);
const rich = new RichText({
  markup: 'Plain <b>bold</b> <color=#f80>orange</color> <link=/docs>docs</link> <img=star>',
  images: {star},
  maxWidth: 12,
});
await rich.load();
for (const text of rich.texts) renderer.add(text);
console.log(rich.linkAt(1, -0.5));
```

## Prebuilt atlases: `BitmapFont`

`@margoengine/text/msdf` reads a BMFont JSON file with PNG pages from a distance-field generator, so text needs no installed font
and works in workers. Multi-channel atlases reduce to their median channel, which rounds sharp corners slightly.

Copy [source-sans.json](tests/fixtures/fonts/readme/source-sans.json) and
[source-sans.png](tests/fixtures/fonts/readme/source-sans.png) together into your app's `public/fonts/` directory.
This sample contains printable ASCII, generated with Margo's SDF code from Source Sans 3 under the
[SIL Open Font License 1.1](tests/fixtures/fonts/OFL.txt); keep that licence with the files.
Regenerate it in this checkout with `node packages/text/scripts/make-readme-atlas.mjs`.

```ts
import {Text} from 'margoengine/text';
import {BitmapFont} from 'margoengine/text/msdf';
const font = await BitmapFont.load('/fonts/source-sans.json');
const label = new Text({text: 'Hello', font});
```

## Per-glyph animation: `AnimatedText`

`@margoengine/text/animate` provides per-glyph control over position, scale, rotation, color and opacity over time,
including typewriter reveals, wave motion, bouncing and color cycling, while preserving global line wrapping and baseline layout.

```ts
import {AnimatedText} from 'margoengine/text/animate';

const animated = new AnimatedText({
  text: 'Hello Margo',
  fontSize: 1.5,
});

// Typewriter reveal (0 = none visible, 1 = all visible):
animated.typewriter(0.5);

// Sine wave motion across glyphs:
animated.wave(1.0, { amplitude: 0.2, speed: 4 });
```

## Extruded 3D text: `extrudeText`

`@margoengine/text/extrude` parses OpenType font outlines (TrueType `glyf`/`loca` and PostScript `CFF ` tables) directly,
triangulates the 2D glyph paths with hole bridging, and extrudes them into 3D solid geometry with front/back caps, side walls,
and optional bevels. The resulting vertex attributes can be converted to a core `Geometry` and rendered on both WebGPU and WebGL2.

```ts
import { extrudeText } from 'margoengine/text/extrude';

// Procedural glyphs, or an OpenType font binary parsed with parseFontOutlines(buffer):
const font = {
  unitsPerEm: 1000,
  glyphIndex: () => 1,
  glyphAdvance: () => 0.6,
  getGlyphContours: () => [[[0.05, 0], [0.3, 0.75], [0.55, 0], [0.45, 0], [0.3, 0.5], [0.15, 0]]],
};

const geometry = extrudeText('A', {
  font,
  size: 2,
  depth: 0.5,
  bevelEnabled: true,
  bevelThickness: 0.05,
  bevelSize: 0.05,
});

console.log(geometry.positions.length, geometry.indices.length);
```

`FontLike` returns contours and advances in em coordinates, including for procedural fonts; `unitsPerEm` describes
the source font and does not rescale those values. `size` defaults to 1. `depth` defaults to 0.2 world units.
`curveSegments` is an integer in 1..256 (default 12); `steps` is an integer in 1..256 (default 1).
`bevelEnabled` defaults to false. When enabled, `bevelSize` is the outward expansion of the body (default 0.02),
`bevelThickness` is the depth at each end (default 0.02, at most half of `depth`), and `bevelOffset` moves the cap
outline outward (default 0). These three lengths are world units, independent of `size`. `bevelSegments` is an
integer in 0..64 (default 3); 0 and 1 produce a flat chamfer. Collapsing or intersecting bevels throw a coded
`MargoError` (`code: 'failed'`); reduce the bevel to fit the glyph. Normals are unit surface normals, with outward caps.
`letterSpacing` defaults to 0 em, `lineHeight` to 1.2, and `align` to `'left'` (`'center'` and `'right'` are also supported).

Contours use nonzero winding: overlapping and nested contours with the same winding stay filled. Zero-area paths
are discarded without an absolute world-size cutoff. Fonts use Unicode cmap format 4 or 12, unhinted TrueType
outlines or name-keyed CFF1 Type 2 outlines. CID-keyed CFF, CFF2, variations and shaping are outside this entry.
TrueType composite depth is at most 32, with 4,096 components and 200,000 source points per glyph. Type 2 uses
the specification's 48 operands, 96 stems and 10 nested subroutine calls, plus a 100,000-token execution budget.
Outline decoding and contour filling accept at most 16,384 flattened vertices per glyph; mesh allocation has a
conservative 1,000,000-vertex budget per text block. Boundary vertices weld at 1e-12 of the glyph
extent. Malformed font ranges and subdivision limits throw `MargoError` with `code: 'failed'` and a help link.
Depth 0 produces two planar caps; positive depth produces a solid. `toGeometry(Geometry)` takes the core constructor
explicitly; with no constructor it returns the attribute data.

## Vector text: `VectorTextRenderer`

`@margoengine/text/vector` draws `Text` straight from the font's curves on the GPU, with no atlas and no distance field. Every pixel works out how much of it the glyph covers from the outline itself, so text stays sharp from 4 px to a full-screen headline, under any rotation or zoom, and thin strokes survive at small sizes where SDF text fades. It reads TrueType (`glyf`) and PostScript (`CFF ` and `CFF2`) OpenType binaries, variable fonts included, and takes the same `Text` blocks, layout, anchors, billboards, mesh attachment and shadows as `TextRenderer`.

```ts
import {Engine} from 'margoengine/core';
import {Text, TextRenderer, Font} from 'margoengine/text';
import {VectorFont, VectorTextRenderer} from 'margoengine/text/vector';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const bytes = await (await fetch('/fonts/Inter.ttf')).arrayBuffer();

let font: Font;
let text: TextRenderer | VectorTextRenderer;
try {
  // Exact curve coverage; the font is parsed from the file, so no web font has to load first.
  font = new VectorFont(bytes, {family: 'Inter'});
  text = VectorTextRenderer.attach(engine);
} catch {
  // Fallback for a file the parser does not read (WOFF, WOFF2, bitmap-only fonts): SDF text drawn by the browser.
  font = new Font({family: 'Inter, sans-serif'});
  text = TextRenderer.attach(engine);
}

text.add(new Text({text: 'Small text keeps its stems', font, fontSize: 0.1, anchorX: 'center', position: [0, 0, 0]}));
text.add(new Text({text: 'Hamburgefonts', font, fontSize: 0.5, color: '#ffd84a', shadowOpacity: 0.5, shadowBlur: 0.02, position: [0, 1, 0]}));

// Steady frames write 112 bytes and draw once per block.
if (text instanceof VectorTextRenderer) console.log(text.stats);
```

| Option | Default | Notes |
| --- | --- | --- |
| `name` | `'text:vector'` | Plugin name, unique per engine. Both renderers can be attached at once. |
| `order` | `22` | Frame graph slot, the same as `TextRenderer`. |
| `dilation` | `0` | Outline growth in screen pixels, 0 to 1, for darker small text. Layout is unchanged. |
| `rays` | `'auto'` | Rays per axis per pixel: `1`, `3` or `5`. `'auto'` casts 5 under 7.5 px per em and 3 above. |

`VectorFont(bytes, {family?, variations?})` measures advances from `hmtx` and ascent and descent from `hhea`. It also registers the bytes as a `FontFace`; once that face has loaded, kerning is measured through it (a variable instance gets none). `vectorGlyph(id)` and `store` expose the packed bands, and `vectorCoverage(store, glyph, x, y, pixelsPerEm)` is a CPU mirror of the shader for tests and hit maps.

**How it works.**

- **Curves.** Each glyph's outline becomes quadratic Bezier curves in em units. Lines become flat quadratics, and each CFF cubic is split into uniform pieces until the midpoint error bound (sqrt(3)/36 of the third difference over n cubed) is under 1/4096 em.
- **Bands.** The glyph box is cut into up to 32 horizontal and 32 vertical bands, doubled from about one band per four curves until no band holds more than 64 curves. Each band lists the curves that cross it, sorted by their far end along the ray so the shader can stop early. Curve points are stored as 16-bit fractions of the glyph box, one `vec4u` per curve per band, in one growable buffer per font.
- **Coverage.** The fragment shader casts rays along x and y through the pixel. For each curve it picks which of the quadratic's two roots count from the signs of the three control points (a lookup in the 16-bit constant 0x2E74), solves them in a numerically stable form and turns each crossing into a signed distance in pixels. Coverage along a ray is the exact inside length of a one-pixel window under nonzero winding, so overlapping contours, common in CJK fonts, count once. The two axes are blended by how close each one's nearest crossing is. Extra rays per axis are cast only where a curve reaches into the pixel, so most pixels cost one ray per axis.
- **Pixel size.** The screen size of an em comes from the derivatives of the em coordinates, so perspective, rotation and billboards need no special case. Quads are padded by one pixel through the perspective divide.
- **One draw per block.** Shadow and fill are layers of one instanced draw, as in `TextRenderer`, with the same blending, depth and sorting rules. A steady frame writes one 112-byte frame uniform and creates no bind groups.

**Measured (2026-11-10, RTX A6000, native WebGPU and the WebGL2 compatibility layer).** Mean coverage error over the text's pixel box against a 16 x 16 supersampled reference of the same outlines:

| Font | 4 px | 6 px | 8 px | 12 px | 48 px | 400 px |
| --- | --- | --- | --- | --- | --- | --- |
| Source Sans 3 (Latin) | 0.0064 | 0.0060 | 0.0069 | 0.0051 | 0.0012 | 0.0003 |
| Noto Sans SC (CJK) | 0.0100 | 0.0075 | 0.0111 | 0.0092 | 0.0020 | 0.0002 |

Rotated 17 degrees: 0.0029. Zoomed 40 times: 0.0001. The largest single-pixel error in any case is 0.139. The bar is a mean under 1/64 and a maximum under 0.25 on both backends. Counting only pixels with ink the means are higher (CJK at 4 px 0.018, Latin at 8 px 0.0165). A 0.49 px stem at 6 px keeps 0.49 px of ink in every row, with a worst row error of 0.062 against the reference, where `TextRenderer`'s SDF gives the same rows a worst error of 0.341 (at 4 px: 0.060 against 0.557). SDF and MSDF text, which the other web text libraries use, share that loss: a field sampled at 48 px cannot hold features smaller than its texels. 100,000 glyphs draw in 100 calls; the first frame uploads 4.8 MB and later frames write 112 bytes.

**Clean-room record.** Built from these papers alone, without reading any implementation of them:

- Eric Lengyel, "GPU-Centered Font Rendering Directly from Glyph Outlines", Journal of Computer Graphics Techniques 6(2), 2017, https://jcgt.org/published/0006/02/02/ : root classification, bands and per-axis coverage. The lookup constant, the stable root form, the window coverage under nonzero winding, the adaptive rays, the axis blend and the dilation formula were derived here.
- Charles Loop and Jim Blinn, "Resolution Independent Curve Rendering using Programmable Graphics Hardware", SIGGRAPH 2005: the implicit view of a quadratic, used for the inside test. Its per-glyph triangulation was ruled out.
- Will Dobbie, "GPU text rendering with vector textures", 2016: grid cells holding curve lists, which confirmed the band layout.
- Mark Kilgard and Jeff Bolz, "GPU-accelerated Path Rendering", SIGGRAPH Asia 2012, and Diego Nehab and Hugues Hoppe, "Random-access rendering of general vector graphics", SIGGRAPH Asia 2008: ruled out as heavier for text (stencil-and-cover passes, lattice clipping).
- Patents, checked 2026-11-10. US 10,373,352 B1 (Lengyel, the root-counting method) was dedicated to the public domain effective 2026-03-17: https://terathon.com/blog/decade-slug.html and https://patents.google.com/patent/US10373352B1/en. US 7,564,459 B2 (Loop and Blinn) expired on 2026-03-25: https://patents.google.com/patent/US7564459B2/en. US 7,239,319 B2 (rendering outline fonts) lapsed in 2019: https://patents.google.com/patent/US7239319B2/en.

**Limits.** No outlines yet: `outlineWidth` is ignored, with one warning. Shaping is per code point, so there are no ligatures or contextual forms and no `GSUB` or `GPOS`; kerning comes only through the loaded `FontFace`. No colour fonts (COLR, emoji). WOFF and WOFF2 files must be unpacked to plain OpenType first, and bitmap-only fonts are not read. Curve points are 16-bit fractions of the glyph box and the shader works in 32-bit floats. Caps are listed in [docs/limits.md](../../docs/limits.md).

## Limits

- Requires native WebGPU or the full WebGL2 compatibility layer. The small preview throws linked `unsupported` during setup.
- Shaping needs the browser's text stack: a worker without the font draws isolated fallback forms. Shaped runs size dynamically without clipping, and letter spacing applies between clusters within shaped runs.
- Outlines plus shadow blur are limited by the field range to about 0.14 em together. SDF text under about 6 px loses thin strokes; `@margoengine/text/vector` keeps them (a 0.49 px stem at 6 px keeps 0.49 px of ink, worst row error 0.062 against 0.341 for SDF; see Vector text).
- Emoji are bitmaps scaled from 48 px, so they soften when magnified far beyond that.
- Exact vector text from the font's curves is available via `@margoengine/text/vector` (its own limits are in Vector text above).
- Extruded 3D glyph geometry is available via `@margoengine/text/extrude` (reads TrueType and PostScript OpenType font binaries directly).
- A FontFace that is still loading delays its text; text drawn with a CSS web font before it loads uses the fallback, so call `await font.load(sample)` first.
- Atlas eviction: once `maxPages` is reached, pages no longer referenced by any active visible `Text` block are evicted and reused. If all pages contain active glyphs, `place` throws.

## Tests

`npm test` in `packages/text` runs Node checks with a deterministic mock measurer: grapheme clusters, advances, kerning, letter spacing, font size and line metrics, wrapping (spaces, hanging spaces, long words, ideographs, `nowrap`), paragraphs, all four alignments including justify, every anchor, right-to-left reordering with numbers, bracket pairs and mirroring, hit testing and carets, option validation, the distance transform and `alphaToSdf` against brute-force references on random binary, sampled and antialiased bitmaps, shelf packing without overlaps, and SSR-safe construction.

`npm run test:browser` (a real-GPU script, not in CI) uses a real engine in Chromium (or Edge with `BROWSER_CHANNEL`): ink position and area within 2.5 px of the layout for all 12 anchor combinations, fill, outline and shadow colors, opacity, overlapping glyphs keeping their fills under outlines, depth against a mesh with `onTop`, billboards after orbiting, mesh attachment and visibility, buffer reuse on string updates with one draw call per block, emoji in color, atlas growth with 2,000 CJK glyphs (Latin, Greek and Cyrillic when no CJK font is installed) with earlier glyphs unchanged, device restore, disposal, the WebGL2 preview refusal, and zero validation errors. It saves `test-results/text-gallery.png`.

The emoji checks do not depend on the machine's fonts. `tests/color-font.js` builds a tiny COLR/CPAL colour font in memory (written from the OpenType specification), and the test loads it with `FontFace` and checks that its flat yellow and green palette colours reach the screen through the colour atlas. The same check also runs with the system's colour emoji font when there is one. A machine without one, such as a headless Linux server, skips that part and prints the reason.

Apache-2.0 licensed.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.
