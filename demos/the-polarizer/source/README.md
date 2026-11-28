# The Polarizer

Choose either filter and move the angle slider with touch, a pointer, or arrow keys. **Parallel**, **45°**, and **Crossed** compare full, half, and zero transmission at the angle between the two rings. **Optics close-up** moves the camera in on the brass polarizer, blue analyzer, and the circular detector. An amber lamp ring lights on the filter the slider turns, and each ring carries one index pointer at its top, so 0° and 180° read as different settings of the mount even though a linear polarizer passes the same light at both.

The first ideal linear polarizer passes one axis of the source's electric field. The analyzer transmits the component of that field along its own axis. Because intensity is proportional to field amplitude squared, the relative detector intensity is I/I₀ = cos² θ. Here I₀ is the detector's value with both filters aligned. The result is 100% at 0° and 180°, 50% at 45° and 135°, and zero at 90°.

The diffuser's reticle, five meter lamps, and spill light display the calculated intensity. The optical model assumes ideal filters, so there is no residual light leakage or wavelength dependence at extinction. The scene displays Malus’s law analytically instead of tracing electromagnetic waves through the meshes.

All artwork is rendered in Margo Engine. WebGPU is preferred, with Margo's WebGL2 compatibility layer used if WebGPU is unavailable. Phone and desktop use the same artwork and scene settings. Add `?backend=webgl2` to check that path directly. The gallery builds from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## References

- OpenStax, *College Physics*, “Polarization” (2012). Field projection and Malus’s law. [OpenStax](https://openstax.org/books/college-physics/pages/27-8-polarization)
- Natalia Krasnopolskaia, *PHY385 Module 9 Student Guide* (2014). Two polarizers, a mounted light source, and a calibrated detector on a real optical bench. [University of Toronto](https://www.physics.utoronto.ca/~phy385h1f/mod9.htm)
- Martín Monteiro, Cecilia Stari, Cecilia Cabeza, and Arturo C. Marti, *The polarization of light and the Malus’ law using smartphones* (2016). Experimental verification of angular transmission. [arXiv](https://arxiv.org/abs/1607.02659)
- Edmund Optics, *Polarizer Selection Guide*. Parallel and crossed transmission and the nonzero extinction floor in real filters. [Edmund Optics](https://www.edmundoptics.com/knowledge-center/application-notes/optics/polarizer-selection-guide)
- Edmund Optics, *Metric Polarizer Mounts*. Machined housings, mounting posts, rotation controls, and engraved angular scales. [Edmund Optics](https://www.edmundoptics.com/f/metric-polarizer-mounts/11785/)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening directional shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
