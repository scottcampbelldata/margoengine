"""Run only in a separate factory-startup/background Blender process: a small level whose objects carry `margo:`
component tags (a static floor, a dynamic crate and ball, an off-centre shelf, a trigger, two lights and a script),
exported to components.margo. The file is packages/blender/tests/fixtures/components.margo (Blender 5.2.3 LTS)."""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)


def cube(name, location, scale=(1, 1, 1), size=1.0):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    obj.scale = scale
    obj.data.uv_layers.remove(obj.data.uv_layers[0])  # compact 24-byte vertices keep the fixture small
    return obj


# Floor: 10 x 10 x 0.2 m, top at z = 0 (Blender Z-up; y = 0 in the engine).
floor = cube("Floor", (0, 0, -0.1), (10, 10, 0.2))
floor["margo:collider"] = "box"
floor["margo:friction"] = 0.8
# Crate: a 1 m cube 3 m up, 2 kg.
crate = cube("Crate", (0, 0, 3))
crate["margo:body"] = "dynamic"
crate["margo:mass"] = 2.0
crate["margo:friction"] = 0.5
# Ball: radius 0.5 m, 2 m up, 3 m to the side.
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(3, 0, 2), segments=16, ring_count=8)
ball = bpy.context.active_object
ball.name = ball.data.name = "Ball"
ball.data.uv_layers.remove(ball.data.uv_layers[0])
ball["margo:collider"] = "sphere"
ball["margo:body"] = "dynamic"
ball["margo:restitution"] = 0.0
# Shelf: the mesh sits 1.5 m above its origin, so its collider gets a centred child node.
shelf = cube("Shelf", (-3, 0, 0))
for v in shelf.data.vertices:
    v.co.z += 1.5
shelf["margo:collider"] = "box"
# Pad: a trigger volume 1 m across on the floor.
pad = cube("Pad", (0, 3, 0.5))
pad["margo:trigger"] = True
pad["margo:script"] = "door, glow"
# Lamp: a small mesh that is also a point light; Sun: a directional light pointing down.
lamp = cube("Lamp", (2, 2, 2.5), size=0.2)
lamp["margo:light"] = "point"
lamp["margo:color"] = [1.0, 0.8, 0.6]
lamp["margo:intensity"] = 40.0
lamp["margo:range"] = 12.0
sun = cube("Sun", (0, 0, 8), size=0.1)
sun["margo:light"] = "directional"
sun["margo:intensity"] = 3.0
sun["margo:script"] = "door"
spot = cube("Spot", (-2, 2, 3), size=0.1)
spot.rotation_euler = (0.6, 0, 0)
spot["margo:light"] = "spot"
spot["margo:intensity"] = 80.0
spot["margo:inner_cone"] = 0.2
spot["margo:outer_cone"] = 0.5
spot["margo:note"] = "kept as a plain property"

export_scene(bpy.context, output / "components.margo")
print("Margo components export:", (output / "components.margo").stat().st_size, "bytes;", bpy.app.version_string)
