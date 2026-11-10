# Steep-bed rivers

List 3 batch 66 job 8 adds `@margoengine/water/rivers`. `Rivers.attach(water, { sources, substeps, maxFroude })` takes a Water attached with a terrain `coast` and replaces its coastal flow with a solver that stays stable over waterfalls and steep chutes. `setSources` changes the inflows on the next substep without restarting; `dispose` hands the coast back to Water's own solver, which restarts from the terrain.

How it works. The virtual-pipe update (O'Brien and Hodgins 1995; Mei, Decaudin and Hu 2007) is driven by hydrostatically reconstructed interface depths (Audusse et al. 2004): each pipe sees the bed max(b_i, b_j), so a drop of any height drives only the water above the brink, a lake at rest on a stepped bed stays exactly at rest, and depths stay non-negative. Each pipe's flux is capped by maxFroude * sqrt(g a) and half a cell per substep (Courant-Friedrichs-Lewy), and a cell's total outflow is limited to the water it holds. Sources add discharge spread evenly over the cells their square footprint covers.

Why. Water's own surface-driven pipe pushes the whole surface difference through each pipe: over a 10 m fall it reaches 240 m/s, one cell per step. The reconstructed pipe holds the same fall to 6.75 m/s (packages/water/test/rivers.test.js).

Defaults: substeps 8 (Water's coast uses 3), maxFroude 4, no sources. Ranges are in the TSDoc and docs/limits.md.

Proof (M6 Mac mini, Metal WebGPU and the compatibility run): packages/water/test/rivers.browser.mjs runs a 24 x 8 map with a 10 m fall and a 0.5 slope chute fed by 6 m^3/s near the brink for 240 frames at 8 substeps and compares the GPU depth with the float64 model in rivers-reference.js: worst 9.2e-6 m (bound 1e-3); the chute holds 0.173 m on both; after dispose the coast restarts dry. Cost on a 256 x 256 map of 2 m cells with a 200 m^3/s source: 0.168 ms per frame for rivers against 0.155 ms for Water's own coast (Metal WebGPU, other lanes running; diagnostic).

Not done (docs/work-lists/finish-later.md): a bed-slope term so chute fronts reach the slope's gravity speed, bed friction, larger-map cost, and flow shading from the pipe flux.
