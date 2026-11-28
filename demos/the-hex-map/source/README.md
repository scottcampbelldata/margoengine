# The Hex Map

A three-dimensional survey chart with a plaster ridge, mounted landmarks and a miniature survey marker. The original terrain, pigments, coast, path and moving marker are all rendered by Margo Engine. The phone and desktop show the same chart and terrain.

- Set course for **West Beacon** or **Observatory**, or tap a land hex to select a custom destination. The marker follows the cheapest route over shared hex edges. The trail, meadow and woods cost 1, 2 and 3 respectively to enter. Water and ridges are impassable. Route finding uses the entire topographic chart.
- Visibility is recomputed at every occupied cell. Ridges block a line through them, and the nearest ridge cell on that line can be seen. Sight goes up to three hexes. Fully colored tiles are in sight, muted tiles were surveyed earlier, and dark tiles show the unsurveyed chart relief.
- The pinned `@margoengine/tilemap/hex` supplies the regular hex centers and polygons, hit-test coordinates, distances and line cells. `@margoengine/tilemap/path` supplies weighted A*. At the verified pin `0efd9cff8230507a32deb49907ecd499d46925f5`, the package's stand-alone square-octant FOV rejects hexagonal maps. The exhibit uses the stock hex-line primitive to apply center-to-center occlusion and stores the survey memory locally. Exact-edge ties follow the package's hex-line convention.
- **Reset survey** returns the marker to the harbor and clears surveyed memory. The WebGL2 preview backend renders the same scene where WebGPU is unavailable or when explicitly requested through `?backend=webgl2`.

## References

- Peter E. Hart, Nils J. Nilsson and Bertram Raphael. *A Formal Basis for the Heuristic Determination of Minimum Cost Paths* (1968). Weighted graph search and admissible estimates. [Author's Stanford publication copy](https://ai.stanford.edu/~nilsson/OnlinePubs-Nils/PublishedPapers/astar.pdf)
- Amit J. Patel. *Hexagonal Grids* (2013). Offset and cube coordinates, neighbor topology, distance, line rasterization. [Author's reference](https://www.redblobgames.com/grids/hexagons/)
- Clark Verbrugge. *Computing Field of View on a Hexagonal Grid* (1997). Reference for comparison with angular field of view. This exhibit uses the center-line rule described above. [Author's documentation](https://www.sable.mcgill.ca/~clump/Hex/HGAT.html)
- ETH Zurich Institute of Cartography and Geoinformation. *Swiss Reliefs* (2022). Reference for the character of hand-modeled plaster reliefs and painted terrain displays. [Institutional visual reference](https://terrainmodels.ethz.ch/history/swiss-reliefs/)
