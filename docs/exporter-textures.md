# Texture resize and platform encoding

The optional `@margoengine/exporters/textures` entry exports resizeTexture,
encodeTexture, textureFormatSupported and transformTextures. No platform probe,
registration, outside encoder, core change or stage change occurs on import.

resizeTexture takes straight RGBA8 rows and returns owned pixels. Defaults:
Lanczos3, sRGB, associated-alpha filtering for colour, original dimensions and no
signal. A width or height alone preserves aspect ratio; both specify exact
dimensions. maxSize then fits inside that square without further upscaling. Box
integrates fractional source-pixel footprints; bilinear uses the tent kernel;
Lanczos uses a windowed sinc. Tent and sinc supports widen for minification.
Edges extend the nearest sample; each axis normalizes weights. RGB is filtered
in linear light using the piecewise IEC sRGB transfer function, alpha stays
linear. Linear data maps filter channels independently by default.
premultiplyAlpha overrides that choice. Equal dimensions return an exact copy.
Quantization stabilizes half-byte ties within 1e-12 byte against double-precision
accumulation error. Dimensions cap at 16384 per side and 16777216 pixels for
input, output and horizontal intermediate. Float64 RGBA intermediate storage
caps at 512 MiB; smaller images use proportionately less. Axis weights and a
256-value transfer table are precomputed. No speed claim or new Wasm is added.

encodeTexture takes pixels or encoded bytes and returns data, mimeType, width
and height. Existing Margo readers load lazily for PNG/JPEG/WebP/DDS and supported
KTX/KTX2 inputs. Defaults: WebP, native quality 0.9, and the resize defaults above.
PNG uses Margo's existing writer, including without canvas in Node. WebP, AVIF
and JPEG use OffscreenCanvas.convertToBlob or HTML canvas.toBlob. Format support
is determined by actual serialization and returned MIME, including silent PNG
substitution. textureFormatSupported performs an uncached one-pixel probe.
Missing canvas/context or substituted PNG raises MargoError `unsupported`
naming the requested image MIME and a help URL. Null blobs are `failed`, and an
unsettled platform encoder is `timeout` after 30 seconds. AbortSignal rejects a
pending encode immediately, although the native operation cannot be cancelled.
Synchronous resize checks signals between rows; an abort scheduled on the same
thread runs after that synchronous operation. Native quality is an encoder
setting, not a promised fidelity percentage. JPEG uses platform alpha flattening;
canvas storage may round RGB under very low alpha. No universal AVIF encoder
support is claimed. AVIF input bytes need a decoder that decodeImage does not
currently supply; callers can supply RGBA8. The separate portable clean-room
AVIF encoder remains in Scott's finish-later list; no libavif is included.

transformTextures takes a GLB, using material slots (including KHR extensions)
to distinguish colour and linear data. Shared colour/data textures split;
equal image/role pairs reuse one output image. Samplers, texture/image metadata,
texCoord and unknown GLB chunks survive. A core image source is preferred when
reprocessing to avoid another lossy generation. Embedded/data-URI images work
directly; external URIs require resolveImage(uri, signal), with no automatic
fetch. Sampler-only textures remain untouched. Unused images and buffer views
leave the file. Unrelated extensions survive.

WebP/AVIF images are held at texture.extensions.EXT_texture_webp.source or
texture.extensions.EXT_texture_avif.source with image/webp or image/avif MIME.
With fallback 'png' or 'jpeg', a separate image at the same resized dimensions
becomes texture.source; the extension is used but not required. With no fallback
(default), source is omitted and the extension is both used and required.
PNG/JPEG output removes obsolete format-extension declarations. AVIF follows
the published draft contract, without a ratification claim.

Evidence: textures.test.js has 19 tests including subtests: analytical sRGB/data
averages, fractional box coverage, bilinear centres, minification antialiasing,
transparent edges, anisotropic constants, ownership, bounds, JPEG/PNG input,
actual PNG decoding, role splitting, image metadata, required/fallback flags,
external/data URIs, DOM serialization, native failure and cancellation. AVIF uses
an explicitly labelled platform double for extension wiring, not an AVIF
bitstream proof. textures-browser.js tests native serialization and independent
browser decoding, fallback dimensions, required flags and DOM toBlob. Both
native WebGPU and WebGL2 compatibility package runs passed. Chromium
157.0.4341.42 encoded WebP and returned the documented unsupported AVIF error.
Existing package rendering, PNG and capture checks also passed. CPU tests of
exporters and dependent packages: 1237 passed, zero failures/skips. No benchmark,
universal compression-ratio or time claim.

New entry: absent (0 B) to 10015 B minified gzip, ceiling 10316 B. This includes
resize, platform checks, GLB processing and lazy image helpers. Splitting these
processing operations would complicate callers; core/stage sources are unchanged.

Research compared these papers and standards, combining footprint integration,
scale-aware separable reconstruction, linear light and associated alpha. No
rival source or paper companion implementation was read or copied:

- Ken Turkowski, *Filters for Common Resampling Tasks*, 1990,
  https://people.csail.mit.edu/ericchan/bib/pdf/ResamplingFilters.pdf.
  Box, triangle and Lanczos support and antialiasing trade-offs.
- Neil Anthony Dodgson, *Image Resampling*, 1992,
  https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-261.pdf.
  Separable reconstruction and minification.
- Thomas Porter and Tom Duff, *Compositing Digital Images*, 1984,
  https://keithp.com/~keithp/porterduff/p253-porter.pdf.
  Associated colour/alpha prevents transparent fringe contamination.
- International Color Consortium, *How to interpret the sRGB color space
  (specified in IEC 61966-2-1) for ICC profiles*, 2015,
  https://registry.color.org/rgb-registry/files/sRGB.pdf.
  Piecewise transfer function instead of an approximate gamma.
- WHATWG contributors, *HTML Living Standard: Canvas*, 2026,
  https://html.spec.whatwg.org/multipage/canvas.html.
  Native encoding, MIME substitution and quality behavior.
- Khronos Group contributors, *EXT_texture_webp*, 2021,
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_texture_webp/README.md.
- Leon Radley, Don McCurdy and Alexey Knyazev, *EXT_texture_avif*, draft,
  accessed 2026,
  https://github.com/KhronosGroup/glTF/blob/5cb7518cf9a1bfb8268320026961b21caf5a4aac/extensions/2.0/Vendor/EXT_texture_avif/README.md.
  Both contracts define image source, MIME and core fallback rules.
- Don McCurdy and contributors, *glTF Transform EXTTextureAVIF documentation*,
  accessed 2026,
  https://gltf-transform.dev/modules/extensions/classes/EXTTextureAVIF.
  Public behavior comparison only. This entry adds Scott's requested optional
  PNG/JPEG fallback to the documented always-required output policy.
