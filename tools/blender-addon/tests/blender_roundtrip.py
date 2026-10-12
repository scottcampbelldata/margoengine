"""Run only in a separate factory-startup/background Blender process."""
from pathlib import Path
import importlib.util
import json
import struct
import sys
from types import SimpleNamespace
from unittest.mock import patch
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export import register, unregister
from margo_export.exporter import export_scene
from margo_export import exporter
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

# Exercise the cache with real Blender data while counting expensive work.
bpy.ops.wm.read_factory_settings(use_empty=True)
cad = bpy.data.meshes.new("Shared CAD")
cad.from_pydata([(-0.6, 0, -0.6), (0.6, 0, -0.6), (0, 0, 0.6)], [], [(0, 1, 2)])
for i in range(100):
    part = bpy.data.objects.new(f"CAD {i}", cad)
    part.location.x = i * 2
    bpy.context.collection.objects.link(part)
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
calls = {"to_mesh": 0, "clear": 0}


class CountedObject:
    def __init__(self, obj):
        self.obj = obj

    def __getattr__(self, name):
        return getattr(self.obj, name)

    def to_mesh(self, **kwargs):
        calls["to_mesh"] += 1
        return self.obj.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)

    def to_mesh_clear(self):
        calls["clear"] += 1
        self.obj.to_mesh_clear()


instances = [SimpleNamespace(object=CountedObject(i.object), parent=i.parent, is_instance=i.is_instance,
                             show_self=i.show_self, matrix_world=i.matrix_world.copy(), persistent_id=tuple(i.persistent_id))
             for i in depsgraph.object_instances]
context = SimpleNamespace(scene=bpy.context.scene, view_layer=bpy.context.view_layer,
                          evaluated_depsgraph_get=lambda: SimpleNamespace(object_instances=instances))
with patch.object(exporter.hashlib, "sha256", wraps=exporter.hashlib.sha256) as hashes, \
        patch.object(exporter.np, "unique", wraps=exporter.np.unique) as unique:
    export_scene(context, output / "cad-instances.margo")
    assert calls == {"to_mesh": 1, "clear": 1}, calls
    assert hashes.call_count == 1, hashes.call_count
    assert sum(c.kwargs.get("return_inverse", False) for c in unique.call_args_list) == 1
data = (output / "cad-instances.margo").read_bytes()
offset, length = struct.unpack_from("<2I", data, 68)
manifest = json.loads(data[offset:offset + length])
assert len(manifest["meshes"]) == 1 and len(manifest["nodes"]) == 100
assert all(node["mesh"] == 0 for node in manifest["nodes"])
assert len({tuple(node["translation"]) for node in manifest["nodes"]}) == 100
assert struct.unpack_from("<I", data, 92)[0] == 1  # CAD vertex-section flag.

red = bpy.data.materials.new("Object override")
if bpy.app.version < (5, 0, 0):
    red.use_nodes = True
red_shader = next(n for n in red.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
red.diffuse_color = (0, 1, 0, 1)
red_shader.inputs["Base Color"].default_value = (0.8, 0.2, 0.1, 0.4)
red_shader.inputs["Alpha"].default_value = 0.75
cad.materials.append(None)
part.material_slots[0].link = "OBJECT"
part.material_slots[0].material = red
bpy.context.view_layer.update()
export_scene(bpy.context, output / "cad-overrides.margo")
data = (output / "cad-overrides.margo").read_bytes()
offset, length = struct.unpack_from("<2I", data, 68)
manifest = json.loads(data[offset:offset + length])
assert len(manifest["meshes"]) == 2, "Object material overrides reused the wrong mesh"
override = next(n for n in manifest["nodes"] if n["name"] == part.name)
mid = manifest["meshes"][override["mesh"]]["primitives"][0]["material"]
factor = manifest["materials"][mid]["pbrMetallicRoughness"]["baseColorFactor"]
assert all(abs(a - b) < 1e-6 for a, b in zip(factor, (0.8, 0.2, 0.1, 0.75))), factor
assert manifest["materials"][mid]["alphaMode"] == "BLEND"
color = cad.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
bpy.context.view_layer.update()
export_scene(bpy.context, output / "cad-colors.margo")
data = (output / "cad-colors.margo").read_bytes()
assert struct.unpack_from("<2I", data, 88) == (240, 0), "Vertex colors require the full layout"
cad.color_attributes.remove(color)
cad.uv_layers.new(name="UVMap")
bpy.context.view_layer.update()
export_scene(bpy.context, output / "cad-uv.margo")
data = (output / "cad-uv.margo").read_bytes()
assert struct.unpack_from("<2I", data, 88) == (240, 0), "UVs/tangents require the full layout"
degenerate = bpy.data.meshes.new("Zero normals")
degenerate.from_pydata([(0, 0, 0), (1, 0, 0), (2, 0, 0)], [], [(0, 1, 2)])
fallback = bpy.data.objects.new("Normal fallback", degenerate)
bpy.context.collection.objects.link(fallback)
bpy.context.view_layer.update()
export_scene(bpy.context, output / "normal-fallback.margo")
data = (output / "normal-fallback.margo").read_bytes()
offset, length = struct.unpack_from("<2I", data, 68)
manifest = json.loads(data[offset:offset + length])
node = next(n for n in manifest["nodes"] if n["name"] == fallback.name)
primitive = manifest["meshes"][node["mesh"]]["primitives"][0]
kind, offset, length, flags = struct.unpack_from("<4I", data, 64 + primitive["vertices"] * 16)
assert (kind, length, flags) == (2, 72, 1)
assert all(vertex[3:] == (0, 1, 0) for vertex in struct.iter_unpack("<6f", data[offset:offset + length]))
print(f"Margo Blender round-trip fixture exported: {size} bytes; Blender {bpy.app.version_string}")
