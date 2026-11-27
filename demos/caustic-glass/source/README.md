# Caustic Glass

A collimator shines through a hand-faceted flint-glass lens onto a graduated slate receiver. Switch between **Polished**, **Ground**, and **Dispersive** to compare the same 3D instrument and aperture. The calibration marks, stand, lens, and workshop enclosure are original scene assets in metres.

## What is measured

The pinned public Margo Engine’s `@margoengine/lightmap/refracted` traces 196,608 photons per treatment through the same closed 120-triangle convex lens that the exhibit draws. The rectangular collimator is 127 × 315 mm and delivers parallel rays normal to the slate. The ground profile uses selected anisotropic GGX roughness values of 0.32 and 0.21 with Smith multiple scattering. The spectral profile samples 380–780 nm and fits the dispersion to the published N-SF10 reference index 1.72828 and Abbe number 28.53. The polished profile uses one index across the modeled visible spectrum.

The receiver reports the mean RGB share of emitted power deposited after glass and the irradiance-weighted root-mean-square distance from its center of energy. The polished, ground, and dispersive profiles collect 78.4%, 68.9%, and 77.5% respectively. Their footprint spreads are 8.8 cm, 12.4 cm, and 9.0 cm. These are outputs of this illustrated apparatus. Aperture illumination is uniform by design. Surface finishes, absorption and room reflections are exhibit settings. The three bakes close the solver’s normalized RGB power account within 7 × 10⁻¹³.

## Rendering and rebuilding

The opening 3D bench uses the core renderer and a compact Margo frame-graph material. It draws the exact lens triangles, a quick dielectric surface preview, and the complete selected baked irradiance at its world position. The receiver scales the irradiance by slate reflectance divided by π. The scene then activates Margo Materials screen-space transmission with HDR capture and the official Lambertian light-map response. The glass treatment remains selected through that upgrade. The same scene assets, material routes, and composition rules run on WebGPU and Margo’s WebGL2 compatibility renderer. The visual glass shader approximates the view through the lens. The baked pattern comes from full convex-boundary photon transport.

The bundled lossless PNG maps and diagnostics use the same solver, seed, 210 × 199 transport grid, and deterministic reconstruction. The maps store a standard sRGB encoding of normalized irradiance. The renderer decodes them to linear and scales them by 24. Select **Rebake light** to trace the selected treatment afresh in a browser worker. The instrument keeps displaying the current bake during the calculation. Cancel with the same button or choose another treatment. Rebuild the packaged maps by running `node build-bakes.mjs` with `MARGO_ENGINE_CHECKOUT` set to the public pin below.

## References

- Henrik Wann Jensen, [Rendering Caustics on Non-Lambertian Surfaces](https://cseweb.ucsd.edu/~henrik/papers/rendering_caustics/), 1996. Photon-based caustic transport.
- Bruce Walter, Stephen R. Marschner, Hongsong Li and Kenneth E. Torrance, [Microfacet Models for Refraction through Rough Surfaces](https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.html), 2007. Refraction of rough glass.
- Eric Heitz, Johannes Hanika, Eugene d’Eon and Carsten Dachsbacher, [Multiple-Scattering Microfacet BSDFs with the Smith Model](https://publikationen.bibliothek.kit.edu/en/1000058892), 2016. Microsurface scattering in the bake.
- SCHOTT Advanced Optics, [N-SF10 optical glass data](https://us.shop.schott.com/advanced-optics/en/Optical-Glass/N-SF10/c/glass-N-SF10). Reference index and Abbe number.
- Deutsches Museum, [Glass and the Fraunhofer prism](https://www.deutsches-museum.de/en/museum-island/exhibitions/classical-optics/tracing-fraunhofer/glass), and the [University of St Andrews historic optical bench](https://collections.st-andrews.ac.uk/item/part-of-optical-bench/1005431). Reference for the original exhibit’s optical tooling and experimental setup.
- [Margo Engine lightmap at the verified public pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/lightmap#caustics-margoenginelightmaprefracted) and [Margo Materials at the same pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/materials). The scene uses the published light-map and transmission APIs.
