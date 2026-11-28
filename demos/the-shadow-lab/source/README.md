# The Shadow Lab

Queue entry 81. A freestanding limestone court contains a folded bronze test object, a leaded glass rosette, and an original potted maple. All three share one directional studio source. The main scrubber adjusts its angular radius from 0° to 12°. The glass switch changes colored panes to neutral transmission. The leaf switch compares transmitted light with opaque leaves.

## Shadow model

- `@margoengine/shadows` uses a 1,024-square shadow map fitted to the court. Its percentage-closer soft shadows use 20 blocker samples and 42 comparison samples on desktop and phone. The control passes the tangent of the source's angular radius as `lightSize`. The baseline point-source setting still uses the same PCSS pipeline with radius zero.
- Each colored glass group is a closed, 20-mm thick geometry. The two interfaces multiply square-root coefficients to yield the designed linear RGB transmittance (T) within each pane. The bronze rim and lead lattice cast opaque shadows. The glass uses fixed RGB attenuation and an illustrative camera surface. This does not model wavelength-resolved glass, refraction or caustics.
- Each maple blade is a thin, lobed 3D surface. The real geometry attenuates direct light in three color channels, which creates both green footprints and open gaps. The pot, stem and branches are opaque. With the leaf switch off, the same blades become opaque PCSS casters. The separately documented native diffuse-transmission spread is omitted to keep the same effect on both devices and renderers. The colored map's edge filter is independent from the opaque PCSS penumbra.

## References

- [Randima Fernando, Percentage-Closer Soft Shadows, SIGGRAPH 2005](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf) for the blocker-dependent penumbra.
- [Morgan McGuire and Eric Enderton, Colored Stochastic Shadow Maps, I3D 2011](https://casual-effects.com/research/McGuire2011CSSM/McGuireI3D11Shadows.pdf) for spectral transmission and the relationship between filtered light and receiver material.
- [Stéphane Jacquemoud and Frédéric Baret, PROSPECT: A model of leaf optical properties spectra, Remote Sensing of Environment, 1990](https://doi.org/10.1016/0034-4257(90)90100-Z) for the physical distinction between leaf reflection and transmission. The exhibit uses representative RGB coefficients and does not fit a species-specific spectral model.
- [IUPAC Gold Book, Beer–Lambert law](https://goldbook.iupac.org/terms/view/B00626/plain) for multiplying segment transmittance.
- [Margo Engine shadows, public pin 0efd9cff8230507a32deb49907ecd499d46925f5](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/shadows/README.md) for the PCSS and colored caster APIs and their bounds.

## Verification

Include this slug in the gallery’s conditional compatibility preload set. Run `node qa-output/the-shadow-lab/check.mjs` from the gallery with its expected `MARGO_ENGINE_CHECKOUT` set. It captures the real trusted slider input after a completed frame, compares point-size and soft PCSS frames, neutralizes glass, and substitutes opaque leaf geometry. The mobile profile uses a cold cache, 390 CSS pixels, 150 ms network latency, 1.6 Mbps download and 4× CPU throttling. The same script accepts `SHADOW_LAB_URL` for hosted readback. `python qa-output/the-shadow-lab/measure.py` compares the actual raster in the three grounds of interest using projected floor coordinates.
