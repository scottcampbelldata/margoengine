# The Schlieren Bench

Move **Knife-edge cutoff** to change how much undeflected light the blade blocks. The moving light and dark parts of the image reveal the projected horizontal gradients above the ceramic heater. **Withdraw blade** passes the entire modeled slit image and the contrast disappears. **Inspect the plume** gives a closer look at the field. Reduced-motion mode holds the initial thermal field for inspection.

## Optical and thermal models

The two concave mirrors form a compact U-shaped schlieren arrangement. The first mirror collimates the source, and the second focuses the light onto the vertical blade. The folded-path guides mark the chief ray and the collimated field. The 3D display shows a synthetic image of that field. Its palette maps irradiance to cool gray and does not measure temperature.

The analytical thermal field uses three cylindrical Gaussian components above a heater. Each broadens with height, decays in amplitude and wanders according to a periodic centerline. The sum is positive and bounded by 50 K above 293.15 K ambient. This is a prescribed plume shape without a fluid simulation or a claim about natural convection rates.

Using the ideal gas law at constant pressure and the Gladstone–Dale law, the model linearizes the refractive-index difference as `−(n₀−1) ΔT/T₀`, with `n₀=1.000273`. The small-angle deflection is the transverse derivative of the line-integrated index difference divided by `n₀`. Integrating each Gaussian along the optical axis first makes the derivative analytical. The 458 mm focusing mirror maps that deflection to a slit-image shift. For a 47 µm uniformly illuminated slit image and blade fraction `c`, transmission is `clamp(1 − c + f α/w, 0, 1)`. The withdrawn position lies outside the full modeled shift. The actuator includes an enlarged blade inspection mechanism so the micrometer-scale adjustment remains visible in the overview.

The ideal model omits off-axis aberrations, diffraction, sensor noise, beam walk-off, pressure variation and the intensity redistribution behind a fully open knife-edge plane. These limits distinguish the ideal schlieren signal from shadowgraphy or a quantitative thermal measurement.

## References and provenance

- Amayu W. Gena, Conrad Voelker and Gary S. Settles, “Qualitative and quantitative schlieren optical measurement of the human thermal plume,” *Indoor Air* 30(4), 2020, pp. 757–766. Line-integrated deflection, vertical knife edge and constant-pressure density. [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/ina.12674)
- Emilia Georgiana Prisăcariu, Raluca Andreea Roșu and Valeriu Drăgan, “Fringes, Flows, and Fractures—A Schlieren Study of Fluid and Optical Discontinuities,” *Fluids* 10(9), 2025, §1.2. U-type optical layout and cutoff behavior. [Journal](https://www.mdpi.com/2311-5521/10/9/243)
- E. Traldi, M. Boselli, E. Simoncelli et al., “Schlieren imaging: a powerful tool for atmospheric plasma diagnostic,” *EPJ Techniques and Instrumentation* 5, 2018. The knife edge blocks light deflected toward it and transmits light deflected away. [Journal](https://link.springer.com/article/10.1140/epjti/s40485-018-0045-1)
- Vision Research and RMIT, *Schlieren Imaging*, Fig. 2. Thermal plume image reference. [White paper](https://www.phantomhighspeed.com/-/media/project/ameteksxa/visionresearch/documents/whitepapers/english/web/wwpschlieren.ashx?la=de-de&revision=)

The mirror cells, instrument frame, heater, blade stage and detector were modeled for this exhibit. Margo Engine renders the same artwork and physical field on desktop and mobile. It attempts native WebGPU first. Margo WebGL2 compatibility loads on demand or with `?backend=webgl2`.
