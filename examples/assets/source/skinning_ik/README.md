# Light Keeper editable source

`../skinning-ik.blend` is the native Blender scene. `build_robot.py` authors the
robot, rig, smooth skin weights and separate mirror orb. `workshop.py` authors
the original furniture, tools, plants and display island. `surface_textures.py`
creates packed PBR maps and applies the documented texture scans in `textures/`.
Asset licensing and attribution are in `../../skinning-ik-LICENSE.md`.

`dedication.py` rasterizes the exact two-line **Margo Engine ♡ / Made for Margie**
inscription through Blender and packs a warm gold ink image onto the lower-center
back of the instrument case beneath the workbench. It changes only the existing
rear polygons' material and UVs, with no lettering mesh exported. The full builder
runs this after the surface pipeline. `dedication/provenance.json` records the
text, local authoring font, placement, image size, and PNG hash; the font file is
not distributed. The generated PNG and original outline-heart mask are retained.

The platform's dry limestone derivative targets `#C9BDA9`, retains small scan
aggregate variation, remaps roughness as `0.80 + 0.15 × source`, sets metalness
to zero, and uses normal strength `0.25`. `apply_dry_concrete(scene, root)` can
repair that material without changing geometry or UVs. The full builder applies
the same finish automatically. Source CC0 maps remain unchanged.

The builder uses Blender's Python API and is run through the existing Blender
MCP socket. Open an empty file, or this scene, before running it. It intentionally
refuses to clear an unrelated saved Blender file. Schedule the build with a
Blender timer so the MCP request can return before rendering finishes:

```python
import bpy, runpy
script = r"C:/path/to/margoengine/examples/assets/source/skinning_ik/build_robot.py"
def rebuild():
    runpy.run_path(script, run_name="__main__")
    return None
bpy.app.timers.register(rebuild, first_interval=0.2)
result = {"scheduled": True}
```

The completed build writes the main GLB, separate centered orb GLB, native
`.blend`, and a render/status file under `test-results/ik/`. The exporter keeps
joint scale exactly one, emits tangents and four-slot weights (at most two
nonzero influences), and exports skinned mesh assemblies as scene roots.

Coordinates use glTF Y-up metres; semantic forward is **-Z**. The direct arm
chain is `UpperArm → Forearm → Hand`. Rest world joint positions are shoulder
`[-0.24, 1.03, 0]`, elbow `[-0.44, 0.84, -0.08]`, wrist
`[-0.48, 1.04, -0.23]`. The orb radius is `0.1046534204`, its initial center is
`[-0.48, 1.17, -0.23]`, and its fixed offset above the wrist is `[0, 0.13, 0]`.
`Head` pivots at `[0, 1.15, 0]`. The four-second idle clip only rotates Head;
the arm bind pose stays fixed for the optional IK solver.

`extract_ik_shapes.py` refreshes `examples/skinning-ik/body-ik-shapes.ts` from
the exported rigid arm vertices using Blender's in-memory convex hull operation.
It preserves the exact convex support of the exported geometry and exempts
only the authored shoulder cap, spherical bearing, washers, axle, and hex hubs.
The analytic primitive union uses a one-micrometre float guard and retains the
visible proximal shaft that a broad shoulder sphere would hide. Run its `extract()`
function through Blender MCP after changing arm geometry; it does not change
the open scene. The matching saved Blender scene must be open at bind frame 1:
its native loose components produce separate `upperArmPieces` for the bellows,
piston barrel, sculpted armor, and copper shaft. Keeping those four hulls separate
avoids a fictitious solid bridge across the gaps between parts. The smooth skin
sleeve remains an animated rendering surface.

Both rubber boot soles are `0.010 m` tall, centered at `Y=0.004`, with a
`0.003 m` bevel. Their bottom `Y=-0.001` embeds one millimetre into the island's
`Y=0` stone top; their top `Y=0.009` meets the porcelain toe underside.

The task lamp is a separate rigid hierarchy, `LampBase → LampLowerArm →
LampUpperArm → LampShade`. Its rest world pivots are `[1.24, 0.85, 0.245]`,
`[1.24, 0.85, 0.245]`, `[1.34, 0.99, 0.245]`, and `[1.10, 1.09, 0.20]`.
All four nodes export with identity rest rotations and unit scales. Each moving
node owns its corresponding rigid geometry; the shade owns its diffuser and
short service lead. Runtime joint rotations articulate the lamp independently
of the robot skin. `workshop.build(ctx)` supports `ctx["only_lamp"] = True` for
targeted lamp regeneration with the same geometry and pivots as a full build.
