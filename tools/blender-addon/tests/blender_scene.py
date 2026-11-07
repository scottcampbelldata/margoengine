"""Run only in a separate factory-startup/background Blender process: a white floor and a red cube lit by a sun, a spot
and a point light, framed by a perspective scene camera, with a second orthographic camera, exported to scene.margo.
Blender's own numbers go to scene-truth.json beside it: each light's world direction and each camera's projection from
Blender's calc_matrix_camera, in Margo's Y-up metres. The files are packages/blender/tests/fixtures/scene.margo and
scene-truth.json (Blender 5.2.3 LTS); tests/scene.test.js compares them."""
from pathlib import Path
import importlib.util
import json
import math
import sys
import bpy
from mathutils import Vector

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = 320, 240


def painted(obj, colour):
    obj.data.uv_layers.remove(obj.data.uv_layers[0])
    material = bpy.data.materials.new(obj.name)
    if bpy.app.version < (5, 0, 0):
        material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = colour
    shader.inputs["Roughness"].default_value = 0.9
    obj.data.materials.append(material)


bpy.ops.mesh.primitive_plane_add(size=6)
floor = bpy.context.active_object
floor.name = floor.data.name = "Floor"
painted(floor, (0.8, 0.8, 0.8, 1))
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
cube = bpy.context.active_object
cube.name = cube.data.name = "Cube"
painted(cube, (0.8, 0.1, 0.1, 1))


def light(name, kind, location, rotation, **settings):
    data = bpy.data.lights.new(name, kind)
    for key, value in settings.items():
        setattr(data, key, value)
    obj = bpy.data.objects.new(name, data)
    obj.location, obj.rotation_euler = location, rotation
    scene.collection.objects.link(obj)
    return obj


light("Sun", "SUN", (0, 0, 5), (math.radians(30), 0, math.radians(20)), energy=3.0, color=(1.0, 0.9, 0.8))
light("Spot", "SPOT", (2, -2, 3), (math.radians(45), 0, math.radians(45)), energy=500.0, color=(0.2, 0.4, 1.0), spot_size=math.radians(50), spot_blend=0.3)
light("Bulb", "POINT", (-2, 1, 1.5), (0, 0, 0), energy=100.0, color=(1.0, 1.0, 0.5), use_custom_distance=True, cutoff_distance=8.0)


def camera(name, location, look_at, **settings):
    data = bpy.data.cameras.new(name)
    for key, value in settings.items():
        setattr(data, key, value)
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = (Vector(look_at) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)
    return obj


scene.camera = camera("View", (4, -4, 3), (0, 0, 0.5), lens=35, clip_start=0.05, clip_end=60)
camera("Plan", (0, 0, 10), (0, 0, 0), type="ORTHO", ortho_scale=7, clip_start=0.5, clip_end=20)
bpy.context.view_layer.update()

y_up = lambda v: [v.x, v.z, -v.y]
truth = {"lights": {}, "cameras": {}}
depsgraph = bpy.context.evaluated_depsgraph_get()
for obj in scene.objects:
    if obj.type == "LIGHT":
        truth["lights"][obj.name] = {"direction": y_up((obj.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()), "position": y_up(obj.matrix_world.translation)}
    elif obj.type == "CAMERA":
        projection = obj.calc_matrix_camera(depsgraph, x=scene.render.resolution_x, y=scene.render.resolution_y)
        truth["cameras"][obj.name] = {
            "position": y_up(obj.matrix_world.translation),
            "forward": y_up((obj.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()),
            "up": y_up((obj.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized()),
            "projection": [list(row) for row in projection],
        }
size = export_scene(bpy.context, str(output / "scene.margo"), bake_size=0)
(output / "scene-truth.json").write_text(json.dumps(truth, indent=1) + "\n")
print("Margo scene export:", size, "bytes;", bpy.app.version_string, flush=True)

# Refusals, by object name: an area light, and a custom property the exporter writes itself.
def refused(message):
    try:
        export_scene(bpy.context, str(output / "refused.margo"), bake_size=0)
    except ValueError as error:
        assert message in str(error), error
        return
    raise AssertionError(f"export did not refuse: {message}")


area = light("Panel", "AREA", (0, 0, 4), (0, 0, 0), energy=50.0)
refused("Light 'Panel': area lights")
bpy.data.objects.remove(area)
scene.camera["margo:yfov"] = 1.0
refused("Object 'View': remove the custom property 'margo:yfov'")
del scene.camera["margo:yfov"]
# Off, lights and cameras stay out of the file as before.
export_scene(bpy.context, str(output / "plain.margo"), bake_size=0, lights_cameras=False)
assert not (output / "refused.margo").exists()
print("Margo scene refusals: 2; lights_cameras=False:", (output / "plain.margo").stat().st_size, "bytes", flush=True)
