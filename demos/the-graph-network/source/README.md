# The Graph Network

The Outer Straits are an invented archipelago with 398 ports and 676 bidirectional routes. Eight colors distinguish its island groups. Larger dots are the island hubs, and gold lines are the 13 routes between hubs. The line geometry represents connections and the force layout uses graph units.

Tap any port to inspect its connections. The chart draws every one of its direct ferries in gold and lists the reachable ports. The port selector and route list offer keyboard access to the same inspection. The two-ferry count is the number of ports whose shortest route requires exactly two crossings.

## Data and engine

- The exhibit generates its own named ports and undirected routes from a fixed seed. Each island connects its nearby ports, and authored routes join the island hubs. There are no external data or art assets.
- The opening chart contains two passes from the public `@margoengine/sciviz/graph-gpu` Fruchterman–Reingold compute layout. `opening.mjs` stores the resulting two-dimensional coordinates in little-endian signed 16-bit form at 3,200 samples per graph unit. The maximum packing error in the captured coordinates was 0.000157 graph units.
- **Run layout** advances the same device graph by eight passes. Connected ports attract and all ports repel. The eight hubs remain fixed, and inter-island routes exert a weaker layout force than local ones. Route weights affect the layout only. The progressively cooled movement and fixed anchors keep the chart recognizable across multiple passes.
- The colored graph draws directly from the current Margo compute buffer. A small lit marker inside each port gives Margo SciViz's GPU ID picker its exact position at the last completed iteration. The first tap uses the actual picker. The two-ferry check runs the device-backed `@margoengine/compute/graph` breadth-first search against the same connectivity used to draw the graph. Direct connections remain available while the search completes.
- The native renderer starts with WebGPU. On WebGL2 an early Margo FrameGraph pass draws all 398 ports and 676 routes with the same layout, sizes, color palette and highlights. Its one-pixel GPU ID pass picks the nearest node within nine CSS pixels. After the first selection or a short idle interval, the official compatibility layer loads the full SciViz graph in a second canvas. The finished graph inherits the current selection and takes over after its frame and GPU picker are ready. The transferred chart may have small antialiasing differences.
- Add `?backend=webgl2` to test the fallback. The initial chart and port inspector keep working if the browser can draw the chart but cannot run the full live layout. The graphics requirements link appears in that case.

## Sources

- Khronos Group. [WebGL 2.0 Specification](https://registry.khronos.org/webgl/specs/latest/2.0/). GPU framebuffers, fragment depth testing and one-pixel RGBA readback.
- Barry Pollard and the Chrome team. [Understand the critical path](https://web.dev/learn/performance/understanding-the-critical-path). The packaged opening keeps the fully translated compatibility path out of the first pick.

- T. M. J. Fruchterman and E. M. Reingold, 1991. [Graph Drawing by Force-directed Placement](https://doi.org/10.1002/spe.4380211102).
- M. Jacomy, T. Venturini, S. Heymann and M. Bastian, 2014. [ForceAtlas2, a Continuous Graph Layout Algorithm for Handy Network Visualization Designed for the Gephi Software](https://doi.org/10.1371/journal.pone.0098679). Compared during research. The exhibit uses Fruchterman–Reingold on both renderers.
- U.S. Coast Survey, 1866. [Washington Sound and approaches, Washington Territory](https://content.libraries.wsu.edu/digital/collection/maps/id/428). Reference for the chart border, sparse edges and compact chart legend. The graphic is original.
- NOAA, National Geospatial-Intelligence Agency and International Hydrographic Organization. [U.S. Chart No. 1](https://nauticalcharts.noaa.gov/publications/us-chart-1.html). Reference for the visual hierarchy of chart marks.

Engine packages are built from [the public Margo pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).
