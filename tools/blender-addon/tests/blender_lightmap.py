"""CC0 Margo-authored fixture: coloured uniform sun and shadowed receiver, independent analytic irradiance."""
from pathlib import Path
import importlib.util
import json
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
scene = bpy.context.scene
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.world = None
material = bpy.data.materials.new("Diffuse")
material.use_nodes = True
bsdf = material.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.5, 0.25, 0.125, 1)
bsdf.inputs["Metallic"].default_value = 0
bsdf.inputs["Roughness"].default_value = 1
bpy.ops.mesh.primitive_plane_add(size=4)
plane = bpy.context.object
plane.name = "Receiver"
plane.data.materials.append(material)
uv1 = plane.data.uv_layers.new(name="Lightmap")
for uv in plane.data.uv_layers[0].data:
    uv.uv *= 0.25
sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 2
sun_data.color = (0.25, 0.5, 1)
sun_data.angle = 0
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)
# The sun points down -Z, so the horizontal plane receives E=(0.5,1,2).
original = plane.data
state = (scene.render.engine, scene.cycles.device, material.node_tree.nodes.active, len(bpy.data.images), len(bpy.data.meshes))
export_scene(bpy.context, output / "lightmap.margo", lightmap_size=32, lights_cameras=False)
assert plane.data == original
assert state == (scene.render.engine, scene.cycles.device, material.node_tree.nodes.active, len(bpy.data.images), len(bpy.data.meshes))
assert len(original.uv_layers) == 2
(output / "lightmap-truth.json").write_text(json.dumps({"irradiance": [0.5, 1, 2], "albedo": [0.5, 0.25, 0.125], "size": 32}), encoding="utf-8")
# Generate a second chart set on a mesh which has only UV0, and restore it even after an export fails.
plane.data.uv_layers.remove(plane.data.uv_layers[1])
export_scene(bpy.context, output / "lightmap-generated.margo", lightmap_size=16, lights_cameras=False)
assert len(plane.data.uv_layers) == 1
try:
    export_scene(bpy.context, output / "missing" / "bad.margo", lightmap_size=16, lights_cameras=False)
except OSError:
    pass
else:
    raise AssertionError("missing destination must fail")
assert plane.data == original and len(plane.data.uv_layers) == 1
print("MARGO_LIGHTMAP_OK")
