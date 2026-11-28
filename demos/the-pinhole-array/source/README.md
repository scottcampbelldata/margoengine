# The Pinhole Array

Move **Aperture scale** to change three circular apertures together. The magnified screens show the same five-point target after each aperture. Two pairs of nearby dots make the resolution difference visible. Press **Inspect images** for a straight-on view of all three displays. The instrument also reports the diameter containing 80% of the irradiance from a point for each pinhole, in the sensor plane.

## Model

The target is 880 mm from each thin, circular aperture. Each sensor is 280 mm behind it. The three diameters at 100% are 0.31 mm, 0.60 mm and 1.32 mm. The image point is the target coordinate times −280/880, which inverts both axes. Each source point is monochromatic at 532 nm and independent of the others, so their irradiances add. The instrument shows the simulated sensor regions magnified on three pitched displays.

For aperture radius *a*, wavelength *λ*, object distance *p* and sensor distance *q*, let *N* = *a²*(1/*p* + 1/*q*)/*λ*. The radial amplitude, apart from a constant phase, is the integral over the unit pupil of 2ρ × exp(iπ*N*ρ²) × J₀(2π*ar*ρ/(*λq*)). The implementation integrates the real and imaginary components by Simpson quadrature after numerical angular integration of J₀. The irradiance is the squared magnitude multiplied by (π*a²*/(*λq*))². The geometric limit and the spreading from narrow apertures come from the same Fresnel calculation. The 80%-energy diameter comes from integrating the irradiance radially against the aperture’s incident flux.

The point images are peak-equalized for comparison. Their panel brightness does not compare aperture transmission. Diffraction uses a paraxial, scalar model, an ideal zero-thickness hole and monochromatic incoherent emitters. It omits sensor noise, pixel response, edge roughness, reflections and wavelength spread.

## References and provenance

- Klaus D. Mielenz, “On the Diffraction Limit for Lensless Imaging,” *Journal of Research of the National Institute of Standards and Technology* 104(5), 1999, pp. 479–485. Circular apertures, Fresnel number, geometric inversion and flux widths. [NIST](https://pmc.ncbi.nlm.nih.gov/articles/PMC4878863/)
- *NIST Digital Library of Mathematical Functions*, §10.9.1. Angular integral representation of J₀. [DLMF](https://dlmf.nist.gov/10.9.E1)
- Thorlabs, *High-Power Mounted Pinholes*, catalogue section. Precision aperture cell construction and retaining hardware. [Thorlabs](https://www.thorlabs.com/catalogPages/204.pdf)

The cast housing, instrument surrounds, three aperture bodies, target marks and phosphor displays were modeled for this exhibit. A procedurally computed 256-sample radial texture feeds the Margo material on all three displays. The same geometry, materials, lights and calculation are used on desktop and phone. The application starts with native WebGPU and loads the Margo WebGL2 compatibility backend when native WebGPU is unavailable. Append `?backend=webgl2` to select compatibility directly.
