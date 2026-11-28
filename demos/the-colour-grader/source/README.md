# The Colour Grader

Compare **PBR Neutral**, **AgX** and **ACES fit** on one live scene. The white-hot signal and red-orange rings make changes in highlight colour easy to see. **Warm highlights** varies the live Margo Grade controls for shadows, midtones and highlights. **Local exposure** lifts the darker parts of the room and reduces the brightest areas through Margo's regional exposure filter.

Open a display-linear RGB 3D .cube LUT to apply it after the tone curve and Grade. **Save grade as .cube** writes a 65³ LUT for the current Grade. The file contains 274,625 samples and the demonstrated export is about 15.4 MB of plain text. The curve, local exposure and any imported LUT remain separate controls. Local file handling runs in the browser.

## Scene and rendering

The original coastal signal room, cabinetry, sill, distant shoreline and brass-ringed optic are Margo geometry. The optic's glass and mounting parts are an artistic reference to a Fresnel lantern. They demonstrate colour range rather than optical focusing. Margo Lightformer supplies linear HDR radiance for the lens and the two indicators. Both devices use the same scene, source values and multi-sample anti-aliasing. PBR Neutral and AgX use the pinned Tonemap operators. The ACES button uses Margo's real-time fitted approximation.

Grade operates after the tone curve. LocalExposure uses a luminance-dependent bilateral base, operates before the tone curve and turns on when the slider moves above zero. At the maximum slider setting its shader strength is 0.68 with a 2.8 stop limit. Relative local differences remain visible across both device sizes.

## Verification

Cold mobile profiles ran in fresh Chrome processes, 390 × 844 CSS pixels, 2× device scale, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. The first input was a trusted touchscreen press on AgX. The timing ends after the rendered frame's GPU fence.

| Renderer | Navigation to first completed curve |
| --- | ---: |
| Native WebGPU | 1.307 s |
| Automatic Margo WebGL2 | 2.191 s |
| Forced Margo WebGL2 | 2.278 s |

Browser QA exercised all three curves, both grading sliders, actual LUT download, re-import, invalid-file feedback and clearing the LUT. At least 405,458 phone pixels changed by four RGB levels from PBR Neutral for each curve, Grade and LocalExposure comparison. LocalExposure raised the mean 8-bit luminance of the dark mask by 36.56 levels and lowered the bright mask by 21.51. The exported Grade re-import reproduced the live grade within 0.166 levels of mean maximum RGB-channel difference on the phone. The baseline frame returned when the LUT was cleared.

From the showcase checkout with `MARGO_ENGINE_CHECKOUT` set to the verified engine root:

```powershell
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/the-colour-grader/check.mjs
python qa-output/the-colour-grader/measure.py
```

## Sources

- Frédo Durand and Julie Dorsey, *Fast Bilateral Filtering for the Display of High-Dynamic-Range Images* (SIGGRAPH 2002). [Paper](https://people.csail.mit.edu/fredo/PUBLI/Siggraph2002/DurandBilateral.pdf)
- Khronos Group, *PBR Neutral Tone Mapper*. [Specification and references](https://www.khronos.org/gltf/pbr)
- Blender, *Color Management*, AgX. [Documentation](https://docs.blender.org/manual/en/latest/render/color_management.html)
- Academy Software Foundation, *Academy Color Encoding System*, display transforms. [Official documentation](https://docs.acescentral.com/system-components/output-transforms/)
- Adobe, *Cube LUT Specification*. [File format](https://wwwimages2.adobe.com/content/dam/acom/en/products/speedgrade/cc/pdfs/cube-lut-specification-1.0.pdf)
- National Park Service, *History of the 1858 Fire Island Lighthouse 1st Order Fresnel Lens*. [Material and form reference](https://www.nps.gov/fiis/learn/historyculture/fresnel-lens-history.htm)
- Margo Engine `0efd9cff8230507a32deb49907ecd499d46925f5`. [Tonemap, Grade, LocalExposure and LUT documentation](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/tonemap/README.md)
