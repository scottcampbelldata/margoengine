# The Fresnel Lens

Move **Lamp distance** to slide the burner along its rail. The illuminated rays spread apart when the burner is close to the lens and move toward one another when it is farther away. **Set to focus** puts the burner at the 450 mm design position. **Look down on the beam** shows the paths from above. The beam angle reports the separation of the traced outer pair.

## Optical model

The lens has a flat rear face and ten concentric conical front facets around a flat center cell. The glass index is 1.49. Each facet has a 17.6 mm radial width, with its thickness decreasing radially outward to a 4.6 mm common substrate. Each conical slope was solved so the ray crossing the middle of that ring leaves parallel to the axis when the source is 450 mm from the entry face.

The exhibit traces selected meridional rays from the point emitter. Snell’s law at the planar entry face sets the internal direction. Each internal segment is intersected analytically with its conical facet. A second Snell refraction uses that facet’s outward normal. The dark receiver frame marks a fixed comparison plane 610 mm beyond the rear face. The beam guides show the sampled rays, so “Parallel” describes their angles at the design position. Facet edges, continuous-aperture aberrations, lamp size, dispersion, reflections and diffraction are outside this model.

## References and provenance

- Augustin-Jean Fresnel, “Memoir upon a New System of Lighthouse Illumination,” 1822, translated by T. Tag. Steps and copper support frames for lighthouse lenses, and placing the lamp at the focus for parallel rays. [U.S. Lighthouse Society](https://uslhs.org/sites/default/files/attached-files/Fresnel%27s%20Memoire%20-%20Translation.pdf)
- Smithsonian National Museum of American History, *Fresnel Lighthouse Lens*, third-order lens installed at Bolivar Point in 1907. [Collection object](https://americanhistory.si.edu/collections/object/nmah_844143)
- Peng Tian et al., “New Design Scheme for and Application of Fresnel Lens for Broadband Photonics Terahertz Communication,” *Sensors* 24(23), 2024, §2.2. Conical annular prisms, ring tilt and Snell’s law. [Paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC11644695/)
- Ian Powell, “Tracing finite rays through a Fresnel lens,” *Applied Optics* 22(18), 1983, pp. 2924–2926. Finite-ray tracing through a Fresnel surface. [Optica](https://opg.optica.org/ao/abstract.cfm?uri=ao-22-18-2924)

The marine-style brass lens cell, burner, graduated slide, and comparison frame were modeled for this exhibit. The stepped glass mesh and ray intersections use the same facet dimensions. Desktop and phone render the same Margo Engine scene. Native WebGPU opens first. Margo WebGL2 compatibility loads when native support is unavailable or when `?backend=webgl2` is appended.
