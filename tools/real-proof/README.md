# Real proof tools

These run files through programs a person uses, because a validator can pass a file that fails in front of a person. They are run by hand on a machine that has the program; none of them is in the checks. [docs/whitepaper/reproduce.md](../../docs/whitepaper/reproduce.md) says which claim each one proves, and [docs/whitepaper/proof-audit.md](../../docs/whitepaper/proof-audit.md) lists what is still unproved.

| File | Needs | What it does |
| --- | --- | --- |
| `blender_report.py` | Blender 4.2 or later | `blender --background --factory-startup --python blender_report.py -- out.json a.glb b.usdz c.obj`: opens each file with Blender's own importer and writes meshes, triangles, world bounds, materials, images, bones and clips. |
| `blender_base_colour.py` | Blender | `blender --background --factory-startup --python blender_base_colour.py -- <glb, obj, stl or ply> <file> <out.png>`: draws base colour straight to emission in Cycles from one fixed camera, for comparing a file with its source by picture. |
| `glb_bounds.mjs` | Node | `node tools/real-proof/glb_bounds.mjs a.glb`: world bounds of a GLB by plain glTF maths with no engine code. Settles a disagreement between Blender and a file: Blender's rest pose drops bone scale and its import leaves a model at a clip's first frame. |
| `clip_measure.mjs` | Node | Size, floor and travel of every clip of the sample models by plain glTF maths with no engine code. |
| `quicklook_thumbnails.swift` | macOS | `swiftc quicklook_thumbnails.swift -o qlt`, then `./qlt <out folder> a.usdz`: the thumbnail Finder shows, as a PNG. Run one file at a time, and restart the extension between runs; `qlmanage` hangs over ssh, and a very large file can stop the system's thumbnail extension answering for over an hour. |
| `realitykit_bounds.swift` | macOS | `swiftc -parse-as-library realitykit_bounds.swift -o rkb`, then `./rkb <folder>`: RealityKit's `visualBounds` of each USDZ. It reads rest points and does not run the skeleton, so it says nothing about a posed skinned size. |
| `realitykit_steps.swift` | macOS | Steps a file's real RealityKit animation and reads what RealityKit computed. |
| `usdrecord_frames.sh` | macOS | Frames of a USDZ from Apple's `usdrecord` through one fixed camera. |
| `safari/` | macOS, Safari | `node tools/real-proof/safari/build.mjs`, copy `dist` and `server.py` to the Mac, `python3 server.py dist 18765 report.json`, then `open -a Safari http://127.0.0.1:18765/index.html`. The page draws five real models and runs JPEG XL through both decoders, and posts what it saw. Open the same `dist` in another browser to compare pictures. |
