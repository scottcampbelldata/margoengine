"""Run only in a separate factory-startup/background Blender process: three 2 m planes whose materials need baking or
not, exported to bake.margo with 32 x 32 bakes. The file is packages/blender/tests/fixtures/bake.margo (Blender 5.2.3
LTS); tests/bake.test.js checks its images against the node maths below.

- Procedural: a Principled BSDF fed by node maths of the UV coordinates (u, v): Base Color = Combine Color(u, v, 0.25),
  Roughness = 0.25 + 0.5 u, Metallic = v.
- Painted: a Diffuse BSDF of colour (0.2, 0.5, 0.8), not a Principled BSDF at all.
- Plain: a constant Principled BSDF, which exports directly with no images."""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import NeedsBake, export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)


def plane(name, x, material):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(x, 0, 0))
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    obj.data.materials.append(material)
    return obj


def material(name):
    result = bpy.data.materials.new(name)
    if bpy.app.version < (5, 0, 0):
        result.use_nodes = True
    return result, result.node_tree


procedural, tree = material("Procedural")
shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
coordinates = tree.nodes.new("ShaderNodeTexCoord")
split = tree.nodes.new("ShaderNodeSeparateXYZ")
tree.links.new(coordinates.outputs["UV"], split.inputs["Vector"])
combine = tree.nodes.new("ShaderNodeCombineColor")
tree.links.new(split.outputs["X"], combine.inputs[0])
tree.links.new(split.outputs["Y"], combine.inputs[1])
combine.inputs[2].default_value = 0.25
tree.links.new(combine.outputs["Color"], shader.inputs["Base Color"])
rough = tree.nodes.new("ShaderNodeMath")
rough.operation = "MULTIPLY_ADD"
tree.links.new(split.outputs["X"], rough.inputs[0])
rough.inputs[1].default_value = 0.5
rough.inputs[2].default_value = 0.25
tree.links.new(rough.outputs["Value"], shader.inputs["Roughness"])
tree.links.new(split.outputs["Y"], shader.inputs["Metallic"])

painted, tree = material("Painted")
for node in list(tree.nodes):
    if node.type == "BSDF_PRINCIPLED":
        tree.nodes.remove(node)
diffuse = tree.nodes.new("ShaderNodeBsdfDiffuse")
diffuse.inputs["Color"].default_value = (0.2, 0.5, 0.8, 1)
out = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
tree.links.new(diffuse.outputs["BSDF"], out.inputs["Surface"])

plain, tree = material("Plain")
plain_shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
plain_shader.inputs["Base Color"].default_value = (0.6, 0.3, 0.1, 1)
plain_shader.inputs["Roughness"].default_value = 0.7

plane("Procedural", -3, procedural)
plane("Painted", 0, painted)
plane("Plain", 3, plain)
bpy.context.view_layer.update()

# Baking off: the procedural material fails by name, as before baking existed.
try:
    export_scene(bpy.context, output / "off.margo", bake_size=0)
except NeedsBake as error:
    assert "Procedural" in str(error), error
else:
    raise AssertionError("A procedural material exported without baking")

engine = bpy.context.scene.render.engine
counts = {m.name: len(m.node_tree.nodes) for m in bpy.data.materials}
image_count = len(bpy.data.images)
active = bpy.context.view_layer.objects.active
selected = sorted(o.name for o in bpy.context.view_layer.objects if o.select_get())
size = export_scene(bpy.context, output / "bake.margo", bake_size=32)
# The bake leaves the scene as it found it: render engine, nodes, images and selection.
assert bpy.context.scene.render.engine == engine, bpy.context.scene.render.engine
assert {m.name: len(m.node_tree.nodes) for m in bpy.data.materials} == counts
assert len(bpy.data.images) == image_count
assert bpy.context.view_layer.objects.active == active
assert sorted(o.name for o in bpy.context.view_layer.objects if o.select_get()) == selected
# Baking is repeatable: the same scene gives the same bytes.
export_scene(bpy.context, output / "repeat.margo", bake_size=32)
assert (output / "repeat.margo").read_bytes() == (output / "bake.margo").read_bytes(), "A second bake gave other bytes"
print("Margo bake export:", size, "bytes;", bpy.app.version_string)
