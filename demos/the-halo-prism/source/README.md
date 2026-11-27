# The Halo Prism

Move **Incidence angle** to aim the light through a hexagonal ice crystal. The amber guide traces both refractions and the cyan marker follows that selected ray’s angular distance from the Sun in the sky view. **Find the minimum** sets equal angles at entry and exit. **Trace prism** views the path from above, and **Inspect halo** moves the camera closer to the 66° field.

## Model

The crystal is a regular hexagonal prism. The two chosen side faces form a 60° refracting wedge. For incidence *i*, the first Snell angle is `r = asin(sin(i)/n)`, the second internal angle is `60° − r`, and the deviation is `i + asin(n sin(60° − r)) − 60°`. At `r = 30°`, the ray passes symmetrically through the prism and reaches its minimum deviation. With *n* = 1.3110 at 550 nm, the angular radius is 21.92°. The displayed ray follows the actual entry and exit intersections on the modeled crystal.

For the halo field, the model samples this same ray family over incidence angles from 15° to 89.8°. It distributes the scattering planes uniformly in azimuth, weighs each incidence by the projected width of the entrance that reaches the chosen exit face, applies unpolarized Fresnel transmission, and divides by the spherical annulus factor `sin(δ)`. The rendered radial histogram uses 650, 550 and 450 nm at the tabulated real ice indices 1.3080, 1.3110 and 1.3157. A 0.19° Gaussian smooths the display. Shorter wavelengths have a slightly larger minimum angle, leaving a redder inner edge.

The halo is a normalized view of a conditional ray family through one side-face pair. It uses equatorial ray paths, equal incidence sampling before weights, and uniform azimuth. It omits other three-dimensional crystal orientations, rough or hollow ice, multiple scattering, polarization evolution, and cloud optical depth. The setting is a simulated sky instrument. The slider moves one marked sample ray, while the distribution in the halo view remains fixed.

## References and provenance

- Stephen G. Warren and Richard E. Brandt, “Optical constants of ice from the ultraviolet to the microwave: A revised compilation,” *JGR Atmospheres* 113, 2008. Real index values for hexagonal ice at 266 K. [Optical constants table](https://atmos.uw.edu/ice_optical_constants/IOPtable_2008.pdf)
- Linda Forster and Bernhard Mayer, “Ice crystal characterization in cirrus clouds III: retrieval of ice crystal shape and roughness from observations of halo displays,” *Atmospheric Chemistry and Physics* 22, 2022. Observed angular radius, random orientations and calibrated halo imagery. [Paper](https://acp.copernicus.org/articles/22/15179/2022/)
- J. M. Dudley, “Summer Halos in New Zealand,” *Australian Physics*, 1997. Minimum-deviation relation, the clustering of refracted rays and observed hue ordering. [Paper and observations](https://members.femto-st.fr/john-dudley/sites/members.john-dudley/files/content/1997-aust_phys_halos.pdf)

The alpine setting, observation equipment, ice crystal, ray guides and computational sky field are original Margo Engine geometry and materials. Native WebGPU starts first. Margo WebGL2 compatibility loads on demand or with `?backend=webgl2`. Desktop and phone render the same prism, sky and physical model.
