# The Fillet Bench

A fillet rolls a circle of fixed radius along an edge. A chamfer removes material along a flat bevel. Here the same twelve edges of the same 120 × 62 × 86 mm stock receive either treatment. Both sliders use 2 mm increments, so each change selects a separately constructed, validated B-rep body.

Margo's modeler makes the 18 exact solids in generate.mjs. The browser displays the kernel tessellation and publishes the analytic volume of the result and the stock it removed. The generator checks each body and the expected increase in stock removal along each slider.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).
