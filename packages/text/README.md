# @margoengine/text

Import `margoengine/text` from the `margoengine` package, or `@margoengine/text` from this package alone; the two are the same module. Both are on npm at 0.1.0. See [Install](https://github.com/scottcampbelldata/margoengine/blob/main/README.md#install) in the repository README.

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
- **Layout.** Font size and line height are in world units; ascent and descent come from the font bounding box with half-leading. Lines break at spaces, between ideographs and, for words wider than `maxWidth`, inside the word. Trailing spaces hang outside the line. Kerning is measured per pair with the canvas (`measureText(ab) - a - b`) and cached. Alignment is relative to the widest line; justify spreads the gap over the spaces of every line except the last of a paragraph. Right-to-left runs are reordered with a simplified Unicode bidi algorithm (UAX #9 revision 52 without explicit embeddings, isolates or overrides: strong L, R and AL classes; the weak number rules W2 to W7, so a number after Hebrew or Arabic sits on its left, Arabic-Indic digits read left to right and separators and currency signs join their number; bracket pairs, simplified; neutrals with numbers acting as R; mirrored brackets). Numbers do not decide a paragraph's direction (rule P2). Until 2026-11-10 digits counted as strong left-to-right letters, so `abc שלום 123` put the number on the wrong side of the Hebrew and Arabic-Indic digits came out reversed; the fix re-recorded the layout corpus hash in tests/layout-workcount.test.js (one corpus text changed). Levels are resolved over the whole paragraph and only reordering is per line (UAX #9 section 3.4), and a tab with the whitespace before it takes the paragraph level (rule L1); until 2026-11-11 levels were resolved line by line, so after a wrap `x אב 12 גד` drew its second line `12 דג` where the annex gives `דג 12`, and the corpus hash was re-recorded again (one layout's flags and positions moved, same characters). `text.layout` exposes every cluster's advance box, the line boxes and the total bounds.
- **One draw call per block.** Glyph quads live in a storage buffer and are expanded in the vertex shader. Shadow, outline and fill are layers of the same instanced draw (instance `i` draws glyph `i % n` in layer `i / n`), so every fill is drawn over every neighbour's outline. Antialiasing uses screen-space derivatives of the atlas coordinates, so edges stay one pixel wide at any scale or angle.
- **Blending and depth.** Premultiplied alpha blending, reversed-Z depth test (`greater-equal`) without depth writes, so overlapping glyph quads never z-fight. Blocks are sorted back to front; `onTop` blocks draw last with the depth test off.
- **Placement.** World-oriented text uses its local matrix, times the attached mesh's world matrix from `engineRuntime(engine).store.matrices`. Billboard text keeps the model's origin and scale and spans the camera's right and up vectors. Text attached to a hidden or disposed mesh is skipped.
- **Lifecycle.** `onDeviceRestored` rebuilds pipelines, buffers and atlases; `dispose` (via `removePlugin`) releases them. Texts stay registered.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `text` | `''` | |
| `font` | sans-serif | A shared `Font` or `{family, weight, style, face}`; a numeric weight must be 1 to 1000 (CSS Fonts 4), as the canvas ignores a font it cannot parse |
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

Every preset ends in `apply()`, which also lays the glyphs out again when the font has loaded since the last layout
(its `revision` moved), the font was replaced or a layout field (`fontSize`, `maxWidth`, `textAlign` and the rest) was
assigned; glyphs keep their offsets, scales and colors when the drawn clusters stay the same. `setStyle` and the
outline, shadow, `billboard` and `onTop` fields reach every glyph on the next `apply()`. `typewriter` throws a
RangeError for a non-finite `progress`, `count` or `popScale`. (Before 2026-11-11 a block built
before its font loaded kept the fallback font's spacing, and styles set after construction were never drawn.)

## Extruded 3D text: `extrudeText`

`@margoengine/text/extrude` reads OpenType font outlines (TrueType `glyf`/`loca`, PostScript `CFF ` and `CFF2` tables, variable
fonts) through `parseTTFSource` of `@margoengine/loaders/font`, Margo's one font parser (CFF, CFF2 and variable instances
need its readers: pass `openType` from `@margoengine/loaders/font-opentype` in the options), triangulates the 2D glyph paths with hole bridging, and extrudes them into 3D solid geometry with front/back caps, side walls,
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

A CFF (`.otf`) file or a variable instance needs the OpenType readers of `@margoengine/loaders/font-opentype`; TrueType
fonts extrude without them, so pages that ship only `.ttf` files never load the readers:

```ts
import {extrudeText} from 'margoengine/text/extrude';
import {openType} from 'margoengine/loaders/font-opentype';

const otf = await (await fetch('/fonts/SourceSans3-Regular.otf')).arrayBuffer();
const title = extrudeText('Margo', {font: otf, openType, size: 1, depth: 0.2});
console.log(title.positions.length > 0); // true
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
outlines, name-keyed or CID-keyed CFF Type 2 outlines or CFF2 outlines; unpack a WOFF or WOFF2 file with `decodeWOFF`
of `@margoengine/loaders/font-woff` first. Shaping comes from `shapedRuns`.
The parser's budgets apply (composites nest at most 16 levels with 4,096 components and 1,000,000 points per glyph;
Type 2 uses the specification's 48 operands, 96 stems and 10 nested subroutine calls, plus a 100,000-operation
execution budget). Contour filling accepts at most 16,384 flattened vertices per glyph; mesh allocation has a
conservative 1,000,000-vertex budget per text block. Boundary vertices weld at 1e-12 of the glyph
extent. Malformed fonts throw the parser's `LoaderError` (`code` `'header'`, `'truncated'`, `'range'`, `'limit'` or
`'unsupported'`); layout and subdivision limits throw `MargoError` with `code: 'failed'` and a help link.
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
  // Fallback for a file the parser does not read (bitmap-only fonts, or WOFF2 bytes not yet decoded): browser SDF text.
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

`VectorFont(bytes, {family?, variations?, size?, radius?})` is an `GlyphFieldFont` (see below): advances come from `hmtx`, ascent and descent from `hhea`, and pair kerning from the file's GPOS (or `kern` table) in a page and in Node alike; a variable instance gets none. No `FontFace` is registered. The same font also draws with the SDF `TextRenderer`, from fields built on the CPU from its outlines. `vectorGlyph(id)` and `store` expose the packed bands, and `vectorCoverage(store, glyph, x, y, pixelsPerEm)` is a CPU mirror of the shader for tests and hit maps.

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

Rotated 17 degrees: 0.0029. Zoomed 40 times: 0.0001. The largest single-pixel error in any case is 0.139. The bar is a mean under 1/64 and a maximum under 0.25 on both backends. Counting only pixels with ink the means are higher (CJK at 4 px 0.018, Latin at 8 px 0.0165). A 0.49 px stem at 6 px keeps 0.49 px of ink in every row, with a worst row error of 0.062 against the reference, where `TextRenderer`'s SDF gives the same rows a worst error of 0.365 (at 4 px: 0.060 against 0.581; the SDF figures are the same `VectorFont`'s fields built from its outlines at 64 px since 2026-11-16, and were 0.341 and 0.557 with the browser's canvas fields). SDF and MSDF text, which the other web text libraries use, share that loss: a field sampled at 48 px cannot hold features smaller than its texels. 100,000 glyphs draw in 100 calls; the first frame uploads 4.8 MB and later frames write 112 bytes.

**Clean-room record.** Built from these papers alone, without reading any implementation of them:

- Eric Lengyel, "GPU-Centered Font Rendering Directly from Glyph Outlines", Journal of Computer Graphics Techniques 6(2), 2017, https://jcgt.org/published/0006/02/02/ : root classification, bands and per-axis coverage. The lookup constant, the stable root form, the window coverage under nonzero winding, the adaptive rays, the axis blend and the dilation formula were derived here.
- Charles Loop and Jim Blinn, "Resolution Independent Curve Rendering using Programmable Graphics Hardware", SIGGRAPH 2005: the implicit view of a quadratic, used for the inside test. Its per-glyph triangulation was ruled out.
- Will Dobbie, "GPU text rendering with vector textures", 2016: grid cells holding curve lists, which confirmed the band layout.
- Mark Kilgard and Jeff Bolz, "GPU-accelerated Path Rendering", SIGGRAPH Asia 2012, and Diego Nehab and Hugues Hoppe, "Random-access rendering of general vector graphics", SIGGRAPH Asia 2008: ruled out as heavier for text (stencil-and-cover passes, lattice clipping).
- Patents, checked 2026-11-10. US 10,373,352 B1 (Lengyel, the root-counting method) was dedicated to the public domain effective 2026-03-17: https://terathon.com/blog/decade-slug.html and https://patents.google.com/patent/US10373352B1/en. US 7,564,459 B2 (Loop and Blinn) expired on 2026-03-25: https://patents.google.com/patent/US7564459B2/en. US 7,239,319 B2 (rendering outline fonts) lapsed in 2019: https://patents.google.com/patent/US7239319B2/en.

**Limits.** No outlines yet: `outlineWidth` is ignored, with one warning. Shaping is `GlyphFieldFont`'s: GPOS pair kerning and, with `ligatures: true`, GSUB `liga` ligatures, but no contextual forms or mark attachment (a combining mark with no precomposed glyph is drawn at its base's advance, so it lands over the base only when the font draws marks left of their zero-width origin); a variable instance gets no kerning. No colour fonts (COLR, emoji). WOFF and WOFF2 files must be unpacked to plain OpenType first, and bitmap-only fonts are not read. Curve points are 16-bit fractions of the glyph box and the shader works in 32-bit floats. Caps are listed in [docs/limits.md](../../docs/limits.md).

## Text from a font file, the same in a page and in Node: `GlyphFieldFont`

`@margoengine/text/outline` builds every glyph's distance field on the CPU from the font file's own outlines, with no browser API on any path. (`GlyphFieldFont` was named `OutlineFont` before 2026-11-16; `OutlineFont` is now only the outline font of `@margoengine/loaders/font`, whose parser reads the file here too.) Titles, captions and lower thirds therefore render in a headless Node process (a film render, a thumbnail server) as they do in a page: the glyph fields are byte for byte the same, and the frames match within two levels. Draw it with the ordinary `TextRenderer`; outlines, shadows, `RichText`, `AnimatedText`, `fitText`, labels and `Ui({font})` work as with `Font`.

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { Camera, Engine } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, toPNG } from '@margoengine/headless';
import { Text, TextRenderer } from '@margoengine/text';
import { GlyphFieldFont } from '@margoengine/text/outline';
import { create } from 'webgpu';

// 64 px per em suits captions; use size 128 or 256 for large titles.
const font = new GlyphFieldFont(await readFile('SourceSans3-Regular.ttf'), { size: 64 });
using installed = installGPU({ gpu: create([]) });
const engine = await Engine.create(createHeadlessCanvas({ width: 1280, height: 720 }), { backend: 'webgpu' });
engine.scene.background = '#1d2733';
const text = TextRenderer.attach(engine);
text.add(new Text({
  text: 'When It Forms', font, fontSize: 0.6, anchorX: 'center', anchorY: 'middle', color: '#ffd84a',
  outlineWidth: 0.03, outlineColor: '#000000', shadowOpacity: 0.6, shadowBlur: 0.04, shadowOffset: [0.03, -0.03],
}));
text.add(new Text({ text: 'office: ligatures on', font, ligatures: true, fontSize: 0.15, anchorX: 'center', position: [0, -0.6, 0] }));
engine.render({ camera: new Camera({ position: [0, 0, 3], target: [0, 0, 0] }) });
await writeFile('title.png', await toPNG(engine));

// The fields built here, for the next scene process: importGlyphs takes them only for the same file, size and radius.
await writeFile('glyphs.bin', font.exportGlyphs());
const next = new GlyphFieldFont(await readFile('SourceSans3-Regular.ttf'), { size: 64 });
console.log(next.importGlyphs(await readFile('glyphs.bin')), next.prepare('When It Forms')); // true 0
engine.dispose();
```

| Option | Default | Notes |
| --- | --- | --- |
| `size` | `64` | Pixels per em of the stored fields, an integer from 8 to 512. Captions and lower thirds at 58 to 80 px per em draw near 1:1 at 64; titles of 150 to 300 px want 128 or 256. A 256 px glyph fills about a ninth of a 1,024 px atlas page. |
| `radius` | `size / 4` | Field range in pixels, above 0 and at most `size / 2`. The default leaves 0.17 em for outline plus shadow blur together; `size / 2` doubles that at half the edge precision. |
| `variations` | `{}` | Axis values of a variable font, for example `{ wght: 650 }`. Kerning follows the instance. |
| `family` | a unique name | A name for errors and logs; nothing is registered. |
| `field` | `'mtsdf'` | `'mtsdf'`: three distance channels whose median keeps corners sharp at any title size, and the one-channel field in alpha for outlines and shadows; 4 bytes per texel in the RGBA glyph atlas (a 64 px Latin glyph of Source Sans 3 averages 12.9 KB, against 3.2 KB as SDF). `'msdf'`: the three channels, alpha 255, 4 bytes per texel. `'sdf'`: one channel, 1 byte per texel, a quarter of the memory; corners round once a glyph is drawn well above `size`. |
| `openType` | none | The CFF, CFF2 and variation readers, `openType` from `@margoengine/loaders/font-opentype`: needed for a `.otf` (CFF) file or a `variations` instance. `GlyphFieldFont.load` and `VectorFont.load` import them on their own when the file or options need them, so pages that use only TrueType fonts never load them. |

`GlyphFieldFont.load(url, {signal, ...options})` downloads a file first. `shape(text)` returns the glyph ids, pen offsets and advance of a string; `prepare(text, layoutOptions)` builds the fields a text needs and returns how many it built; `stats` counts fields built (`rasterized`), distance evaluations, texels the multi-channel error correction collapsed (`corrected`) and imported fields. `exportGlyphs()` and `importGlyphs(bytes)` carry built fields to a fresh process: the `key` hashes the font bytes, size, radius, cutoff, field kind, variations and the field builder's version, and a cache with another key is refused (`false`). The engine never touches the file system; the host stores the bytes. `new Font()` in Node still throws `unsupported`, and its message names `GlyphFieldFont`.

**How it works.**

- **Fields from outlines.** Each glyph's lines, quadratics and cubics are cut into straight pieces by the uniform second-difference bound, so no piece strays more than a quarter of a byte step (at most 1/64 px) from the curve. The sign of each texel is the nonzero winding number of the outline, counted by scanline crossings at texel centres; the magnitude is the exact distance from the texel centre to the nearest piece, worked out only inside each piece's box grown by the field's reach, so the cost follows the outline's length, not its area. Bytes use the same encoding as `Font` (`alphaToSdf`), so the shader, atlas and outline and shadow layers are unchanged. Every sampled texel is within one level of a brute-force reference with 4,096 points per curve, for TrueType, CFF, a variable instance and CJK at 32, 64 and 128 px (tests/outline.test.js).
- **Overlapping contours.** Variable fonts and many CJK fonts draw a glyph from overlapping or touching parts. Edges with ink on both sides are left out of the distance: every piece is cut into quarter-pixel parts, and a part with ink a 1/32 px step to both sides of its middle is dropped, so the inside shows no seam. Two overlapping squares, or two that share an edge, give the field of their union within one level.
- **Sharp corners (MTSDF).** A one-channel field stores the distance to the nearest edge, and its bilinear samples round every corner by about half a texel, which shows on a title drawn many times its field size. The default field splits the outline's edges at corners into two-channel colours so the two edges meeting at a corner share exactly one channel; each channel stores the signed pseudo-distance to its nearest edge, and the median of the three, taken after filtering, rebuilds the corner. Texels whose median would draw an edge that is not in the outline (a clash between channels) are found by following the interpolated median along each line between neighbours and across each texel cell: wherever it puts a point half a texel or more from the exact outline on the wrong side, those texels get the true distance in every channel. Alpha holds the one-channel field byte for byte, and outlines and shadows read it, because a median of pseudo-distances is not a distance far from the edge. On Source Sans 3 at 32 px the samples that land on the wrong side further than a quarter texel from the outline fall from 117 to 4 (tests/outline-msdf.test.js), and no font in the tests gets more of them than its one-channel field. `BitmapFont` atlases of type `mtsdf` draw the same way.
- **The same bytes everywhere.** Only addition, subtraction, multiplication, division and square roots touch fractional values, and IEEE 754 rounds each of them the same way on every machine, so a page and Node build identical fields (the GPU test compares their SHA-256).
- **Kerning and ligatures.** Pair kerning is read from GPOS (lookup type 2, formats 1 and 2, through extension lookups) for the `kern` feature of the character's script (Latin, Greek, Cyrillic, else the default script), or from the legacy `kern` table when GPOS has none; the value is the first glyph's XAdvance. It equals what Chromium's own shaper measures on the 20 test pairs of Source Sans 3 TTF and OTF. With `ligatures: true` on a `Text`, each Latin word is one shaped run: GSUB `liga` ligatures (lookup type 4) replace their components and the run's field is built as one bitmap (`office` draws the ffi ligature, as HarfBuzz shapes it).
- **Speed.** Measured on the development PC in Node, one core: 88 Latin glyphs of Source Sans 3 at 64 px build in 22 to 33 ms (about 65,000 distance evaluations each), and 13 glyphs at 256 px in 38 ms. A film's glyph set costs well under a second once, and nothing in a fresh process that imports the cache.

**Web fonts.** `GlyphFieldFont.load` and `VectorFont.load` take `.woff` and `.woff2` files as they are, importing
`@margoengine/loaders/font-woff` only for them. The constructors take OpenType bytes: pass `decodeWOFF(bytes)`.

```ts
import {GlyphFieldFont} from 'margoengine/text/outline';

const web = await GlyphFieldFont.load('/fonts/SourceSans3.woff2');
console.log(web.advance('Title') > 0); // true
```

**Limits.** No Arabic or Indic shaping, mark attachment (GPOS type 4) or contextual substitutions; no colour fonts or emoji; no hinting. Where contours overlap (variable fonts, many CJK glyphs) the corners at an overlap are as sharp as the colours of the two contours allow, which can be no sharper than the one-channel field; corners elsewhere stay sharp. `field: 'sdf'` rounds every corner. Caps are in [docs/limits.md](../../docs/limits.md).

**Clean-room record.** Built from these sources, without reading any implementation (full record in docs/clean-room.md, "Text outline SDF"):

- C. Green, "Improved Alpha-Tested Magnification for Vector Textures and Special Effects", SIGGRAPH 2007 Course 28 (Advanced Real-Time Rendering in 3D Graphics and Games), chapter 2, https://www.advances.realtimerendering.com/s2007/ : distance fields in one texture channel, with outlines and shadows from the same field.
- K. Hormann and A. Agathos, "The point in polygon problem for arbitrary polygons", Computational Geometry 20(3), 2001, https://doi.org/10.1016/S0925-7721(01)00012-8 : the nonzero winding number by crossings.
- J. Gravesen, "Adaptive subdivision and the length and energy of Bezier curves", Computational Geometry 8(1), 1997, https://doi.org/10.1016/0925-7721(95)00054-2 , and R. Goldman, "Pyramid Algorithms", Morgan Kaufmann, 2003: the chord bound of a uniformly split curve from its second differences.
- C. Ericson, "Real-Time Collision Detection", Morgan Kaufmann, 2005, chapter 5: the closest point on a segment.
- P. F. Felzenszwalb and D. P. Huttenlocher, "Distance Transforms of Sampled Functions", Theory of Computing 8(19), 2012, https://doi.org/10.4086/toc.2012.v008a019 , and S. F. Frisken, R. N. Perry, A. P. Rockwood and T. R. Jones, "Adaptively Sampled Distance Fields", SIGGRAPH 2000, https://doi.org/10.1145/344779.344899 : compared and not used here; sampled transforms lose the sub-texel edge position the outline gives exactly.
- E. Lengyel, "GPU-Centered Font Rendering Directly from Glyph Outlines", JCGT 6(2), 2017, https://jcgt.org/published/0006/02/02/ ; J. Manson and S. Schaefer, "Analytic Rasterization of Curves with Polynomial Filters", Computer Graphics Forum 32(2), 2013, https://doi.org/10.1111/cgf.12070 ; E. Catmull, "A Hidden-Surface Algorithm with Anti-Aliasing", SIGGRAPH 1978, https://doi.org/10.1145/965139.807360 : exact coverage, the fallback the plan kept and did not need.
- G. Rong and T.-S. Tan, "Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform", I3D 2006, https://doi.org/10.1145/1111411.1111431 : ruled out, as GPU results differ per backend and need a readback for the cache.
- V. Chlumsky, "Shape Decomposition for Multi-channel Distance Fields", master's thesis, Czech Technical University in Prague, 2015, https://dspace.cvut.cz/entities/publication/f75fe895-d252-4118-9884-1455fde4ed26 , and V. Chlumsky, J. Sloup and I. Simecek, "Improved Corners with Multi-Channel Signed Distance Fields", Computer Graphics Forum 37(1), 2018, https://doi.org/10.1111/cgf.13265 : edge colouring, signed pseudo-distance, the median, error correction and the true distance in a fourth channel (MTSDF), all from the papers.
- Microsoft and Adobe, OpenType Specification 1.9.1 (2024), https://learn.microsoft.com/en-us/typography/opentype/spec/ (GPOS, GSUB, kern, hmtx, hhea, OpenType Layout common table formats); ISO/IEC 14496-22:2019 Open Font Format; Unicode UAX #15 Normalization Forms, revision 58, https://www.unicode.org/reports/tr15/ .

## Caption files: `@margoengine/text/captions`

`parseSrt` and `parseVtt` read SubRip (.srt) and WebVTT (.vtt) files into cues with times in seconds; `toSrt` and `toVtt` write them back, to the millisecond. Plain TypeScript with no DOM, so the same code runs in Node, a worker or a page. `cueText` turns a cue line into plain text: markup such as `<i>`, `<v Ann>` and `<00:01.500>` removed, `&amp;` and the other escapes decoded.

```ts
import {cueText, parseSrt, toVtt} from 'margoengine/text/captions';

const {cues, problems} = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> there\n');
console.log(cues[0].start, cues[0].end, cueText(cues[0].lines[0]), problems.length); // 1 2.5 Hello there 0
console.log(toVtt(cues)); // WEBVTT, then 1, 00:00:01.000 --> 00:00:02.500, <i>Hello</i> there
```

- The readers never throw on a bad file. Each block they skip is listed in `problems` with its line number, and they keep going; a byte order mark and CRLF, CR or LF line ends are read.
- WebVTT follows the W3C parser: the `WEBVTT` signature and header, cue identifiers, settings (`align:start line:0`, kept as written in `settings`), NOTE comments, STYLE and REGION blocks before the first cue (in `styles` and `regions`), and both timestamp forms (`01:02.000` and `01:02:03.000`). A block with a timing line is a cue even when its identifier starts with NOTE, as in the spec's parser. A payload line holding `-->` ends the cue and is reported.
- SubRip has no formal standard, so the reader takes what files in the wild hold: the counter line is optional, a `.` before the milliseconds and trailing `X1:` position data are read, and times past 59 minutes or seconds are reported.
- The writers throw a `RangeError` with a help link on a cue they cannot write so that it reads back the same: a negative or non-finite time, an end not after its start once rounded to the millisecond, no lines, or a blank line or `-->` in its text, id or settings. `toVtt` writes lines as given, so markup stays; escape a literal `&` or `<` as `&amp;` or `&lt;`.

Sources: W3C, "WebVTT: The Web Video Text Tracks Format", Candidate Recommendation, 4 April 2019, https://www.w3.org/TR/webvtt1/ (sections 4.1, 4.2.2, 4.4, 4.5, 6.1 and 6.4); Library of Congress, "SubRip Subtitle (SRT)", https://www.loc.gov/preservation/digital/formats/fdd/fdd000569.shtml .

## Limits

- Requires native WebGPU or the full WebGL2 compatibility layer. The small preview throws linked `unsupported` during setup.
- Shaping needs the browser's text stack: a worker without the font draws isolated fallback forms. Shaped runs size dynamically without clipping, and letter spacing applies between clusters within shaped runs.
- Outlines plus shadow blur are limited by the field range to about 0.14 em together. SDF text under about 6 px loses thin strokes; `@margoengine/text/vector` keeps them (a 0.49 px stem at 6 px keeps 0.49 px of ink, worst row error 0.062 against 0.365 for SDF; see Vector text).
- Emoji are bitmaps scaled from 48 px, so they soften when magnified far beyond that.
- Exact vector text from the font's curves is available via `@margoengine/text/vector` (its own limits are in Vector text above).
- Extruded 3D glyph geometry is available via `@margoengine/text/extrude` (reads TrueType and PostScript OpenType font binaries through `@margoengine/loaders/font`).
- A FontFace that is still loading delays its text; text drawn with a CSS web font before it loads uses the fallback, so call `await font.load(sample)` first.
- `fitText` and `FittedText` drop trailing white space before the ellipsis; `visibleEnd` is the end of the shown text, and the ellipsis glyph maps to it with length 0 (changed 2026-11-14: before, the dropped space counted as visible and the ellipsis owned it).
- Atlas eviction: once `maxPages` is reached, pages no longer referenced by any active visible `Text` block are evicted and reused. If all pages contain active glyphs, `place` throws.

## Tests

`npm test` in `packages/text` runs Node checks with a deterministic mock measurer: grapheme clusters, advances, kerning, letter spacing, font size and line metrics, wrapping (spaces, hanging spaces, long words, ideographs, `nowrap`), paragraphs, all four alignments including justify, every anchor, right-to-left reordering with numbers, bracket pairs and mirroring, hit testing and carets, option validation, the distance transform and `alphaToSdf` against brute-force references on random binary, sampled and antialiased bitmaps, shelf packing without overlaps, and SSR-safe construction.

`npm run test:gpu:outline` (a real-GPU script) draws a title with an outline and a soft shadow, a kerned caption and small text with `GlyphFieldFont` on a page canvas and in a Node process on the `webgpu` binding, and requires byte-identical glyph fields, every channel within 2 levels and at most 0.1 % of pixels off by more than 1 (measured on an RTX A6000: no pixel differs at all); it also checks the file's kerning against Chromium's shaper. `tests/outline.test.js` checks fields against a brute-force reference, winding, overlapping and abutting contours, kerning, ligatures and the glyph cache.

`npm run test:browser` (a real-GPU script, not in CI) uses a real engine in Chromium (or Edge with `BROWSER_CHANNEL`): ink position and area within 2.5 px of the layout for all 12 anchor combinations, fill, outline and shadow colors, opacity, overlapping glyphs keeping their fills under outlines, depth against a mesh with `onTop`, billboards after orbiting, mesh attachment and visibility, buffer reuse on string updates with one draw call per block, emoji in color, atlas growth with 2,000 CJK glyphs (Latin, Greek and Cyrillic when no CJK font is installed) with earlier glyphs unchanged, device restore, disposal, the WebGL2 preview refusal, and zero validation errors. It saves `test-results/text-gallery.png`.

The emoji checks do not depend on the machine's fonts. `tests/color-font.js` builds a tiny COLR/CPAL colour font in memory (written from the OpenType specification), and the test loads it with `FontFace` and checks that its flat yellow and green palette colours reach the screen through the colour atlas. The same check also runs with the system's colour emoji font when there is one. A machine without one, such as a headless Linux server, skips that part and prints the reason.

Apache-2.0 licensed.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.
