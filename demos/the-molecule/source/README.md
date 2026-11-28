# The Molecule

Exhibit 52 presents an experimental model of green fluorescent protein from the jellyfish Aequorea victoria. The ball-and-stick view shows the entire deposited protein chain. Space filling uses van der Waals sphere radii. Chromophore isolates the chromophore residue at the center of the barrel and keeps its deposited internal links. Drag, use the rotation slider, or focus the canvas and use the arrow keys to orbit. Tap the model or press Enter on the canvas to identify a visible atom or bond.

The apparatus is an original engraved optical turntable under a continuous dark cyclorama. The exhibit uses colors to identify elements, with lime for chromophore carbon. The model depicts geometry and relative scale under illustrative lighting. Its scale bar is calibrated in the focal plane. The visible molecular radii are conventional representation sizes.

## Experimental coordinates and attribution

The source is RCSB PDB entry 1EMA, deposited by Mats Örmo and S. James Remington and released in 1996. It records a 1.90 Å X-ray diffraction structure of the Thr65 variant. The model shows chain A with 1,771 atoms across 226 modeled residue identities, including the chromophore and four deposited selenomethionines. The water records were removed. The retained atomic coordinates preserve the deposited values. This standardized archive data is available under the wwPDB CC0 1.0 public domain dedication.

- [RCSB PDB 1EMA structure record](https://www.rcsb.org/structure/1EMA)
- [Official 1EMA PDB download](https://files.rcsb.org/download/1EMA.pdb)
- [PDB accession DOI](https://doi.org/10.2210/pdb1EMA/pdb)
- [wwPDB usage policy](https://www.wwpdb.org/about/usage-policies)
- Örmo, M., Cubitt, A. B., Kallio, K., Gross, L. A., Tsien, R. Y., and Remington, S. J. [Crystal structure of the Aequorea victoria green fluorescent protein, Science 1996](https://doi.org/10.1126/science.273.5280.1392).
- The calibration dial and instrument materials draw on the [Beckman quartz spectrophotometer, Science Museum Group](https://collection.sciencemuseumgroup.org.uk/objects/co13911/beckman-quartz-spectrophotometer-1941-1950).

The checked PDB SHA-256 is f1b9fdc2b871cc41f21f645a21b4948ce12d79b29197256330b108c9b503b088. The exhibit asset assets/1ema-gfp.pdbz is a gzip stream to make transport independent of the host’s compression configuration and has SHA-256 6bc213ce4d03a33bd29d90a19882cb755e2fac8f1dac8fca54855cca69fd0f51 and size 35,647 bytes. Run node tools/prepare-pdb.mjs original.pdb output.pdbz to reproduce it. The running exhibit invokes Margo’s public parsePDB. It displays 1,815 bonds across the complete chain, including 61 explicit pairs from the file and the inferred distances for ordinary residues. The 22 isolated chromophore atoms and their 23 internal bonds all correspond to preserved records. Each bond is rendered as a cylinder. The display conveys connectivity without encoding bond order.

## Renderer and QA

The verified public Margo revision is 0efd9cff8230507a32deb49907ecd499d46925f5. The feature packages are loaders/pdb and sciviz/molecule with the necessary SciViz figure. Both WebGPU and the full Margo WebGL2 compatibility layer run the same SciViz sphere and cylinder shader, pick routine, geometry and styling. A browser below the compatibility layer’s required WebGL2 tier receives the standard graphics requirements link.

The production build uses the gallery’s conditional WebGL2 startup preloads for this slug, so the device, runtime and readback chunks transfer alongside the structure and rendering program. The automatic fallback requests these resources only when WebGPU is absent. The forced route is available in QA through the backend query argument.

The pinned runner qa-output/the-molecule-check.mjs validates the source hash, archive-to-model coordinates, all counts, structure view switching, a real screen pick on a projected chromophore atom, a direct orbit drag, the rotation slider and reset. The 390 × 844 phone profiles used disabled cache, 150 ms latency, 1.6 Mbps download and fourfold CPU throttling. Native and translated WebGL2 default canvas images differed by an average of 0.055 per channel on the 0–255 scale. The automatic and forced WebGL2 canvas images matched.

| Renderer | First usable frame | First rendered Chromophore control |
| --- | ---: | ---: |
| Phone WebGPU | 1.366 s | 1.451 s |
| Phone automatic WebGL2 | 2.088 s | 2.253 s |
| Phone forced WebGL2 | 2.134 s | 2.322 s |
| Desktop WebGPU | 0.465 s | 0.521 s |

Proof JSON, active control and rendered screenshots are in qa-output/the-molecule.
