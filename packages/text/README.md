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
- **Layout.** Font size and line height are in world units; ascent and descent come from the font bounding box with half-leading. Lines break at spaces, between ideographs and, for words wider than `maxWidth`, inside the word. Trailing spaces hang outside the line. Kerning is measured per pair with the canvas (`measureText(ab) - a - b`) and cached. Alignment is relative to the widest line; justify spreads the gap over the spaces of every line except the last of a paragraph. Right-to-left runs are reordered with a simplified Unicode bidi algorithm (strong R and L classes, neutrals, numbers kept left to right, bracket pairs, mirrored brackets). `text.layout` exposes every cluster's advance box, the line boxes and the total bounds.
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

## Limits

- WebGPU only. On the WebGL2 backend the plugin warns once and draws nothing.
- Shaping needs the browser's text stack: a worker without the font draws isolated fallback forms. Shaped runs size dynamically without clipping, and letter spacing applies between clusters within shaped runs.
- Outlines plus shadow blur are limited by the field range to about 0.14 em together. Very small text (under about 6 px) loses thin strokes, as with any SDF text.
- Emoji are bitmaps scaled from 48 px, so they soften when magnified far beyond that.
- Extruded 3D glyph geometry is available via `@margoengine/text/extrude` (reads TrueType and PostScript OpenType font binaries directly).
- A FontFace that is still loading delays its text; text drawn with a CSS web font before it loads uses the fallback, so call `await font.load(sample)` first.
- Atlas eviction: once `maxPages` is reached, pages no longer referenced by any active visible `Text` block are evicted and reused. If all pages contain active glyphs, `place` throws.

## Tests

`npm test` in `packages/text` runs Node checks with a deterministic mock measurer: grapheme clusters, advances, kerning, letter spacing, font size and line metrics, wrapping (spaces, hanging spaces, long words, ideographs, `nowrap`), paragraphs, all four alignments including justify, every anchor, right-to-left reordering with numbers, bracket pairs and mirroring, hit testing and carets, option validation, the distance transform and `alphaToSdf` against brute-force references on random binary, sampled and antialiased bitmaps, shelf packing without overlaps, and SSR-safe construction.

`npm run test:browser` (a real-GPU script, not in CI) uses a real engine in Chromium (or Edge with `BROWSER_CHANNEL`): ink position and area within 2.5 px of the layout for all 12 anchor combinations, fill, outline and shadow colors, opacity, overlapping glyphs keeping their fills under outlines, depth against a mesh with `onTop`, billboards after orbiting, mesh attachment and visibility, buffer reuse on string updates with one draw call per block, emoji in color, atlas growth with 2,000 CJK glyphs (Latin, Greek and Cyrillic when no CJK font is installed) with earlier glyphs unchanged, device restore, disposal, the WebGL2 no-op, and zero validation errors. It saves `test-results/text-gallery.png`.

The emoji checks do not depend on the machine's fonts. `tests/color-font.js` builds a tiny COLR/CPAL colour font in memory (written from the OpenType specification), and the test loads it with `FontFace` and checks that its flat yellow and green palette colours reach the screen through the colour atlas. The same check also runs with the system's colour emoji font when there is one. A machine without one, such as a headless Linux server, skips that part and prints the reason.

Apache-2.0 licensed.
