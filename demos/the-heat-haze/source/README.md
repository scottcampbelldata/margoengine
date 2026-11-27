# The Heat Haze

Drag **Near-road air difference** from 0 to 28 °C and watch the distant lane markings, posts and red utility truck bend in the warm band above the road. **Pause shimmer** holds the current field still so the endpoints can be compared at one phase. Reduced-motion preferences start the exhibit paused. The phone and desktop use the same scene, field, material detail and optical pass. The lens framing adapts to the canvas aspect ratio.

The road, plant forms, roadside objects, basin and stepped mesas were authored procedurally for this exhibit. Margo Terrain samples the terrain in metres. The live Margo HeatHaze pass integrates the optical effect through a 12 × 10 × 46 world-space temperature grid whose cells are 0.73 × 0.115 × 3.20 m. The illustrative field uses 34 °C ambient air at 98.6 kPa, with the indicated near-road contrast decaying over a 0.302 m height scale and two moving perturbations. The post pass converts temperature to air refractivity, integrates gradients along each ray and uses scene depth to place the distortion behind the warm air. Bending is shown at 1.65 times the model's optical displacement. At 0 °C contrast the volume is uniform and the effect is disabled. This exhibit demonstrates rendering through a prescribed field. It makes no claim about the temperature profile of a specific road.

## Verification

The browser test starts a new process for every profile and uses the gallery's exact compatibility module preloads. Phone emulation uses a 390 × 844 CSS-pixel viewport, 2× device scale, 150 ms latency, 1.6 Mbps download, disabled HTTP cache and 4× CPU throttling. It waits for a real trusted slider tap and the resulting completed render. It also verifies live phase advance, pause and stable phase, keyboard endpoints, renderer selection and error-free browser operation.

On the final clean local run, the first scrub completed at 1.398 s native WebGPU, 2.810 s automatic WebGL2 and 2.842 s forced WebGL2. Earlier automatic fallback trials reached 3.104 s and 3.102 s. Compatibility startup has limited margin and needs the signed-out hosted gate. An instrumented diagnostic run at 4× isolated 1.175 s in the creation of the largest volumetric shader pipeline. Queue submission in the same run took 32 ms. The instrumented probe was removed before the final test.

Rendered output was cross-checked from full desktop and phone screenshots. At least 5,280 pixels changed by four or more levels between paused 0 °C and 28 °C settings on every tested path. At least 1,049 changed during live playback. The upper 40% of each rendered image had zero changed pixels at that threshold.

From the showcase checkout, with `MARGO_ENGINE_CHECKOUT` pointing to the verified engine checkout:

```powershell
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/the-heat-haze/check.mjs
python qa-output/the-heat-haze/measure.py
```

## Sources

- Philip E. Ciddor, “Refractive index of air: new equations for the visible and near infrared,” *Applied Optics* (1996), [DOI](https://doi.org/10.1364/AO.35.001566).
- Jack A. Stone and Jay H. Zimmerman, “Index of Refraction of Air,” [NIST](https://www.nist.gov/publications/index-refraction-air).
- Markus Raffel, “Background-oriented schlieren (BOS) techniques,” *Experiments in Fluids* (2015), [DOI](https://doi.org/10.1007/s00348-015-1927-5).
- Arizona Department of Transportation, *Sonoran Corridor Tier 1 Final Environmental Impact Statement*, landscape reference, [Appendix A](https://azdot.gov/sites/default/files/media/2021/11/Sonoran-Corridor-Final-Tier-1-EIS-Appendix-A-Draft-Tier-1-EIS.pdf).
- Margo Engine public revision `0efd9cff8230507a32deb49907ecd499d46925f5`, [HeatHaze API and implementation references](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/post/src/heat-haze.ts).
