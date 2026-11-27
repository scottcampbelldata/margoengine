# Big Data Points

Explore a 4.3 × 3.6 km point-cloud crop of Kīlauea’s summit from the July 2019 USGS airborne lidar survey. **View angle** rotates the measured topography. **Coarse**, **Survey**, and **Full** set budgets of 5,500, 65,500, and 2,000,000 points. The counters distinguish the points rendered in the current frame from the points already loaded. Full streams the complete two-million-return crop.

## Survey data

The exhibit uses the public-domain USGS Entwine Point Tiles project **HI_Volcano_B1_2019**. The preparation program takes ground (LAS class 2) and unclassified (class 1) returns within the selected crop. It excludes the archived noise classes. Horizontal coordinates are reprojected from EPSG:3857 to WGS 84 / UTM zone 5N (EPSG:32605). Original tile elevations remain in metres. All coordinates in the exhibit are rounded to 0.1 m and coordinate duplicates at that precision are removed. The display preserves vertical scale and colors the 517.8–1,256.7 m selected elevation range. Directional shading on the points comes from the local terrain slope estimated on a smoothed 8 m ground-return grid. It is a display style derived from the survey.

The fixed sample contains 2,000,000 distinct source returns, including 432,974 ground-classified returns. The first tile is a geographically spaced sample. All later tiles add disjoint recorded returns. The two million points occupy 167 additive octree tiles with a combined packed size of 6,977,296 bytes.

The exact archive paths and source hashes are in `tools/source.json`. Retrieve the recorded LAZ nodes from the same project’s ept-data directory. The Python preparation program uses laspy, lazrs, NumPy, SciPy, and pyproj. Run from the exhibit source folder once that folder of inputs is available.

    python tools/prepare.py /path/to/original/laz

## Rendering and verification

The gallery uses verified public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Margo Points `OctreeCloud` schedules smaller tiles under the active point budget and sizes accumulated samples as the cloud refines. `PointsPlugin` draws the measured returns. The optional Sciviz colormap supplies the elevation transfer function. The same geometry, point budgets, color and vertical units run on WebGPU first and Margo’s full WebGL2 compatibility renderer. Both renderers start with the same actual measured 5,500-point seed.

The browser proof in `qa-output/big-data-points/check.mjs` sends a trusted orbit touch, reads point and node counters, switches all three budgets, and compares rendered screenshots. The mobile profiles use a 390 px viewport, 150 ms latency, 1.6 Mbps, and fourfold CPU slowdown. The detached data proof in the same folder decodes each packed tile, verifies its hash and octant bounds, and independently checks the full set of quantized points against the archived original LAZ returns.

The final package completed the first trusted mobile orbit at 1.279 s on WebGPU, 1.898 s on automatic WebGL2 and 2.125 s on forced WebGL2. Desktop measured 0.338 s native and 0.165 s forced. The full-stream pass rendered all 2,000,000 points and all 167 tiles in each of the five profiles. The final asset-loading adjustment moved small detail tiles out of the first JavaScript request. A second five-profile run repeated the cold controls and verified both full desktop paths with that packaging.

## References

- Adam Mosbrucker, Michael H. Zoeller and David W. Ramsey, 2020. *Digital elevation model of Kīlauea Volcano, Hawaiʻi, based on July 2019 airborne lidar surveys*. The exhibit draws the archived survey returns, and the USGS data release describes the original survey. [USGS data release](https://doi.org/10.5066/P9F1ZU8O)
- U.S. Geological Survey. *USGS 3DEP LiDAR Point Clouds*. Archive terms, representation and public-domain license. [Registry of Open Data](https://registry.opendata.aws/usgs-lidar/) · [Exact EPT metadata](https://s3-us-west-2.amazonaws.com/usgs-lidar-public/HI_Volcano_B1_2019/ept.json)
- Markus Schütz, 2016. *Potree: Rendering Large Point Clouds in Web Browsers*. Background for additive spatial refinement and point budgets. [TU Wien research publication](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/)
