# The CRT Arcade

Exhibit 155 is **Terminal Vela**, an original playable inspection run. Launch the courier and steer left, center or right to clear six rings before the transfer lock. The flight lasts about 19 seconds. After the last ring, the courier returns to the center for the transfer lock. Use the three lane buttons, the arrow keys, or keys 1–3. Use Launch and Pause to control the run. A missed ring counts against the score and the run continues.

## Display

The entire scene is built from original geometry, including the shuttle hull, ring assemblies, deck equipment, gas giant and its rings. The camera advances through the same scene as the courier. No images, game assets or external textures are used.

Margo `Render3D` draws the scene into a 192 × 108 offscreen color and depth viewport. The outline pass uses its live depth texture. Margo `PaletteQuantize` maps that view to 24 colors in Oklab with a 4 × 4 Bayer pattern. Margo `CRT` outputs to a 768 × 432 framebuffer with curved glass, art-row scanlines, an RGB aperture mask and glow. The Display menu isolates the plain nearest raster. Palette and Dither adjust the actual shader stages. Green phosphor replaces palette entries using their luminance.

Native WebGPU is attempted first. Automatic and forced fallback use the same WGSL passes through the full Margo WebGL2 compatibility layer. Append `?backend=webgl2` to force the latter. Both phone and desktop use the same scene, source raster and effects. The CRT settings are stylized.

## Course model

The three lane centers are 3.18 m apart. The courier advances at 4.95 m/s and lateral motion is acceleration-limited. The game interpolates the craft's world-space x position at each crossing between 120 Hz steps. A ring credits an alignment within 0.49 m of its center. The rule is an arcade alignment test. The shuttle banks and the ring and lane lights update from the same live state.

## Verification

Run `node qa-output/the-crt-arcade/mechanics.mjs` from the gallery root to check all six exact gate depths, correct and incorrect alignment, pause, completion and replay. With `MARGO_ENGINE_CHECKOUT` set to the verified built checkout, `CRT_ARCADE_PRELOAD=1` runs the production-style local browser build from `qa-output/the-crt-arcade/check.mjs`. `CRT_ARCADE_SOLVE=1` also plays the full route on desktop keyboard and emulated phone touch.

The cold mobile browser test uses 390 × 844 Chrome, DPR 2, 150 ms delay, 1.6 Mbps download and 4× CPU throttling. It measures a trusted Launch through actual craft displacement over 83 mm and a completed renderer submission. It also checks live steering, a stationary pause, and separate rendering changes from the palette, dither and CRT controls. Timing uses desktop Chrome mobile emulation.

## References

- [Verified public Margo Engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5)
- [Recent Improvements in the 21AXP22 Color Kinescope, RCA Review](https://www.earlytelevision.org/pdf/recent_improvements_in_the_21axp22_color_kinescope.pdf) informed the historical display details.
- [An Optimum Method for Two-Level Rendition of Continuous-Tone Pictures, Bryce Bayer, 1973](https://ndlsearch.ndl.go.jp/en/books/R100000136-I1570009749134624128) documents the threshold method used by the Margo dithering stage.
- [Jewel of the Solar System, NASA Jet Propulsion Laboratory](https://www.jpl.nasa.gov/images/pia17474-jewel-of-the-solar-system/) and [ISS Flight Configuration, NASA](https://ntrs.nasa.gov/api/citations/20000068483/downloads/20000068483.pdf) informed the original planet colors and truss details.
