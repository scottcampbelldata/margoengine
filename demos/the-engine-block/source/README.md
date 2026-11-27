# The Engine Block

A four-cylinder casting with a longitudinal section and a downloadable CAD solid. It is an original exhibit model with illustrative dimensions.

Open the gallery demo, then tap or drag **Section position**. **Centre cut** exposes all four bores at their full 86.0 mm opening. A 30 mm offset shows a 61.6 mm opening and a 44 mm offset passes outside the bores. Select a bore from the control panel. The in-scene witness shows the diameter in the whole view and the chord in section. Use the view cube for axis views and to return home. **Download STEP** uses the CAD kernel to write the full casting. **Verify readback** reads those same output bytes into a CAD solid and compares the recovered topology and volume with the authored model.

## Exact geometry and display

[generate.mjs](generate.mjs) is the B-rep authoring recipe. It constructs a 462 mm casting blank, applies four 12 mm upright fillets and shells from the bottom at 8.5 mm. The four cylinder bosses deliberately join between bores, which are machined through at 86 mm diameter and 101 mm pitch. Pan rails, ribs, ten head fastener holes and three jacket ports are part of the same solid. The shell measurement is the model input thickness on its basic walls. The joined bosses, machined features, fillets and reinforcement change the local metal thickness. Water-jacket and crankcase details are simplified as exhibit geometry.

The browser renders the public Margo B-rep tessellator's output with Margo Materials, Lines, Labels, Selection and ViewCube. The generated display asset contains the full geometry at the same tessellation on every device. The STEP and verification code load when requested. The display uses a live material clip plane, with a cap filled from intersections with the same display triangles. The cap is visual tessellation. The bore opening measurement comes from the exact circle dimensions as 2√(r² − z²). The exhibit stand and live clip remain outside the exported AP214 geometry.

The STEP file has one valid manifold solid, 96 analytic faces and a CAD volume of 4,887.172479748219 cm³. The generator checks topology before and after export, checks the volume and tessellates 3,724 triangles. The browser round trip permits a volume difference of at most 0.001 cm³ and checks the imported face count.

## Regenerate

From the showcase project root, point MARGO_ENGINE_CHECKOUT at the verified public checkout built at 0efd9cff8230507a32deb49907ecd499d46925f5, then run:

```powershell
node src/the-engine-block/generate.mjs
```

The three generated files are the analytic STEP solid, its display triangles and a small JSON record of the verified topology and volume.

## References

- Caterpillar, *3600 Engine Basics*, LEKQ9085. Studied casting, liner, deck and crankcase terminology. [Technical reference](https://emc.cat.com/n/api/pubdirect?media_string_id=LEKQ9085)
- Toyota Motor Corporation, *Cylinder block for internal combustion engine*, JP2003161131A, 2003. Studied in-line cylinder layout and jacket surrounding the cylinder bank. [Patent publication](https://patents.google.com/patent/JP2003161131A/en)
- Robert Lipman and Soonjo Kwon, NIST, *STEP File Analyzer and Viewer User Guide (Update 7)*, 2023. Used to identify AP214 and the role of the neutral Part 21 file in CAD verification. [NIST software and documentation](https://www.nist.gov/services-resources/software/step-file-analyzer-and-viewer)
