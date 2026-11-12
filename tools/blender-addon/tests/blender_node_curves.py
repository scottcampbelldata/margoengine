"""CC0 Margo-authored socket F-curves of every exact kind, with Blender's own value at subframes as the black-box truth."""
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
bpy.ops.mesh.primitive_plane_add(size=2)
plane = bpy.context.object
material = bpy.data.materials.new("Curves")
material.use_nodes = True
plane.data.materials.append(material)
tree = material.node_tree
bsdf = tree.nodes.get("Principled BSDF")


def keyed(node_type, name, keys, socket_input):
    node = tree.nodes.new(node_type)
    node.name = name
    for frame, value in keys:
        node.outputs[0].default_value = value
        node.outputs[0].keyframe_insert("default_value", frame=frame)
    tree.links.new(node.outputs[0], socket_input)
    return node


def curve_of(path, index=0):
    bag = anim_utils.action_get_channelbag_for_slot(tree.animation_data.action, tree.animation_data.action_slot)
    return next(f for f in bag.fcurves if f.data_path == path and f.array_index == index)


# One scalar walks through every exact span kind: Bezier with auto handles, free handles past the span, then each easing.
amount = keyed("ShaderNodeValue", "Amount", [(3, 0.1), (8, 0.9), (11, 0.2), (14, 0.6), (17, 0.3), (20, 0.8), (23, 0.4),
                                           (26, 0.7), (29, 0.2), (32, 0.9), (35, 0.5)], bsdf.inputs["Roughness"])
fc = curve_of(amount.outputs[0].path_from_id("default_value"))
fc.extrapolation = "LINEAR"
kinds = [None, None, ("SINE", "AUTO"), ("EXPO", "EASE_IN_OUT"), ("BACK", "EASE_IN_OUT"), ("BOUNCE", "AUTO"),
         ("CIRC", "EASE_OUT"), ("QUINT", "EASE_IN"), ("CONSTANT", None), ("LINEAR", None)]
for n, kind in enumerate(kinds):
    k = fc.keyframe_points[n]
    if kind:
        k.interpolation = kind[0]
        if kind[1]:
            k.easing = kind[1]
k = fc.keyframe_points[1]
k.handle_right_type = "FREE"
k.handle_right = (14.0, 1.6)
k = fc.keyframe_points[2]
k.handle_left_type = "FREE"
k.handle_left = (6.0, -0.4)
fc.keyframe_points[4].back = 2.5
fc.update()
# A colour with Bezier keys and constant extrapolation on red, linear on green; blue stays still.
color = tree.nodes.new("ShaderNodeRGB")
color.name = "Tint"
color.outputs[0].default_value = (0.2, 0.3, 0.4, 1)
for frame, r, g in ((5, 0.2, 0.9), (18, 0.8, 0.1), (30, 0.4, 0.5)):
    color.outputs[0].default_value[0] = r
    color.outputs[0].default_value[1] = g
    color.outputs[0].keyframe_insert("default_value", index=0, frame=frame)
    color.outputs[0].keyframe_insert("default_value", index=1, frame=frame)
tree.links.new(color.outputs[0], bsdf.inputs["Base Color"])
# Green extrapolates linearly from a linear end key: the slope of its last span, not of a handle.
green = curve_of(color.outputs[0].path_from_id("default_value"), 1)
green.extrapolation = "LINEAR"
for k in green.keyframe_points:
    k.interpolation = "LINEAR"
green.update()
# Elastic spans (KB5339c): every easing, amplitude below, at and above the change, default, short and negative periods.
spring = keyed("ShaderNodeValue", "Spring", [(1, 0.0), (9, 1.0), (17, 0.2), (25, 0.9), (29, 0.9), (33, 0.4), (41, 0.5)],
               bsdf.inputs["Metallic"])
sc = curve_of(spring.outputs[0].path_from_id("default_value"))
for n, (easing, amplitude, period) in enumerate([("EASE_IN", 0.0, 0.0), ("EASE_OUT", 0.3, 3.0), ("EASE_IN_OUT", 2.0, 4.0),
                                                 ("AUTO", 0.25, 2.0), ("EASE_IN", 0.5, -2.5), ("EASE_IN_OUT", 0.05, 0.0)]):
    k = sc.keyframe_points[n]
    k.interpolation, k.easing, k.amplitude, k.period = "ELASTIC", easing, amplitude, period
sc.update()

scene.frame_set(1)
data = graph(bpy.context, material, plane)
keys = ["Amount/outputs/0", "Tint/outputs/0", "Spring/outputs/0"]
assert all("curves" in data["parameters"][key] for key in keys)
truth = []
for step in range(0, 40 * 8 + 1):
    frame = 1 + step / 8
    scene.frame_set(int(frame), subframe=frame - int(frame))
    truth.append({"seconds": (frame - 1) / 24, "values": {
        "Amount/outputs/0": [amount.outputs[0].default_value],
        "Tint/outputs/0": list(color.outputs[0].default_value),
        "Spring/outputs/0": [spring.outputs[0].default_value],
    }})
(output / "node-curves.json").write_text(json.dumps({"graph": data, "truth": truth}), encoding="utf-8")
