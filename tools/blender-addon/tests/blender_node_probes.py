"""CC0 Margo-authored black-box probes for KB-P3d, with Blender's own values as the truth.
1. A colour wired into a float socket (RGB into Math Add 0), read from a Cycles bake of the material and from a
   Geometry Nodes attribute: Blender turns the colour into its luminance, not the mean of R, G and B.
2. Socket F-curves with LINEAR extrapolation whose end keys use each interpolation, evaluated before and after their keys: the end
   key's own interpolation decides the slope (CONSTANT is flat, LINEAR follows the neighbour, every other kind follows
   the key's handle).
Run with: blender --background --factory-startup --python tools/blender-addon/tests/blender_node_probes.py -- <folder>"""
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
from margo_export.nodes import graph
from bpy_extras import anim_utils

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 41
scene.render.fps = 24
colors = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 1), (0.2, 0.5, 0.8)]

# Geometry Nodes: Color -> Math Add 0 -> a stored float attribute on one point.
mesh = bpy.data.meshes.new("point")
mesh.from_pydata([(0, 0, 0)], [], [])
point = bpy.data.objects.new("point", mesh)
scene.collection.objects.link(point)
g = bpy.data.node_groups.new("Grayscale", "GeometryNodeTree")
g.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
g.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
gi, go = g.nodes.new("NodeGroupInput"), g.nodes.new("NodeGroupOutput")
store = g.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT"
store.inputs["Name"].default_value = "gray"
gcolor = g.nodes.new("FunctionNodeInputColor")
gmath = g.nodes.new("ShaderNodeMath")
gmath.operation, gmath.inputs[1].default_value = "ADD", 0
g.links.new(gcolor.outputs[0], gmath.inputs[0])
g.links.new(gmath.outputs[0], store.inputs["Value"])
g.links.new(gi.outputs["Geometry"], store.inputs["Geometry"])
g.links.new(store.outputs["Geometry"], go.inputs["Geometry"])
point.modifiers.new("Grayscale", "NODES").node_group = g
geometry = []
for c in colors:
    gcolor.value = (*c, 1)
    bpy.context.view_layer.update()
    evaluated = point.evaluated_get(bpy.context.evaluated_depsgraph_get())
    geometry.append({"color": list(c), "value": evaluated.data.attributes["gray"].data[0].value})

# Shader nodes in Cycles: RGB -> Math Add 0 -> Emission colour, baked to a float image.
scene.render.engine = "CYCLES"
scene.cycles.device, scene.cycles.samples = "CPU", 1
bpy.ops.mesh.primitive_plane_add(size=2)
plane = bpy.context.object
baked = bpy.data.materials.new("Bake")
baked.use_nodes = True
plane.data.materials.append(baked)
t = baked.node_tree
for n in list(t.nodes):
    t.nodes.remove(n)
rgb, add = t.nodes.new("ShaderNodeRGB"), t.nodes.new("ShaderNodeMath")
add.operation, add.inputs[1].default_value = "ADD", 0
emission, out = t.nodes.new("ShaderNodeEmission"), t.nodes.new("ShaderNodeOutputMaterial")
t.links.new(rgb.outputs[0], add.inputs[0])
t.links.new(add.outputs[0], emission.inputs["Color"])
t.links.new(emission.outputs[0], out.inputs["Surface"])
image = bpy.data.images.new("Bake", 4, 4, float_buffer=True)
image.colorspace_settings.name = "Non-Color"
target = t.nodes.new("ShaderNodeTexImage")
target.image = image
t.nodes.active = target
cycles = []
for c in colors:
    rgb.outputs[0].default_value = (*c, 1)
    bpy.ops.object.bake(type="EMIT")
    cycles.append({"color": list(c), "value": image.pixels[0]})
# The bake's three channels carry the same grey: a float socket fans out to all of the emission colour.
assert all(abs(image.pixels[0] - image.pixels[c]) < 1e-7 for c in (1, 2))

# Exported live material: keyed Value nodes summed by Math Add into Roughness, plus the RGB colour into one Add input.
material = bpy.data.materials.new("Probes")
material.use_nodes = True
plane.data.materials.clear()
plane.data.materials.append(material)
tree = material.node_tree
bsdf = tree.nodes.get("Principled BSDF")
cases = [
    ("Constant", ["CONSTANT"] * 3),
    ("LinearBezierConstant", ["LINEAR", "BEZIER", "CONSTANT"]),
    ("ConstantBezierLinear", ["CONSTANT", "BEZIER", "LINEAR"]),
    ("BezierLinearConstant", ["BEZIER", "LINEAR", "CONSTANT"]),
    ("ConstantLinearBezier", ["CONSTANT", "LINEAR", "BEZIER"]),
    ("Sine", ["SINE"] * 3),
    ("Back", ["BACK"] * 3),
    ("TwoLinearConstant", ["LINEAR", "CONSTANT"]),
]
# Keys sit inside the scene range, so the reader (which clamps seeks to the range) extrapolates before and after them.
keys = [(11, 0.0), (21, 1.0), (31, 3.0)]
total = None
nodes = {}
for name, kinds in cases:
    node = tree.nodes.new("ShaderNodeValue")
    node.name = name
    for (frame, value), _ in zip(keys, kinds):
        node.outputs[0].default_value = value
        node.outputs[0].keyframe_insert("default_value", frame=frame)
    nodes[name] = node
    if total is None:
        total = node.outputs[0]
    else:
        m = tree.nodes.new("ShaderNodeMath")
        m.operation = "ADD"
        tree.links.new(total, m.inputs[0])
        tree.links.new(node.outputs[0], m.inputs[1])
        total = m.outputs[0]
tint = tree.nodes.new("ShaderNodeRGB")
tint.name = "Tint"
tint.outputs[0].default_value = (0.2, 0.5, 0.8, 1)
m = tree.nodes.new("ShaderNodeMath")
m.operation = "ADD"
tree.links.new(total, m.inputs[0])
tree.links.new(tint.outputs[0], m.inputs[1])
tree.links.new(m.outputs[0], bsdf.inputs["Roughness"])
bag = anim_utils.action_get_channelbag_for_slot(tree.animation_data.action, tree.animation_data.action_slot)
curves = {}
for name, kinds in cases:
    path = nodes[name].outputs[0].path_from_id("default_value")
    fc = next(f for f in bag.fcurves if f.data_path == path)
    fc.extrapolation = "LINEAR"
    for k, kind in zip(fc.keyframe_points, kinds):
        k.interpolation = kind
    fc.update()
    curves[name] = fc

scene.frame_set(1)
data = graph(bpy.context, material, plane)
assert all("curves" in data["parameters"][f"{name}/outputs/0"] for name, _ in cases)
frames = [1, 6, 11, 31, 36, 41]
truth = [{"seconds": (f - 1) / 24, "values": {f"{name}/outputs/0": [curves[name].evaluate(f)] for name, _ in cases}}
         for f in frames]
(output / "node-probes.json").write_text(json.dumps({
    "blender": bpy.app.version_string, "graph": data, "truth": truth, "geometry": geometry, "cycles": cycles}), encoding="utf-8")
