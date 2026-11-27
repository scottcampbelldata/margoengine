# The Cell Microscope

An experimental cryo-electron microscopy map of **bovine mitochondrial ATP synthase, state 1a** (EMD-3164). Open **Surface** and raise the contour level to see the outline fragment into islands of stronger density. In **Volume**, change opacity to see more or less of the density cloud. Drag horizontally or use the arrow buttons to turn the specimen. Reset returns to the initial Surface view. The two labels locate the catalytic head and membrane rotor using their approximate centroids from the fitted 5ARA model.

## Specimen and display

The archive reports 6.7 Å reconstruction resolution. The exhibit samples every fourth voxel of the original 256³ volume within a rectangular crop. The 29 × 31 × 43 display grid has 6.56 Å spacing on all axes and preserves the MRC axis order. This display grid has lower spatial sampling than the original deposit. The scalar values use the archive's arbitrary density units and are rounded to the nearest 0.00005, with a maximum absolute quantization error below 0.000025. The 50 Å ruler uses the orthographic projection scale. Volume color and transparency are display settings applied to those same samples.

The verified Margo checkout’s internal cryo-EM fixture is a different molecular complex. This exhibit uses a separately sourced CC0 specimen from the same EMDB archive. The exact checksums, source URL, inclusive index ranges, format and scale are in `tools/density.json`. Run the following from this demo folder with the original data downloaded from that source. The script reproduces the 56,053-byte gzipped grid and its record.

    python tools/prepare-density.py path/to/emd_3164.map.gz

## Rendering and verification

The page uses public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Sciviz draws a real threshold isosurface using native WebGPU marching cubes. Margo's full WebGL2 compatibility path runs the package's Rust/Wasm extractor and draws its output. Both use the same grid and the Sciviz ray-marched volume shader in Volume mode. The initial contour has 10,480 triangles and the tested .160 contour has 11,740. Raising the threshold can create more small, disjoint surfaces even as the enclosed density region shrinks.

The Playwright check in `qa-output/the-cell-microscope/check.mjs` measures from cold navigation to a trusted contour touch and the resulting GPU completion. It also changes the ray-marched volume, adjusts its opacity, rotates, returns to Surface mode and compares each canvas image. The check uses the gallery package resolver and startup hints. Chrome runs at a 390 px viewport, 150 ms network latency, 1.6 Mbps throughput and fourfold CPU slowdown for the phone profiles.

The final build completed the first trusted contour at 1.737 s on native mobile WebGPU, 2.888 s on forced mobile WebGL2, and 2.919 s on automatic mobile WebGL2. Desktop completed at 0.379 s native and 0.233 s forced WebGL2. All modes passed the round-trip controls and rendered-pixel checks. The native mobile run reached the preferred two-second target. WebGL2 cleared the three-second gate.

## References

- Anna Zhou, Alexis Rohou, Daniel G. Schep, John V. Bason, Martin G. Montgomery, John E. Walker, Nikolaus Grigorieff and John L. Rubinstein, 2015. *Structure and conformational states of the bovine mitochondrial ATP synthase by cryo-EM*. [eLife article](https://doi.org/10.7554/eLife.10180) · [Deposited map](https://www.ebi.ac.uk/emdb/EMD-3164) · [Fitted model](https://www.rcsb.org/structure/5ARA)
- EMBL-EBI. *Public data-access statement*. [EMDB public-domain dedication](https://www.ebi.ac.uk/pdbe/about/public-data-access-statement)
- William E. Lorensen and Harvey E. Cline, 1987. *Marching Cubes: A High Resolution 3D Surface Construction Algorithm*. [Original manuscript](https://graphics.stanford.edu/courses/cs348a-21-winter/Papers/Marching_Cubes.pdf)
- Marc Levoy, 1988. *Display of Surfaces from Volume Data*. [Original paper](https://graphics.stanford.edu/papers/volume-cga88/)
- Jens Krüger and Rüdiger Westermann, 2003. *Acceleration Techniques for GPU-based Volume Rendering*. [Original paper](https://www.cs.cit.tum.de/fileadmin/w00cfj/cg/Research/Publications/2003/Acceleration_Techniques_for_GPU-based_Volume_Rendering/vis03-rc.pdf)
