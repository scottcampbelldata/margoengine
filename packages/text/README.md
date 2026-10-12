# @margoengine/text

Crisp GPU text for Margo Engine: signed distance field glyphs generated at runtime from any browser font, with wrapping, alignment, anchors, outlines, soft shadows and billboards, as a WebGPU engine plugin.

Not yet published to npm. Build from source with `npm run build` in `packages/text`.

Replaces troika-three-text's `Text` and the label and signage use cases of the three.js `TextGeometry` add-on.

```ts
import {Engine, box} from '@margoengine/core';
import {TextRenderer, Text, Font} from '@margoengine/text';

const engine = await Engine.create(canvas);
const text = new TextRenderer();
engine.use(text);

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

// On teardown: engine.removePlugin('text') or engine.dispose().
```

## How it works

- **Glyphs on demand.** Text is split into grapheme clusters (`Intl.Segmenter`), so combining marks, flags and emoji sequences stay whole. Each new cluster is drawn once at 48 px on an OffscreenCanvas (or a canvas element), and its alpha is turned into an 8-bit signed distance field with the exact Euclidean distance transform TinySDF uses (Felzenszwalb and Huttenlocher, with sub-pixel seeding from antialiased edges). Glyphs with colored pixels, such as emoji, are kept as premultiplied RGBA bitmaps instead. Nothing touches the DOM until the first measurement, so construction is SSR-safe.
- **Growable atlases.** Glyphs are shelf-packed into a single-channel texture array (1024 px pages, 1 MB each) and emoji into an RGBA array (512 px pages), uploaded one at a time with `writeTexture`. When a page fills, the array grows by doubling its layers on the GPU, so existing glyphs never move. CPU bitmaps stay with the `Font`, so a restored device re-uploads them.
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

## Limits

- WebGPU only. On the WebGL2 backend the plugin warns once and draws nothing.
- Each cluster is rasterized in isolation, so scripts that need contextual shaping (Arabic joining, Indic conjuncts) render as isolated forms, and ligatures are not formed. Hebrew and other non-joining right-to-left scripts work. Bidi is simplified: no explicit embeddings, isolates or weak-type rules beyond digits staying left to right.
- Outlines plus shadow blur are limited by the field range to about 0.14 em together. Very small text (under about 6 px) loses thin strokes, as with any SDF text.
- Emoji are bitmaps scaled from 48 px, so they soften when magnified far beyond that.
- No extruded 3D glyph geometry (three.js `TextGeometry` meshes); that needs vector outlines a browser canvas does not expose.
- A FontFace that is still loading delays its text; text drawn with a CSS web font before it loads uses the fallback, so call `await font.load(sample)` first.
- The atlas never evicts. It throws once `maxPages` pages are full.

## Tests

`npm test` in `packages/text` runs Node checks with a deterministic mock measurer: grapheme clusters, advances, kerning, letter spacing, font size and line metrics, wrapping (spaces, hanging spaces, long words, ideographs, `nowrap`), paragraphs, all four alignments including justify, every anchor, right-to-left reordering with numbers, bracket pairs and mirroring, hit testing and carets, option validation, the distance transform and `alphaToSdf` against brute-force references on random binary, sampled and antialiased bitmaps, shelf packing without overlaps, and SSR-safe construction.

`npm run test:browser` uses a real engine in Chromium (or Edge with `BROWSER_CHANNEL`): ink position and area within 2.5 px of the layout for all 12 anchor combinations, fill, outline and shadow colors, opacity, overlapping glyphs keeping their fills under outlines, depth against a mesh with `onTop`, billboards after orbiting, mesh attachment and visibility, buffer reuse on string updates with one draw call per block, emoji in color, atlas growth with 2,000 CJK glyphs (Latin, Greek and Cyrillic when no CJK font is installed) with earlier glyphs unchanged, device restore, disposal, the WebGL2 no-op, and zero validation errors. It saves `test-results/text-gallery.png`.

MIT licensed.
