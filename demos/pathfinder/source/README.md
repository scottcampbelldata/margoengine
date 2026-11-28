# Pathfinder

Exhibit 168 · The East Quay

Drag the gold pin to a new place on the quay. The gold cart replans through the terraces while seven other carts cross in both directions. Arrow keys move the goal when the scene has focus. **Show mesh** reveals the underlying navigation polygons. **Jump links on** switches to **Bridge only** and restarts the carts at their docks while preserving the goal. Pause and resume hold the current simulation.

## Navigation

The static walkable polygons match the terrace layout, with clearance around the stone rims, two garden beds and the edge of the canal. The two quay surfaces connect at the rear bridge. There are also two one-way off-mesh links in opposite lanes across the canal. The polygon route comes from Margo’s A* corridor search and funnel. The drawn route and optional mesh come from the engine’s `routeLines` and `meshLines` debug output.

The carts advance with the real Margo `Crowd` implementation at a fixed 60 Hz step. Each cart is an equal-mass disc of radius 0.195 m. ORCA corrects the preferred ground velocity against nearby moving discs and the mesh edges. The movement also includes the engine’s acceleration and slowing behavior. Selecting a new goal while the gold cart is airborne holds the current crossing until touchdown.

When the solver reports `offmesh`, the cart takes its position from that link. The visible height follows the same 1.72 m span and 0.43 m parabolic rise as Margo’s debug arch. The arch visualizes the crossing state, with horizontal movement owned by the solver. Ground ORCA operates on the terraces and bridge. The two jump lanes are separated in space.

Every 3D part is original procedural Margo geometry. A fixed oblique camera fits the same model on phone and desktop. Both renderers use the same geometry, antialiasing option, shadow map, ground route and cart motion. WebGPU is tried first. Automatic fallback and `?backend=webgl2` use the full Margo compatibility layer.

## Sources

- Peter E. Hart, Nils J. Nilsson and Bertram Raphael, “A Formal Basis for the Heuristic Determination of Minimum Cost Paths,” 1968. [Original paper](https://ai.stanford.edu/~nilsson/OnlinePubs-Nils/PublishedPapers/astar.pdf)
- John Hershberger and Jack Snoeyink, “Computing minimum length paths of a given homotopy class,” 1994. [Published paper](https://www.sciencedirect.com/science/article/pii/0925772194900108)
- Jur van den Berg, Stephen J. Guy, Ming Lin and Dinesh Manocha, “Reciprocal n-body Collision Avoidance,” 2011. [ORCA paper](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf)
- The quay’s small bridge, retaining walls and exposed water edge take visual cues from Copenhagen’s Nordhavn waterfront planning. All geometry, placement and materials in the exhibit are original. [Cobe Nordhavn project](https://cobe.dk/projects/nordhavn/2682)
- Scott Campbell, Margo Engine public revision `0efd9cff8230507a32deb49907ecd499d46925f5`. [Pinned public engine](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5)

## Local checks

Set `MARGO_ENGINE_CHECKOUT` to the built pinned checkout. Use `PATHFINDER_PRELOAD=1` to test with the gallery’s standard scene and compatibility preloads.

```powershell
node qa-output/pathfinder/mechanics.mjs
node qa-output/pathfinder/check.mjs desktop mobile mobile-auto mobile-compat desktop-compat
```

The mechanics check verifies the actual link transition, the full bridge alternative, separation in the authored traffic pattern, and real velocity corrections during close passes. The browser check uses trusted mouse or touch drag, navigates across both types of crossing, confirms arrival, toggles the mesh, and tests pause, keyboard goal movement and reset.

## Verification

The browser probe uses a fresh context and finds the initial pin from the rendered camera projection. A trusted drag moves the goal, draws a freshly computed route, and waits for the submitted render. On phone the test uses a 390 × 844 viewport at DPR 2, 4× CPU slowdown and 150 ms latency at 1.6 Mbps.

| Profile | First rendered drag |
| --- | ---: |
| Desktop WebGPU | 0.669 s |
| Desktop forced WebGL2 compatibility | 0.500 s |
| Phone WebGPU | 1.099 s |
| Phone automatic WebGL2 compatibility | 1.995 s |
| Phone forced WebGL2 compatibility | 2.381 s |

The controlled 23-second jump run measured an 11.90 m opening route, 11 jumps, 532 nearby deflections of preferred velocity and under 0.7 mm maximum sampled overlap of grounded discs. Bridge-only length was 14.46 m and its under-1.6 mm sampled overlap stayed within the 2 mm regression tolerance. These are observations for the authored traffic pattern. The mechanics check also moves the goal midair and verifies that the new route starts at touchdown.

Evidence is in `qa-output/pathfinder/freeze.log`, `summary.json`, `mechanics.log` and `crossing-comparison.png`.
