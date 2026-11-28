# Drone Volume

Send three miniature inspection drones through the Seed Conservatory. Pick the **Upper canopy**, **Lower intake**, or **Launch bay**, review the routes, and select **Send drones**. During a sortie, choose a different destination and use **Send again** to request a route from the current positions. **Side view** reveals the different flight heights. **Follow A** takes a close view of the first drone when the camera has a clear sightline.

## Navigation model

Margo Engine’s public <code>@margoengine/navmesh/volume</code> builds a three-dimensional sparse voxel octree from four closed, conservatively sized obstacle meshes. The search uses Lazy Theta* with any-angle line-of-sight shortcuts. The cell size is 0.24 m and the modeled drone radius is 0.29 m. Each route starts and ends at its own height and depth. The dashes and waypoint marks are 3D geometry on the solved centerline.

The opening sortie totals 31.85 m over all three aircraft, and drone A changes altitude by 3.37 m. Each direct station-to-station centerline intersects a modeled obstacle in that initial sortie. **Min clearance** is a conservative lower bound on the gap between the modeled drone surface and the four rack and mast bounds. The initial value is 0.229 m. **Drone heights** shows the three current heights above the conservatory floor.

The aircraft are kinematic. They ease into and out of each run along the solved paths. The app checks positions for a staggered departure so the modeled drone envelopes remain apart, and keeps the current sortie going when it cannot find a clear dispatch schedule for a replan. The trays and mast use static obstacle envelopes. The plants, housing, and rotors supply visual context. This exhibit describes simulated indoor inspection flights.

## Art and runtime

The conservatory, trays, illuminated landing marks, plants, aircraft, and three camera compositions are original procedural meshes. Perspective, side, and close tracking views use the same scene on desktop and phone. Rendering starts with WebGPU and falls back to Margo WebGL2. Both run the same volume planner and flight clock. The exhibit has no external runtime assets.

The gallery builds this exhibit from the verified public [Margo Engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/navmesh).

## References

- Alex Nash, Sven Koenig and Craig Tovey, 2010. *Lazy Theta\*: Any-Angle Path Planning and Path Length Analysis in 3D*. [Authors’ paper and experiment notes](https://idm-lab.org/project-o-content.html)
- Kenny Daniel, Alex Nash, Sven Koenig and Ariel Felner, 2010. *Theta\*: Any-Angle Path Planning on Grids*. [JAIR paper](https://arxiv.org/abs/1401.3843)
- Eden Project. *Architecture* and *Rainforest Biome*. The glazed frames and repeated rib silhouettes informed the conservatory art. [Architecture](https://www.edenproject.com/about-us/architecture) · [Rainforest Biome](https://www.edenproject.com/whats-here/rainforest-biome)
