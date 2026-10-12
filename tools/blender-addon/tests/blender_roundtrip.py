"""Run only in a separate factory-startup/background Blender process."""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export import register, unregister
from margo_export.exporter import export_scene
from margo_export.writer import png

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
register()
mesh = bpy.data.meshes.new("Triangle")
mesh.from_pydata([(-0.6, 0, -0.6), (0.6, 0, -0.6), (0, 0, 0.6)], [], [(0, 1, 2)])
uv = mesh.uv_layers.new(name="UVMap")
for loop, value in zip(uv.data, ((0, 0), (1, 0), (0.5, 1))):
    loop.uv = value
material = bpy.data.materials.new("Textured")
if bpy.app.version < (5, 0, 0):
    material.use_nodes = True
shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
shader.inputs["Roughness"].default_value = 0.6
shader.inputs["Metallic"].default_value = 0
image_path = output / "texture.png"
image_path.write_bytes(png(2, 2, bytes((230, 40, 20, 255, 40, 230, 20, 255, 20, 40, 230, 255, 230, 230, 20, 255))))
image = bpy.data.images.load(str(image_path))
image.colorspace_settings.name = "sRGB"
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
texture.interpolation = "Closest"
material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
normal_path = output / "normal.png"
normal_path.write_bytes(png(2, 2, bytes((128, 128, 255, 255)) * 4))
normal_image = bpy.data.images.load(str(normal_path))
normal_image.colorspace_settings.name = "Non-Color"
normal_texture = material.node_tree.nodes.new("ShaderNodeTexImage")
normal_texture.image = normal_image
normal_map = material.node_tree.nodes.new("ShaderNodeNormalMap")
material.node_tree.links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
material.node_tree.links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
mesh.materials.append(material)
obj = bpy.data.objects.new("Triangle", mesh)
bpy.context.collection.objects.link(obj)
obj["margo:shadow_caster"] = True
obj["margo:lod_dist"] = [15.0, 45.0, 90.0]
copy = bpy.data.objects.new("Mirrored", mesh)
copy.location = (2, 0, 0)
copy.scale = (-1, 1, 1)
bpy.context.collection.objects.link(copy)
bpy.context.view_layer.update()
asset = output / "blender.margo"
size = export_scene(bpy.context, asset)
bpy.ops.export_scene.gltf(filepath=str(output / "native.glb"), export_format="GLB", export_tangents=True)
assert asset.read_bytes() == (export_scene(bpy.context, output / "repeat.margo") and (output / "repeat.margo").read_bytes())
previous = asset.read_bytes()
shader.inputs["Transmission Weight"].default_value = 0.5
try:
    export_scene(bpy.context, asset)
except ValueError as error:
    assert "Transmission" in str(error)
else:
    raise AssertionError("Unsupported transmission was silently exported")
assert asset.read_bytes() == previous
shader.inputs["Transmission Weight"].default_value = 0
modifier = obj.modifiers.new("Evaluated subdivision", "SUBSURF")
modifier.subdivision_type = "SIMPLE"
modifier.levels = 1
bpy.context.view_layer.update()
export_scene(bpy.context, output / "modifier.margo")
obj.modifiers.remove(modifier)
sources = bpy.data.collections.new("Instance sources")
prototype = bpy.data.objects.new("Prototype", mesh)
sources.objects.link(prototype)
emitter = bpy.data.objects.new("Collection instance", None)
emitter.instance_type = "COLLECTION"
emitter.instance_collection = sources
emitter.location = (0, 0, -2)
bpy.context.collection.objects.link(emitter)
bpy.context.view_layer.update()
export_scene(bpy.context, output / "instances.margo")
bpy.data.objects.remove(emitter, do_unlink=True)
bpy.context.scene.unit_settings.scale_length = 0.01
export_scene(bpy.context, output / "centimeters.margo")
bpy.context.scene.unit_settings.scale_length = 1
obj.scale = (2, 1, 1)
copy.parent = obj
copy.rotation_euler.z = 0.5
bpy.context.view_layer.update()
try:
    export_scene(bpy.context, asset)
except ValueError as error:
    assert "shear" in str(error)
else:
    raise AssertionError("Shear was silently discarded")
assert asset.read_bytes() == previous
unregister()
print(f"Margo Blender round-trip fixture exported: {size} bytes; Blender {bpy.app.version_string}")
