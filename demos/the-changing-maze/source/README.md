# The Changing Maze

Exhibit 169 of the Margo Web Demos brief. Two walls slide independently along a physical tabletop fixture. The brass shuttle follows the route through all four combinations. Slide a wall, inspect the highlighted tiles, then dispatch the shuttle. The navmesh overlay shows the engine’s current walkable polygon boundaries.

## How the exhibit works

The complete plate is 2.48 m wide and 1.60 m deep in engine units. The stock Margo TiledNavMesh builds from the actual level floor and box footprints of the fixed partitions. The copper and jade walls each hold a persistent obstacle ID. Up to five samples along each wall's 0.392 m slide update that ID with moveObstacle. A frame rebuilds up to three queued tiles through TiledNavMesh.update. The route refreshes when the queue drains. The puck pauses during this transition and continues from its current location after a successful replan. The gate controls hold a wall in place while the puck occupies its swept track.

Tiles have 16 × 16 cells at 20 mm per cell. The walkable radius is two cells. Gold material highlights and narrow inlaid outlines show the identities of the changed stock tile meshes. The readout counts unique rebuilt tiles with walkable mesh on the plate during the most recent slide. A tile can rebuild again at a later sample within the same slide. The 40 displayed tiles fill the plate. The engine also maintains padded context tiles outside that rectangle.

The path, distance, navmesh overlay and arrival all derive from the same engine state. The overlay iterates each tile’s public mesh, whose polygon indices are local and dense. The authored shuttle travels kinematically along TiledNavMesh.route's funnel result. Dock returns it to the starting cradle. The initial route measures 2.9251 m. Moving the copper wall shortens it to 2.5185 m. The four start-to-finish layouts produce four different routes, each validated against the actual wall footprints.

## Art and renderer

The lacquered chassis, copper and jade partitions, beveled tile faces, mineral speckle inlays, turned brass dock fittings, and shuttle are original geometry built for this exhibit. The scene uses Margo core PBR with the same geometry, illumination and details on WebGPU and the stock WebGL2 fallback. WebGPU is attempted first. The URL option ?backend=webgl2 selects the fallback explicitly. The public engine pin is 0efd9cff8230507a32deb49907ecd499d46925f5.

## References

- Wouter van Toll, Atlas Cook IV and Roland Geraerts (2012), *A Navigation Mesh for Dynamic Environments*. Reference for retaining unaffected navigation data when an obstacle changes. [Original paper](https://webspace.science.uu.nl/~gerae101/pdf/CAVW_Dynamic_ECM.pdf)
- Mikko Mononen (2011), *Temporary Obstacle Progress*. Reference for local tile updates around changing obstacles. [Author’s technical notes](https://digestingduck.blogspot.com/2011/01/temporary-obstacle-progress.html)
- Jean Dunand (ca. 1930), *Sunrise/Sunset Screen*. Reference for lacquer and restrained warm metallic trim. [The Metropolitan Museum of Art](https://www.metmuseum.org/art/collection/search/495204)
- Smithsonian Institution Archives (1957), *Gems and Minerals Exhibit*. Reference for exhibition terrazzo surfaces and material transitions. [Smithsonian Institution](https://www.si.edu/object/gems-and-minerals-exhibit-national-museum-natural-history%3Asiris_sic_9363)

## Browser verification

The isolated QA harness serves production Vite output. It checks the finished copper slide, exact new route, and 10 unique rebuilt tiles after a trusted cold-start touch. It also exercises the polygon overlay after a rebuild, both walls, a reroute while the shuttle is travelling, exact arrival and restoration of the initial route. Mobile verification uses 390 × 844 CSS px at 2× DPR, 150 ms RTT, 1.6 Mbps downstream, and fourfold CPU slowdown in clean Chromium contexts. The desktop and phone frames are actual Margo canvas renders. This is workstation browser emulation.
