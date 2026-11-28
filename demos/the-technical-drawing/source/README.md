# The Technical Drawing

An original equatorial refractor drawn in four bands of ink. Move **View angle** to orbit the assembly and watch the four internal light baffles come in and out of view. **Hidden lines** toggles the occluded edges. **Reset view** restores the opening angle and hidden ink.

The scene uses 50 closed solids with 23,016 triangles. The objective hood has a measured 150 mm front opening. The recessed lens is smaller. The polar bearing sits 42° above horizontal, and the declination axis is perpendicular to it. The telescope and mount are an original illustration with fixed axes and illustrative optical surfaces.

## Drawing and build

- Margo’s `featureEdges` extracts actual welded edges at the chosen crease angles. Coplanar triangle seams stay out of the illustration.
- Margo’s `HiddenLine` pass uses the scene depth to reveal selected occluded features. The baffle rings are actual inner lip edges. Hidden strokes use round-ended dashes.
- Margo Toon supplies a four-band shade and an inverted-hull contour. The view uses an orthographic camera. The lettered leaders follow their model anchors as the view changes.
- Built entirely from local source with public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Native WebGPU and Margo’s full WebGL2 compatibility path render the same geometry and drawing passes. No model, font or texture downloads.

## Verification

The topology regression `qa-output/the-technical-drawing/model-proof.mjs` checks that each body is a closed, consistently oriented solid. It also checks the 150 mm hood opening, perpendicular rotational axes, and the polar altitude. The browser check `qa-output/the-technical-drawing/check.mjs` builds from the gallery pin, operates the angle slider with a trusted click or touch, waits for the resulting GPU work, tests both buttons and compares rendered pixels with hidden ink off and on. It saves the frame comparisons and exact timing data to the same QA folder.

First trusted input through the completed orbit render took 1.751 s on native WebGPU, 2.684 s on forced WebGL2 and 2.277 s on automatic WebGL2. These are local production-build runs in fresh 390 px Chrome contexts at 150 ms latency, 1.6 Mbps and fourfold CPU slowdown. The desktop figures were 0.565 s on native WebGPU and 0.260 s on forced WebGL2. Both rendering paths matched the measured 2,397 hidden-ink pixels on the mobile frame and 922 on desktop at the home angle. All five profiles finished without errors.

## References

- American Society of Mechanical Engineers. *ASME Y14.2, Line Conventions and Lettering*. Line hierarchy and hidden-line conventions. [ASME standard](https://www.asme.org/codes-standards/find-codes-standards/line-conventions-and-lettering)
- NASA Science. *Telescopes 101*. Refracting optical arrangement. [NASA telescope overview](https://science.nasa.gov/universe/telescopes-101/)
- Celestron, April 2018. *How do I balance my telescope on an Equatorial mount?* The right ascension and declination axes and their relation to the counterweight. [Manufacturer's guide](https://www.celestron.com/blogs/knowledgebase/how-do-i-balance-my-telescope-on-an-equatorial-mount)
- Astro-Physics. *1100GTO German Equatorial Mount*. Physical reference for polar and declination housings. [Manufacturer's model](https://www.astro-physics.com/1100gto)
- Amy Gooch, Bruce Gooch, Peter Shirley and Elaine Cohen, 1998. *A Non-Photorealistic Lighting Model for Automatic Technical Illustration*. Illustration reference for the combination of shaded surfaces and explicit ink edges. [Original paper](https://doi.org/10.1145/280814.280950)
