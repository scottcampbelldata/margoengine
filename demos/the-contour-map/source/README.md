# The Contour Map

An interactive topographic plate from the USGS 3D Elevation Program bare-earth digital elevation model covering 15.2 km square at Mount St. Helens. The underlying imagery request returned a 256×256 raster at 59.375 m in WGS 84 / UTM zone 10N (EPSG:32610). This exhibit averages blocks of two by two to a 128×128 grid and rounds to 0.25 m. Its displayed summit and minimum describe this sampled grid. View Relief uses about 2.2× vertical exaggeration.

Three sets of contour paths were generated from the displayed grid by Margo's public contour2D package, using the asymptotic decider for ambiguous cells. The renderer colours the height bands on the actual terrain mesh. Place names and labelled paths are mapped to the same grid. Map picks bilinearly interpolate the nearest four samples.

- [3DEP bare-earth elevation service](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer), USGS National Map, public domain. Retrieved 2026-11-27. The exact request URI and SHA-256 are recorded in `assets/record.json`.
- Gregory M. Nielson and Bernd Hamann. [The Asymptotic Decider](https://doi.org/10.1109/VISUAL.1991.175782), IEEE Visualization, 1991.
