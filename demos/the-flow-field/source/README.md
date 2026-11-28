# The Flow Field

Tap open terrain to route 12,000 moving lights to a new destination. Next target cycles between four example destinations. With the relief focused, arrow keys move the target by one grid cell and Shift moves it by four. Show directions draws arrows from the same field the lights read. Pause holds the current positions and leaves destination control available. Reset restores the original destination and initial seeded distribution.

## What the stage computes

The relief is an original 72 × 52 grid with a 0.16 m grid spacing. Each open cell has planning cost 1 or 4. The higher-cost cells read as light slate on the floor. Each of the 592 raised rock cells is a wall in the planner. Of 3,744 cells, 3,152 are reachable from each example target. A tap on a raised obstruction or outside the relief leaves the field unchanged.

The pinned Margo `FlowField` builds a travel-cost potential from the selected destination using fast marching. Each cell gets a downhill direction from the result. Margo’s bulk `FlowField.steer` moves 12,000 units in three speed cohorts with wall-safe steps. Planning cost influences choice of route. The cohorts keep their configured movement speeds regardless of the planning cost of the underlying cell. Units may share a location. Each unit recycled at a source increments the Arrivals counter when it reaches the target cell. Reset restores a repeatable starting layout sampled along the same solver’s source trajectories.

The Margo `PointCloud` draws all 12,000 units on both renderers. Softer marks behind a subset of points show their recent positions. Engraved contour lines come from actual intersections with the authored rock surfaces. We modeled a night-lit terrain study with three instrument nozzles and a moving destination sight.

WebGPU opens first. On compatible WebGL2 systems Margo’s official translation layer draws the same terrain, point arrays, camera view and controls. The entire scene is generated from the source files. The public Margo Engine package pin is `0efd9cff8230507a32deb49907ecd499d46925f5`.

## Sources

- Adrien Treuille, Seth Cooper and Zoran Popović, *Continuum Crowds*, 2006. This exhibit uses the shared fast-marching navigation potential described in the paper. [Research project](https://graphics.cs.cmu.edu/?p=375), [author-hosted paper](https://www.khoury.northeastern.edu/home/scooper/index_files/pub/treuille2006continuum.pdf)
- Elijah Emerson, *Crowd Pathfinding and Steering Using Flow Field Tiles*, 2013. The chapter describes sharing an integration and direction field across many agents. [Game AI Pro chapter](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf)
- The invented exhibit takes visual cues from sculptural work with directional light and from physical relief mapping. [Roden Crater project](https://rodencrater.com/about/), [Swiss National Museum relief shading](https://blog.nationalmuseum.ch/en/2024/01/casting-light-on-relief-map-shading/)
