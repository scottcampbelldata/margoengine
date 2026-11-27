# Cyprus raft demo asset

This is a period interpretation of a reversible Great Lakes life raft for the SEA-12 demo. George Clark’s patent
specifies four rows of short watertight cylinders, two identical usable faces, tied timber rails and side fenders.
The original Cyprus raft’s construction is undocumented in the material available for this demo.

- [George Clark, Improvement in Life-Rafts, US146316A (1874)](https://patents.google.com/patent/US146316A/en)
- [Smithsonian patent model TR.325945](https://americanhistory.si.edu/ne/collections/object/nmah_843796)

The Blender source models 20 sealed chambers, timber decks, iron fasteners and twisted hemp handlines. It builds
its own packed pine and tinned-steel textures. The five material batches share the same centered metre-scale origin
as the separate Y-up displacement mesh. The demo uses a modeled empty mass of 274.516 kg, calculated from the timber
volume at 540 kg/m³, 0.9 mm sheet steel at 7,850 kg/m³ and a 12 kg hardware allowance. Each reduced chamber polygon
preserves the circular section area in the displacement mesh, which encloses 1.181 m³.

Run the Blender 4.5 LTS authoring script in a background session to recreate the packed `.blend`, raw GLB and
watertight displacement mesh in `test-results/sea12-raft`.

```text
blender --background --factory-startup --python examples/assets/source/sea12/build_raft.py
node examples/assets/source/sea12/pack_raft.mjs
```

The packaging step writes the GLB with meshopt geometry and six KTX2 maps. It also copies the displacement mesh
to `examples/assets/sea12/`. Open `/demos/cyprus-raft.html` to see the rendered raft under live surface pressure
and buoyancy.
