"""Run only in a separate factory-startup/background Blender process: an armature, a skinned and shape-keyed mesh and
three actions, exported to anim.margo, plus Blender's own deformed vertices per clip and frame in anim-truth.json.
The two files are packages/blender/tests/fixtures/anim.margo and anim-truth.json (Blender 5.2.3 LTS)."""
from pathlib import Path
import importlib.util
import json
import math
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
scene.render.fps = 24

# A tube of 6 rings x 8 vertices along +Z, with a UV map so the PBR vertex layout and tangents are used.
rings, sides = 6, 8
verts = [(0.3 * math.cos(2 * math.pi * s / sides), 0.3 * math.sin(2 * math.pi * s / sides), 2 * r / (rings - 1)) for r in range(rings) for s in range(sides)]
faces = [(r * sides + s, r * sides + (s + 1) % sides, (r + 1) * sides + (s + 1) % sides, (r + 1) * sides + s) for r in range(rings - 1) for s in range(sides)]
mesh = bpy.data.meshes.new("Tube")
mesh.from_pydata(verts, [], faces)
uv = mesh.uv_layers.new(name="UVMap")
for poly in mesh.polygons:
    for corner, loop in enumerate(poly.loop_indices):
        v = mesh.loops[loop].vertex_index
        uv.data[loop].uv = ((v % sides) / sides + 0.01 * corner, (v // sides) / rings)
tube = bpy.data.objects.new("Tube", mesh)
scene.collection.objects.link(tube)
tube.location = (0.5, 2.0, 0.25)
tube.rotation_euler = (0.2, 0, 0.4)
tube.scale = (1.2, 1.2, 1.2)
tube["margo:character"] = "hero"

armature_data = bpy.data.armatures.new("Rig")
rig = bpy.data.objects.new("Rig", armature_data)
scene.collection.objects.link(rig)
rig.location = (0.4, 1.8, 0.1)
rig.rotation_euler = (0.1, 0, 0.3)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
root = armature_data.edit_bones.new("Root")
root.head, root.tail = (0, 0, 0), (0, 0, 1.1)
tip = armature_data.edit_bones.new("Tip")
tip.head, tip.tail = (0, 0, 1.1), (0, 0, 2.4)
tip.parent = root
tip.use_connect = True
bpy.ops.object.mode_set(mode="OBJECT")

groups = {name: tube.vertex_groups.new(name=name) for name in ("Root", "Tip")}
for v in mesh.vertices:
    t = min(1, max(0, (v.co.z - 0.6) / 0.9))
    if t < 1:
        groups["Root"].add([v.index], 1 - t, "REPLACE")
    if t > 0:
        groups["Tip"].add([v.index], t * 0.5, "REPLACE")  # unnormalised on purpose: Blender normalises the sum
modifier = tube.modifiers.new("Armature", "ARMATURE")
modifier.object = rig

key = tube.shape_key_add(name="Basis")
bulge = tube.shape_key_add(name="Bulge")
for i, point in enumerate(bulge.data):
    if i >= (rings - 1) * sides:
        point.co.x *= 1.6
        point.co.y *= 1.6
bulge.value = 0.25


def keyed(owner, name, frames):
    owner.animation_data_create()
    action = bpy.data.actions.new(name)
    owner.animation_data.action = action
    for frame, setter, paths in frames:
        scene.frame_set(frame)
        for target, path in paths:
            setter()
            target.keyframe_insert(path, frame=frame)
    return action


bones = rig.pose.bones
for b in bones:
    b.rotation_mode = "QUATERNION"


def pose(root_z, tip_angle):
    def apply():
        bones["Root"].location = (0, root_z, 0)
        bones["Tip"].rotation_quaternion = (math.cos(tip_angle / 2), math.sin(tip_angle / 2), 0, 0)
    return apply


bend = keyed(rig, "Bend", [(f, pose(0.1 * f / 20, 1.2 * f / 20), [(bones["Root"], "location"), (bones["Tip"], "rotation_quaternion")]) for f in (1, 10, 20)])
twist = bpy.data.actions.new("Twist")
rig.animation_data.action = twist
for frame, angle in ((1, 0.0), (12, 0.9)):
    bones["Root"].rotation_quaternion = (math.cos(angle / 2), 0, 0, math.sin(angle / 2))
    bones["Root"].keyframe_insert("rotation_quaternion", frame=frame)
rig.animation_data.action = None
track = rig.animation_data.nla_tracks.new()
track.strips.new("Twist", 1, twist)
rig.animation_data.action = bend
breathe = bpy.data.actions.new("Breathe")
mesh.shape_keys.animation_data_create()
mesh.shape_keys.animation_data.action = breathe
for frame, value in ((1, 0.0), (8, 1.0)):
    bulge.value = value
    bulge.keyframe_insert("value", frame=frame)

scene.frame_set(5)
export_scene(bpy.context, output / "anim.margo")


def world_points():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = tube.evaluated_get(depsgraph)
    data = evaluated.to_mesh()
    s = scene.unit_settings.scale_length
    points = []
    for v in data.vertices:
        p = evaluated.matrix_world @ v.co
        points.append([p.x * s, p.z * s, -p.y * s])
    evaluated.to_mesh_clear()
    return points


# Blender's own answer for each clip: that action alone on its owner, NLA off, everything else as shown at export.
truth = {"rest": [[v.co.x, v.co.z, -v.co.y] for v in key.data], "clips": {}}
shown = [(b, n, tuple(getattr(b, n))) for b in bones for n in ("location", "rotation_quaternion", "scale")] + [(bulge, "value", bulge.value)]
for name, owner_action in (("Bend", (bend, None)), ("Twist", (twist, None)), ("Breathe", (None, breathe))):
    for target, attr, value in shown:
        setattr(target, attr, value)
    rig.animation_data.use_nla = False
    mesh.shape_keys.animation_data.use_nla = False
    rig.animation_data.action = owner_action[0]
    mesh.shape_keys.animation_data.action = owner_action[1]
    action = owner_action[0] or owner_action[1]
    start, end = (int(round(v)) for v in action.frame_range)
    frames = {}
    for f in range(start, end + 1):
        scene.frame_set(f)
        frames[str((f - start) / 24)] = world_points()
    truth["clips"][name] = frames
rounded = lambda points: [[round(x, 6) for x in p] for p in points]
truth = {"rest": rounded(truth["rest"]), "clips": {k: {s: rounded(v) for s, v in frames.items()} for k, frames in truth["clips"].items()}}
(output / "anim-truth.json").write_text(json.dumps(truth, separators=(",", ":")))
print("Margo animated export:", (output / "anim.margo").stat().st_size, "bytes;", bpy.app.version_string)
