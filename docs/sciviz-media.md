# Scientific media export

Batch 178 job 3 adds `@margoengine/sciviz/export-media`: `exportImage`, `renderMediaTiles`,
`mediaDimensions`, `exportImageSequence` and `exportVideo`. These optional functions add nothing
to core or stage. The NOAA wind page demonstrates every output using the eight retained daily
NCEP-NCAR Reanalysis 1 fields for January 1-8, 2024. Source attribution and public-domain terms
remain on the page and are included in its exported provenance.

## Capture and ownership

Images use fresh off-axis renders into owned GPU textures. Each texture and readback buffer is
released after its tile; closing the async iterator also removes its private clear pass. A fixed
camera is copied at capture start. The on-screen canvas, primary camera and engine playback are
not resized or stopped. Keep layer data stable during a capture. Overlapping captures on the
same engine reject. WebGPU and the shared WebGL2 compatibility renderer are supported; the native
WebGL2 preview must use `createFallbackFigure` to obtain the target-texture API.

The default scale is 1 CSS pixel per output pixel. `size` instead supplies both dimensions in
`px`, `mm` or `in`; physical dimensions use 300 dpi unless overridden. Scale and size are mutually
exclusive. Layout is the source figure's layout stretched to the requested rectangle. Labels,
legends, colour bars and mathematical outlines are composited at output resolution by default;
`overlays: false` omits them. `transparent: true` clears uncovered pixels to alpha zero. PNG is
lossless. WebP uses browser encoding at quality 0.95 unless overridden.

PNG compression consumes one row of tiles at a time, with no whole-image destination canvas.
WebP and video need a CPU canvas for one frame, while all GPU work remains tiled. The default GPU
tile edge is 1024, clamped to the device limit; `tileSize` can reduce it. `maxBytes` bounds a raw
strip or frame and retained output; its image default is 256 MiB. PNG dimensions are positive
31-bit integers, subject to the memory budget. Still WebP is at most 16383 by 16383 pixels.
Physical density is positive and at most 1000000 dpi. PNG carries pHYs; WebP carries EXIF resolution.

`setLineCameraTile` in the new `@margoengine/lines/tiles` entry supplies a copied full-image
view-projection and tile rectangle. Line joins, caps, widths, distances and colour interpolation
are constructed in that full coordinate system before the finished vertex is cropped. Capture
vertices share a 1/256-pixel grid. Ordinary rendering keeps its existing unsnapped path. The
remover is idempotent and cannot erase a newer assignment. Lines, batches, picking uniforms and
shader variants share the extended frame layout; no core or stage changes are required.

## Timeline files and provenance

Sequences render one frame for each selected timeline index, independently of elapsed wall time.
The default range is the whole timeline and the default frame rate is 10 fps. `start` and `end`
are inclusive. The timeline pauses for export and restores its original selected frame, even
after failure. It remains paused unless `resume: true` requests resumed playback. ZIP files hold
numbered PNG or WebP images plus `manifest.json`, including original data times, presentation
timestamps and provenance. Classic ZIP limits are 65535 entries including the manifest and a
file smaller than 4 GiB. Its stored entries retain their encoded image bytes and CRCs.

Video delegates to the existing `@margoengine/headless/video` WebCodecs encoder and clean-room
WebM/MP4 muxers, retaining their codec negotiation, backpressure, sample tables and seek indexes.
The encoder now accepts a JSON `provenance` record and a `maxBytes` payload limit (512 MiB by
default for direct headless calls). Video is opaque, without synthesized audio. Unsupported
browser codecs reject explicitly. These functions produce complete in-memory files, not live
recordings. AbortSignal cancellation rejects with its original reason and releases owned resources.

An explicit `provenance` option is used first. Otherwise a figure's optional `provenance()` method
is queried when present, without loading that optional entry. Records are embedded in PNG iTXt,
WebP XMP, WebM Tags and MP4 `moov/udta/marg`; image sequences also carry the record in the manifest.
Nonlocal or temporal post effects need to be disabled for independent tile capture. Cross-tile
screen-space filter padding and finer typography/colour-management refinements remain fix-phase work.

## Evidence and reproduction

CPU coverage is in `packages/sciviz/tests/export-media.test.js`, `packages/lines/tests/tiles.test.js`
and `packages/headless/tests/video.test.js`. It checks physical units, projection cropping,
ownership on early exit, overlapping captures, errors and cancellation, PNG chunk CRCs and
scanline coverage, ZIP interoperability through the independent loader, timeline restoration,
container metadata and encoder budget cleanup. The lines projection-width regression reads the
new 112-byte frame layout while preserving its geometric assertions.

Run the built-package browser check through a shared GPU slot:
`node scripts/gpu-lock.mjs run --owner=sciviz-media --wait-max=60 --max=6 -- node packages/sciviz/tests/export-media-browser.mjs`.
It checks both backends on the actual NOAA timeline: whole-image versus tiled PNG pixels, physical
sizes, alpha, WebP decoding, provenance, ZIP contents, restored timeline and browser playback/seek
of WebM and MP4. `test-results/sciviz-media/report.json` records the results. The retained run uses
an 8209-pixel-wide image on an 8192-edge device, in 17 tiles no larger than 512 pixels. Tiled and
whole-image wind pixels match exactly on both backends. These are correctness counts, not timings.

## Clean-room basis

- Chris Blume, Pierre-Anthony Lemieux, Chris Lilley and the PNG Working Group (2025),
  [Portable Network Graphics, Third Edition](https://www.w3.org/TR/png-3/): scanlines, RGBA,
  zlib, chunk CRCs, iTXt and physical density. Reuses Margo's existing PNG container primitives.
- Paul Adenot and Eugene Zemtsov, editors (2026), [WebCodecs](https://www.w3.org/TR/webcodecs/)
  and [AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/): encoder lifecycle,
  frame ownership, timestamps and decoder configuration. Reuses the existing headless encoder.
- Steve Lhomme, Moritz Bunkus and Dave Rice (2024), [RFC 9559, Matroska Media Container Format](https://www.rfc-editor.org/rfc/rfc9559.html):
  nested Tags/SimpleTag metadata. Apple (2012 onward), [QuickTime File Format](https://developer.apple.com/documentation/quicktime-file-format),
  and ISO/IEC (2015), ISO/IEC 14496-12: atom ownership and MP4 user data. Existing Margo muxers are extended.
- J. Zern, P. Massimino and J. Alakuijala (2024), [RFC 9649, WebP Image Format](https://www.rfc-editor.org/rfc/rfc9649.html):
  RIFF chunk sizes, VP8X alpha/metadata flags and EXIF/XMP. JPEG/JEITA (2019),
  [Exif 2.32](https://www.cipa.jp/std/documents/e/DC-X008-Translation-2019-E.pdf): TIFF rational resolution and inch units.
- PKWARE (2022), [APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT):
  UTF-8 names, stored members, CRCs and central-directory offsets.
- Paul Haeberli and Kurt Akeley (1990), [The Accumulation Buffer: Hardware Support for High-Quality Rendering](https://doi.org/10.1145/97879.97913),
  and Khronos (2009), [OpenGL 3.2 Core Specification](https://registry.khronos.org/OpenGL/specs/gl/glspec32.core.pdf):
  image-space sampling, subfrusta and viewport transforms. Offscreen targets preserve the on-screen canvas.
- Samuli Laine and Tero Karras (2011), [High-Performance Software Rasterization on GPUs](https://research.nvidia.com/publication/2011-08_high-performance-software-rasterization-gpus):
  finite subpixel grids, coverage and ordered blending motivate constructing line geometry before tile translation.
  Only the paper was consulted, never its companion implementation.

Standards were compared with Margo's existing headless tiling and media APIs before selecting
private target capture for figure chrome and extending the existing encoder for file metadata.
No rival source, external repository files, package-registry engine code or companion code was used.
