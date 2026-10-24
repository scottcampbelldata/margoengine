# Margo PDF: what it needs from the engine

Status: **on hold.** Margo PDF waits until the engine is finished. Nothing here is built yet; this page records the
request so the work starts from it. Reviewed against engine revision 85467ba2 (2026-10-22).

Margo PDF is Scott's Acrobat-style PDF app for desktop and browser. It has its own PDF engine (planned in Rust, built
native and for Wasm). It wants small optional graphics packages from Margo Engine, not a PDF parser.

## Who owns what

| Margo PDF | Margo Engine |
| --- | --- |
| PDF syntax, objects, streams, encryption, recovery | GPU device, surface and resource management |
| Font encodings, character-to-glyph mapping, text extraction, reading order | Drawing glyphs, paths, images and masks it is given |
| Graphics-state interpretation; turning content into ordered drawing commands | Running those commands exactly |
| Editing, annotations, forms, undo, saving | Viewport rendering, bounded caches, scheduling, diagnostics |
| Signatures, redaction, OCR, accessibility, export | Colour transforms and compositing |

PDF-specific code stays out of the engine; the graphics packages must be useful to any 2D app.

## Start from what exists

- `@margoengine/math/vector2` and `/matrix3`: page and view transforms, pointer conversion.
- `@margoengine/cache`: a URL fetch cache, not document storage or a tile cache.
- `@margoengine/input`: action state; PDF shortcuts, focus and text selection stay in the app.
- Core `FramePass` / `PassContext` ([plugin.ts](../packages/core/src/plugin.ts),
  [extension.ts](../packages/core/src/extension.ts)): GPU access inside an Engine, but they need a scene engine.
- `@margoengine/text` renders browser fonts into SDF atlases ([README](../packages/text/README.md)); it is not a way to
  draw positioned glyphs from PDF font data.

Core and stage stay frozen ([AGENTS.md](../AGENTS.md)); everything below is optional packages or subpaths.

## Gaps to fill (names are placeholders)

1. **GPU host.** A device and canvas surface without a scene, camera or lights. Owned or supplied device, resize,
   device loss and restore, capability report, sizing by viewport and display scale within device limits (not the
   scene's DPR/MSAA policy or its 4096-pixel cap), draw only when something changed, OffscreenCanvas where available.
2. **Ordered 2D drawing.** Run a command stream in order: transformed paths and cubic curves, images, glyph shapes or
   masks; nonzero and even-odd fills; strokes with joins, caps, miter limits and dashes; nested clips; gradients,
   patterns, opacity, soft masks, group surfaces; blend modes with isolated and knockout groups in a stated colour
   space. No lighting or tone mapping on document colours. A software backend implements the same contract as a
   fallback and a reference.
3. **Exact glyphs.** Glyph IDs and positions with caller-supplied outlines or bitmaps; no reflow, shaping or font
   substitution. Transforms, fill/stroke, glyph clipping, colour glyphs. Bounded caches keyed by font, glyph, transform
   and raster settings, rebuilt after device loss. Sharp small text at any zoom; SDF only where it is proven accurate.
4. **Tiles and scheduling.** Visible tiles first, nearby prefetch within a budget, cancel stale work on scroll, zoom
   or edit (revision IDs), separate CPU and GPU byte budgets, cache keys with revision, region, scale and colour
   settings, region-only invalidation, no full-page texture for large pages. The caller supplies the render job.
5. **Colour.** ICC-based transforms, grey/RGB/CMYK, caller-chosen blending space and output profile, groundwork for
   separations and overprint preview. Approximate display output must never be presented as exact print output.

## Boundary between app and renderer

The PDF engine turns pages into ordered commands and resource handles; the app sends commands, viewport and revision
to the renderer; the renderer schedules, draws and reports completion, cancellation, memory and timing. It never edits
PDF objects. Large payloads go in typed binary buffers with explicit ownership (including Wasm memory growth), handles
have explicit lifetimes, unchanged resources are reused, and nothing is sent per glyph as JSON. The engine renders
through browser WebGPU from TypeScript; a native Rust renderer would be a separate decision. No UI framework
dependency.

## Order of work

| Stage | Delivers | Evidence |
| --- | --- | --- |
| Inventory | Each need mapped to an existing import, a gap or a stated limit | Import map with source links |
| A | GPU host, ordered paths, images, clips, resize, disposal | Minimal consumer, drawing and high-DPI fixtures, size report |
| B | Exact glyphs, tiles, cancellation, bounded caches | Small text and deep zoom, fast navigation, stale-result rejection, device loss |
| C | Groups, masks, blending, colour, software-backend agreement | Compositing and colour fixtures with stated tolerances |

## Acceptance

- Unused features stay out of a minimal consumer's built bundle (checked on built output).
- Core/stage behaviour and the 25,000-byte gate are unchanged; each package reports its own gzip bytes, workers and
  dependencies ([entry sizes](../examples/package-benchmarks/results/entry-sizes.json)).
- Tests cover paint order, compound paths, nested clips, overlapping glyphs, masks and groups, device loss, high-DPI
  resize, cancellation, memory budgets and cleanup.
- Startup, first content, scroll/zoom response, CPU/GPU time, uploads, peak memory and idle work are measured on named
  hardware; budgets are set after a baseline. 3D numbers say nothing about PDF performance.
