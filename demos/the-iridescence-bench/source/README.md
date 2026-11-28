# The Iridescence Bench

Change **Center film thickness** to deposit a thicker or thinner ideal film. The coating is slightly wedge-shaped, so its thickness varies across the reflector and unfolds into bands of different colors. **Reflector tilt** turns the whole specimen beneath the overhead light. **Coating close-up** shows the colored surface and the sample holder.

The model uses a single, lossless dielectric film with refractive index 2.32 over glass with index 1.52. It calculates s- and p-polarized Fresnel reflection at both interfaces. The optical round-trip phase is 4πn d cos(θfilm) / λ, with the internal angle given by Snell’s law. The average of the two polarizations gives unpolarized spectral reflectance. The calculation samples 380–740 nm in 4 nm steps under a 6504 K blackbody. An approximation to the CIE 1931 observer converts that spectrum to a white-normalized linear sRGB display color.

Each fine surface strip is colored with the spectral reflectance calculated at its center and the angle between its local normal and the overhead light. Margo renders these colors in the 3D scene with conventional PBR lighting. This is an appearance preview for a single ideal film. It omits dispersion, the back-surface reflection, scattering, exact specular viewing geometry, and real coatings' material variability.

The exhibit is built from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). Phone and desktop use the same artwork and renderer settings. WebGPU is preferred and Margo's WebGL2 compatibility layer handles unsupported browsers. Add `?backend=webgl2` to exercise that path directly.

## Research

- Steven J. Byrnes, *Multilayer optical calculations* (2016). Coherent thin-film reflectance at oblique incidence. [arXiv](https://arxiv.org/abs/1603.02720)
- Laurent Belcour and Pascal Barla, *A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence* (2017). Spectral interference for dielectric films on dielectric substrates. [Author's presentation](https://belcour.github.io/blog/slides/2017-brdf-thin-film/slides.html)
- Chris Wyman, Peter-Pike Sloan, and Peter Shirley, *Simple Analytic Approximations to the CIE XYZ Color Matching Functions* (2013). Analytic observer curves, Table 1. [Journal of Computer Graphics Techniques](https://jcgt.org/published/0002/02/01/)
- W3C, *CSS Color Module Level 4*. Linear-light sRGB primaries and the XYZ reference white. [W3C](https://www.w3.org/TR/css-color-4/#predefined-sRGB-linear)
- Grant T. England and colleagues, *The Optical Janus Effect: Asymmetric Structural Color Reflection Materials* (2017). Photographs and measured reflectance of titania-coated glass. [Harvard University](https://aizenberglab.seas.harvard.edu/sites/g/files/omnuum6296/files/aizenberg/files/2017_england_etal_advmater.pdf)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening studio shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
