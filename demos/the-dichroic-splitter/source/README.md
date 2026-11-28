# The Dichroic Splitter

Use **Incidence angle** to turn the coated plate relative to the incoming white beam. The receiver on the curved rail follows the reflected ray. The fixed receiver catches transmitted light on the original axis. **Trace the paths** gives a view from above.

The ideal coating is eight pairs of lossless dielectric layers with indices 2.20 and 1.47 on glass of index 1.52. Each layer is one optical quarter-wave thick at 526 nm at normal incidence. The characteristic matrix calculation follows Snell’s law and evaluates s and p polarization independently, then averages them for unpolarized light (`multilayerReflectance` from `@margoengine/optics/interference`; colours from its `SpectralIntegrator`). The model treats the substrate back as perfectly antireflection coated and accounts for every wavelength as R + T = 1.

Reflection and transmission are integrated at 91 wavelengths from 380 to 740 nm for a 6504 K blackbody. The percentages are photopic fractions of the incident visible brightness. The CIE 1931 observer approximation yields display colors, white-normalized to linear sRGB. The reflected receiver moves by twice the plate’s rotation. Beam width and the coating’s visible edge tint are display cues. The model omits walk-off through the plate, absorption, material dispersion, and production coating tolerances.

Margo renders the instrument, glass preview, beam guides, and receiver marks. Desktop and phone use the same art and settings. The verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5) supplies all renderer packages. The preferred backend is native WebGPU. WebGL2 compatibility is available automatically and with `?backend=webgl2`.

## Research

- Steven J. Byrnes, *Multilayer optical calculations* (2016). Thin-film transfer matrices, oblique incidence, and energy normalization. [arXiv](https://arxiv.org/abs/1603.02720)
- Daniel Obeid, *The Importance of Optical Filter Orientation, Angle of Incidence, and Cone Half Angle*. Angle-dependent spectral shifts illustrated for real coatings. [Edmund Optics](https://www.edmundoptics.com/knowledge-center/application-notes/optics/optical-filter-orientation)
- Edmund Optics, *Dichroic Shortpass Filters*. Optomechanical reference for the 45° splitter and separated optical paths. [Edmund Optics](https://www.edmundoptics.com/f/dichroic-shortpass-filters/14198/)
- Chris Wyman, Peter-Pike Sloan, and Peter Shirley, *Simple Analytic Approximations to the CIE XYZ Color Matching Functions* (2013). Numerical observer fitting parameters, Table 1. [Journal of Computer Graphics Techniques](https://jcgt.org/published/0002/02/01/)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening directional shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
