# HDR Window

Compare the same gallery framing in SDR and HDR. The cast ceramic, polished orbit and smaller chrome sample reflect the sunset outside the window. At first load the page shows SDR. An HDR-capable WebGPU browser exposes a real HDR button and, where supported, enables Display P3. An SDR screen or the WebGL2 compatibility layer exposes Highlight detail, a −1.25 stop SDR grade for examining the bright sky and reflections. The canvas presents the same geometry and radiance in both cases.

OpenEXR and Ultra HDR JPEG describe two encodings of the same original 288 × 144 environment. The menu reloads the lighting and background from the selected source. The OpenEXR contains scene-linear RGB in three HALF channels using lossless ZIP storage. The Ultra HDR file uses an ICC-tagged sRGB JPEG base, a separate grayscale gain-map JPEG, and Adobe gain map XMP, GContainer and MPF metadata. Margo reconstructs scene radiance with the gain map at full weight. The unit-white numbers are measurements of the source luminance in scene-linear Rec.709.

## Rendering and source

The installation, gallery, materials and environment field were authored for this exhibit. Margo Engine produces all displayed frames. `author-environment.mjs` samples the original procedural illumination field and writes OpenEXR through Margo. `author-gainmap.py` builds the gain map and losslessly repacks the EXR using the OpenEXR writer. OpenEXR, NumPy and Pillow are build-time tools for those assets.

Native WebGPU decodes the EXR and builds the Margo environment. The WebGL2 route loads the same processed environment as a lossless Margo KTX2 cube from `atrium-ibl-packed.bin`. Both use the same cube resolution, IBL settings, source content and display grade. The 40,429-byte archive uses reversible byte-lane deltas and gzip. It reconstructs all 135,432 source KTX2 bytes exactly. The page preloads the relevant route's lighting asset when the HTML is parsed. The alternate JPEG is loaded and decoded at selection time on both paths.

Both display grades use Margo Tonemap with Khronos PBR Neutral. Margo ColorOutput negotiates `rgba16float`, extended tone mapping and Display P3 on eligible WebGPU browsers. The rendered peak is capped at 4× SDR white. Actual light output depends on device headroom.

## Verification

Cold mobile checks used fresh Chrome processes, a 390 × 844 CSS-pixel viewport at 2× device scale, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. A real touchscreen tap selected the first alternative display grade. The clock stopped when Margo completed the corresponding rendered frame.

| Route | First completed mobile grade |
| --- | ---: |
| Native WebGPU | 1.634 s |
| Automatic WebGL2 compatibility | 2.343 s |
| Forced WebGL2 compatibility | 2.349 s |

Desktop and phone tests switched between both grades and both sources on WebGPU and WebGL2. Screenshot probes found only 0.035 levels of mean maximum-channel difference between native and compatibility SDR phone frames. The earlier hosted forced route measured 3.174 s before the smaller compatibility archive and conditional preloads. The only browser warning was Chrome's Windows notice about ignoring adapter power preference.

A separate probe emulated HDR/P3 media support to exercise the actual WebGPU canvas path. The browser configured the canvas as `rgba16float` with `display-p3` and extended tone mapping. Raw readback found 57,661 desktop pixels and 46,911 phone pixels with at least one channel above encoded SDR white, with maxima of 1.6504 and 1.8145. The test workstation used a standard-range physical screen. Those results verify the canvas signal and do not measure physical display luminance.

From the showcase checkout, using the verified `MARGO_ENGINE_CHECKOUT`:

```powershell
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/hdr-window/check.mjs
python qa-output/hdr-window/measure.py
$env:HDR_WINDOW_FLOAT = '1'
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/hdr-window/check.mjs desktop-hdr mobile-hdr
```

Regenerate the assets with `node src/hdr-window/author-environment.mjs qa-output/hdr-window/atrium-linear.bin`, `python src/hdr-window/author-gainmap.py qa-output/hdr-window/atrium-linear.bin` and `node qa-output/hdr-window/bake.mjs`. The last step uses the pinned engine's WebGPU prefilter and KTX2 exporter.

## Sources

- Academy Software Foundation, *OpenEXR Technical Introduction* and *Scene-Linear Image Representation*. [Technical introduction](https://openexr.com/en/latest/TechnicalIntroduction.html), [scene-linear representation](https://openexr.com/en/latest/SceneLinear.html)
- Android Developers, *Ultra HDR Image Format v1.1*. [Format specification](https://developer.android.com/media/platform/hdr-image-format)
- W3C, *Media Queries Level 5*, color gamut and dynamic range. [Specification](https://www.w3.org/TR/mediaqueries-5/)
- Khronos, *PBR Neutral Tone Mapper*. [Primary reference](https://www.khronos.org/gltf/pbr)
- Yale University, *Stairways to Scholarship*. Material and geometry reference for the original gallery installation. [Architectural reference](https://your.yale.edu/youryale/2026-01-12-stairways-to-scholarship)
- Margo Engine `0efd9cff8230507a32deb49907ecd499d46925f5`. [Environment API](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/environment/README.md)
