# The Path-Traced Glasshouse

Compare dispersive flint with a fixed-index prism on the same walnut optical bench. Both opening views are 1,536-sample, wavelet-denoised renders made with Margo's spectral path tracer. The camera, lighting, geometry, and all other materials are identical. The reference holds the prism at a refractive index of 1.68 across all wavelengths. The crown-glass optics retain their dispersion in both views. **Save PNG** downloads the displayed rendering.

On native WebGPU, the selected bench starts tracing in the background. The live canvas takes over when it reaches 39 samples per pixel and continues to refine. The material controls restart the live calculation through the same opening comparison. The full scene uses spectral transport, a thin camera lens, 19,216 optical triangles, and five analytic emitters for the visible white slits. A luminance clamp limits unusually bright paths.

**Ray study** is a separate, live Margo view of wavelength separation through the same prism footprint. It uses Snell's law at both prism faces and the two-term Cauchy dispersion model for ideal flint with $n_d=1.68$ and $V_d=24$ (`tracePolygon`, `cauchyFromAbbe` and `cauchyIndex` from `@margoengine/optics/refraction`). It shows seven wavelengths across 119.8 mm on a screen perpendicular to the reference ray, 1.43 m beyond the prism. With a constant index, the wavelengths follow one path. This planar transmission model covers the direct beam. The full bench renderer also resolves multiple bounces and focused light on surrounding objects.

WebGL2 browsers provide both path-traced comparison images, the live ray study, and PNG export. The pinned compatibility backend did not complete the full spectral bench pipeline within a 65-second phone test. Live tracing of the bench uses native WebGPU.

The film route retains its original framing and mesh emitters. To reproduce the web stills, use the bench capture route at time zero, 576 × 324, and 1,536 samples per pixel with wavelet denoising. Use `?capture=opening` for `assets/opening.png` and `?capture=opening&glass=fixed` for `assets/fixed.png`.

## References

- SCHOTT. *TIE-29 Refractive Index and Dispersion* (2023). [Technical information](https://media.schott.com/api/public/content/aaa572afd854434fb7b3faa4bc46103f?v=c0f4fa52).
- Bruce Walter, Stephen R. Marschner, Hong Song Li, and Kenneth E. Torrance. *Microfacet Models for Refraction through Rough Surfaces* (2007). [Research paper](https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.html).
- Thomas Müller, Markus Gross, and Jan Novák. *Practical Path Guiding for Efficient Light-Transport Simulation* (2017). [Research paper](https://studios.disneyresearch.com/wp-content/uploads/2019/03/Practical-Path-Guiding-for-Efficient-Light-Transport-Simulation.pdf).
- Toshiya Hachisuka, Shinji Ogaki, and Henrik Wann Jensen. *Progressive Photon Mapping* (2008). [Research paper](https://graphics.ucsd.edu/~henrik/papers/progressive_photon_mapping/).
