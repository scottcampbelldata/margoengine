# The Biome Map

Exhibit 117 is a live relief atlas of an original fictional continent. Move **Sea-level temperature** or **Baseline annual rainfall** to watch four biome bands move across the same land. The map and the percentages update together. Turn up the rain to compare the wet windward coast to the dry basin downwind. Cool the air and watch tundra extend from the summits.

The sliders set an annual temperature at sea level and annual rainfall before terrain effects. The actual sample map varies with elevation, slope aspect, shelter, coast, and prevailing wind. The map illustrates equilibrium cover for the two baseline settings. It depicts a schematic continent using a 20.48 × 17.41 km regional model domain, with exaggerated displayed relief.

## Method

The initial relief is an authored, continuous field of coastal shelves, irregular shorelines, uplands and a central ridge. Margo's `heightfieldGeometry` builds the actual terrain surface. Bathymetry, contours and slope shading are drawn with a Margo material. A seeded set of candidates from Margo Scatter uses the interpolated forest weight to thin the symbolic canopy as climate changes.

The worker uses Margo `BiomeWorld`, the public temperate, savanna, tundra and desert preset definitions, and Margo's `multiNoise` classifier. The classifier compares mean temperature and annual rainfall against in-exhibit ranges for temperate forest, grassland, tundra and desert. Margo blends overlapping ecotones. The colored areas and their reported shares are the same weighted classification. The source stores a raster of the four weights, samples only cells above sea level for the readout, and computes each share as the total class weight divided by the number of land cells.

Incoming air travels mostly west to east. The Margo climate model uses a 6 °C per kilometre lapse rate and a simplified rain-shadow term, alongside its other regional fields. Local mapped rain can differ considerably from the baseline. The model has four cover groups and a fixed landscape. It is an educational illustration of climate envelopes with transitions between classes.

## Verification

In the showcase checkout set `MARGO_ENGINE_CHECKOUT` to the pinned public Margo Engine build and run `node qa-output/the-biome-map/check.mjs`. Set `BIOME_MAP_URL` for a hosted run. The browser audit changes temperature by trusted tap and measures through GPU queue completion. It verifies the temperature and rainfall extremes, land shares, actual differing canvas pixels, and restored climate reproducibility. It captures default, warm, dry, wet and cold renders on desktop and phone. Phone emulation uses 390 × 844, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU slowdown. All renderer modes share the same 3D surface, canopy and CPU classification.

## References

- I. C. Prentice, W. Cramer, S. P. Harrison, R. Leemans, R. A. Monserud, and A. M. Solomon (1992). *A Global Biome Model Based on Plant Physiology and Dominance, Soil Properties and Climate*. [Journal of Biogeography](https://doi.org/10.2307/2845499)
- Leslie R. Holdridge (1947). *Determination of World Plant Formations from Simple Climatic Data*. [Science](https://doi.org/10.1126/science.105.2727.367)
- Justin R. Minder, Philip W. Mote, and Jessica D. Lundquist (2010). *Surface Temperature Lapse Rates over Complex Terrain: Lessons from the Cascade Mountains*. [Journal of Geophysical Research](https://doi.org/10.1029/2009JD013493)
- Ronald B. Smith and Idar Barstad (2004). *A Linear Theory of Orographic Precipitation*. [Journal of the Atmospheric Sciences](https://journals.ametsoc.org/view/journals/atsc/61/12/1520-0469_2004_061_1377_altoop_2.0.co_2.xml)
- Eduard Imhof (1945). *Kanton Aargau*. The oblique relief lighting, contrast and use of line work inform the original atlas. [ETH Zürich Shaded Relief Archive](https://ikgrelief.ethz.ch/cartographers/imhof/)
- Margo Engine public source pinned to `0efd9cff8230507a32deb49907ecd499d46925f5`. [Biomes and ecotones](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/biomes/docs/biomes-and-painting.md)
