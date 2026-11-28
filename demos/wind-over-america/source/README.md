# Wind Over America

Explore eight daily wind fields from January 1–8, 2024. The date slider selects one complete NOAA field. Play steps through the same archive, and the highlighted flow moves downwind along each day's streamlines. The arrows point where the wind goes. The peak readout is the largest sampled speed in the displayed region, including the ocean.

The chart covers 132.5° W to 60° W and 20° N to 57.5° N, with 30 by 16 observations at 2.5° spacing. NOAA provides 24-hour mean U/V components in meters per second at the 0.995 sigma level, close to the surface. The display bilinearly samples each day's field. It does not estimate terrain-level gusts or interpolate between days. The animated highlights indicate direction and relative speed at an illustrative pace.

## Data and method

- NOAA Physical Sciences Laboratory, *NCEP/NCAR Reanalysis 1*. Open public daily fields, using the `uwnd.sig995.2024.nc` and `vwnd.sig995.2024.nc` surface files. [Dataset description and data access](https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html).
- Eugenia Kalnay, Masao Kanamitsu, Robert Kistler et al., *The NCEP/NCAR 40-Year Reanalysis Project*, Bulletin of the American Meteorological Society (1996). [Research paper](https://doi.org/10.1175/1520-0477%281996%29077%3C0437%3ATNYRP%3E2.0.CO%3B2).
- The shorelines and lakes come from Natural Earth public-domain 1:50m physical vectors. The state borders come from the U.S. Census Bureau's 2024 1:20m Cartographic Boundary shapefile. [Natural Earth physical vectors](https://www.naturalearthdata.com/downloads/50m-physical-vectors/), [license](https://www.naturalearthdata.com/about/terms-of-use/), [Census cartographic boundaries](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html).
- John P. Snyder, *Map Projections: A Working Manual*, USGS Professional Paper 1395 (1987). Chart coordinates use the equidistant cylindrical projection with a 38.75° N standard parallel. The eastward component is converted at each latitude for integration. Color and readout use the unprojected speed. [USGS reference](https://doi.org/10.3133/pp1395).
- Bruno Jobard and Wilfrid Lefer, *Unsteady Flow Visualization by Animating Evenly-Spaced Streamlines*, Computer Graphics Forum (2001). The exhibit uses animated highlights to show direction along static daily streamlines. Margo Sciviz supplies the bilinear sampler, adaptive RK4 streamline integration, arrow geometry and timeline. [Research paper](https://doi.org/10.1111/1467-8659.00395).

Margo Engine draws the chart table from `@margoengine/geometry/parts` shapes, and the atlas sheet with a `@margoengine/materials` texture. The wind strokes and arrows are `flowInk` strokes from `@margoengine/sciviz/flow-ink`, drawn by Margo Lines: each streamline is coloured by speed and carries highlights that travel downwind, faster where the wind is stronger. The eight Margo Sciviz fields are prepared in a worker so the date slider can update without integrating a new field on the browser's main thread. Margo Labels anchors city and ocean names to the chart. WebGPU and WebGL2 use the same map, geometry, palette and labels. Reduced-motion settings keep the streamlines still when the date is held.

## Reproduction

Retrieve the two NOAA DAP ASCII subsets under the filenames `u.uwnd` and `v.vwnd`:

- [U field, eight days](https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface/uwnd.sig995.2024.nc.ascii?uwnd%5B0:1:7%5D%5B13:1:28%5D%5B91:1:120%5D,time%5B0:1:7%5D,lat%5B13:1:28%5D,lon%5B91:1:120%5D)
- [V field, eight days](https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface/vwnd.sig995.2024.nc.ascii?vwnd%5B0:1:7%5D%5B13:1:28%5D%5B91:1:120%5D,time%5B0:1:7%5D,lat%5B13:1:28%5D,lon%5B91:1:120%5D)

Put the archives `land.zip`, `lakes.zip` and `map.zip` in the same directory. The exact URLs and recorded SHA-256 hashes are in `assets/provenance.json`. Run `python tools/prepare.py PATH_TO_SOURCES assets` with Pillow installed. The tool validates dimensions, date stamps, coordinate order and source wind precision before storing both components in 0.025 m/s increments.

