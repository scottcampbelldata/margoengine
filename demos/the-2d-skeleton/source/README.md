# The 2D Skeleton

Exhibit 153 is **Glasshouse Signal**. Play the keeper's lantern gesture, scrub any pose, and reveal the armature. The conservatory, character parts, hand lantern and moth illustration are original artwork generated from local paths and painted into sprite textures. Margo renders the stage, effects, articulated character and optional bone overlay.

## DragonBones rig

The original 5.5 document is authored in `rig.js`. It contains 17 bones, 14 display slots, a 60-frames-per-second key grid and cubic interpolation. `art.js` generates the matching DragonBones atlas regions and sprite texture. Margo's public `parseDragonBonesJSON` converts that document into a real animated armature. `SkeletalLayer` draws the imported slots.

The gesture anticipates with a dip, lifts through the shoulder and elbow, holds the lantern high, and returns with a small follow-through. The lantern is a child of the wrist and its authored counter-rotation keeps it near upright. The scarf deforms as a 40-vertex weighted mesh with three influencing bones. The feet stay in place. The lantern light and the optional bone guides follow the live imported transforms.

The scene uses native WebGPU first and the full Margo WebGL2 compatibility layer when needed. Both paths render the same 1080 × 640 artwork. Add `?backend=webgl2` to force the latter. The gesture is an authored animation.

## Verification

Use a built [public Margo Engine checkout at the verified pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5) as `MARGO_ENGINE_CHECKOUT`. From the gallery root, `node qa-output/the-2d-skeleton/mechanics.mjs` checks the real format importer, mesh weights, wrist and lantern travel, exact start/end match, planted boots and frame-to-frame wrist continuity at 120 samples per second.

`SKELETON_2D_PRELOAD=1` enables production-style local browser preloads in `qa-output/the-2d-skeleton/check.mjs`. The cold phone profile uses a new 390 × 844 Chrome context, DPR 2, 150 ms network delay, 1.6 Mbps download and 4× CPU throttling. It verifies a trusted Play action, more than 3 artwork pixels of actual wrist movement, and a completed renderer submission. It then tests trusted scrub input, a stationary pause, bone overlay changes and replay. Mobile timing is measured in desktop Chrome emulation.

## References

- [DragonBones team, DragonBones 5.5 JSON format](https://github.com/DragonBones/Tools/blob/master/doc/dragonbones_json_format_5.5.md) specifies the armature, texture regions, weights and timelines.
- [The Art of Crowds Animation, Walt Disney Animation Studios, SIGGRAPH 2025](https://cdn.disneyanimation.com/uploads/publications/SIGGRAPH_2025_The_Art_of_Crowds_Animation.pdf) discusses the classical animation principles that inform the gesture's anticipation and follow-through.
- [Ship Shoal Light Station, Historic American Engineering Record](https://tile.loc.gov/storage-services/master/pnp/habshaer/la/la0300/la0375/data/la0375data.pdf) provides historical context for portable lamp use. The keeper and lamp were designed for this scene.
