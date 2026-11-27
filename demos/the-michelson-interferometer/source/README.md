# The Michelson Interferometer

Move **Mirror travel** to translate the mirror on the bronze micrometer stage. **Zero** returns to the starting reference. **+½ fringe** advances the mirror by 158.2 nm, exchanging bright and dark bands at the detector. **Inspect fringes** shows the translucent imaging plate close up. The two readouts count the physical changes relative to zero.

## Optical model

The beam splitter sends the same 632.8 nm monochromatic source toward two perpendicular mirrors and recombines their returns at the detector. A mirror travel of Δd lengthens its outward and return path by the same amount, giving a net optical path change of 2Δd and 2Δd/λ periods at the detector. One full fringe passes a fixed point per 316.4 nm of travel.

Two coherent plane waves of equal polarization and nominally equal amplitude meet at the detector. The fixed mirror has a small static tilt, so the two wave vectors have a difference along the transverse screen coordinate *u*. With beam angle 2θ and wavelength λ, the carrier period *p* = λ/sin(2θ) is 26 mm. The chosen tilt angle is approximately 12.17 µrad. At the calibrated detector plane, normalized irradiance is `0.5 + 0.5 V cos(2π(u/p + 2Δd/λ))`. A Gaussian envelope models beam overlap. A fixed visibility *V* of 0.96 describes residual contrast loss.

The bright traces are schematic paths through the instrument. Their width is for visibility, and the display uses a warm color scale for irradiance. The physical translation and tilt are micrometric, while the visible micrometer index repeats as the mirror moves. The model omits source noise, diffraction, polarization mismatch, wavelength spread and coating-dependent changes to phase and amplitude. A constant phase offset is absorbed into the zero setting.

## References and provenance

- Robert Smith and Franz Konstantin Fuss, “Theoretical Analysis of Interferometer Wave Front Tilt and Fringe Radiant Flux on a Rectangular Photodetector,” *Sensors* 13(9), 2013, pp. 11861–11898. Figure 2 and Eqs. 2–7 show the returning wave vectors, doubled path change and fringe intensity. [Paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC3821293/)
- University of Colorado Boulder, PHYS 4430, *Michelson Interferometer & Precision Wavelength Measurement*, Week 1. HeNe bench layout, micrometer stage, ideal field and finite misalignment. [Physics Undergraduate Labs](https://physicslabs.colorado.edu/courses/phys-4430/lab-guides/michelson-interferometer/week-1/)
- MIT Center for Bits and Atoms, *Metrology: Measurements*, 2024. One fringe per half-wavelength of physical mirror displacement. [MIT](https://fab.cba.mit.edu/classes/865.24/topics/metrology/02_measurements.html)
- Albert A. Michelson and Edward W. Morley, “On the Relative Motion of the Earth and the Luminiferous Ether,” *American Journal of Science* 34(203), 1887. Original folded-path interferometer and fine mirror screw. [Paper scan](https://fnorio.com/0135Michelson_Morley_1887/Michelson_Morley_1887_E.pdf)

The platform, laser head, mirrors, cube splitter, micrometer and detector are original Margo Engine geometry and materials. Desktop and phone render the same scene. Native WebGPU is attempted first. Margo WebGL2 compatibility is loaded on demand or by appending `?backend=webgl2`.
