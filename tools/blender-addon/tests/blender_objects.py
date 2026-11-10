"""CC0 Margo-authored scene; evaluated Blender worlds are the oracle, never exporter maths."""
from pathlib import Path
import importlib.util
import json
import sys
import bpy
from mathutils import Matrix

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
scene.unit_settings.scale_length = 0.1

def empty(name):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    return obj

pivot = empty("Pivot")
pivot.location = (2, -1, 0)
pivot.rotation_euler = (0.2, 0, 0.5)
pivot.scale = (2, 1, 0.75)
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
cube.name = "Child"
cube.parent = pivot
cube.matrix_parent_inverse = Matrix.Translation((0.5, 0.3, -0.2))
cube.location = (1, 0, 0.5)
cube.scale = (-1, 1, 1)
cube["margo:label"] = "kept"
grandchild = empty("Grandchild")
grandchild.parent = cube
grandchild.location = (0, 0, 3)
target = empty("Target")
target.location = (4, 3, 2)
constraint = grandchild.constraints.new("COPY_LOCATION")
constraint.target = target
constraint.influence = 0.25
# Parent may be hidden while its child stays visible.
pivot.hide_set(True)
for obj, path, first, last in (
    (pivot, "location", (2, -1, 0), (5, 1, 2)),
    (cube, "rotation_euler", (0, 0, 0), (0.4, 0, 0.8)),
    (target, "location", (4, 3, 2), (0, 1, 4)),
):
    setattr(obj, path, first)
    obj.keyframe_insert(path, frame=1)
    setattr(obj, path, last)
    obj.keyframe_insert(path, frame=9)
    obj.animation_data.action.name = obj.name + "Action"
    for layer in obj.animation_data.action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"
# Preserve an NLA-only alternate action and its slot.
cube.keyframe_insert("scale", frame=1)
cube.scale = (-1.2, 0.8, 1)
cube.keyframe_insert("scale", frame=9)
scene.frame_set(3, subframe=0.25)
saved = [(obj, obj.animation_data.action, obj.animation_data.action_slot, obj.animation_data.use_nla) for obj in (pivot, cube, target)]
export_scene(bpy.context, output / "objects.margo", object_animation=True, lights_cameras=False)
assert scene.frame_current == 3 and scene.frame_subframe == 0.25
for obj, action, slot, nla in saved:
    assert obj.animation_data.action == action and obj.animation_data.action_slot == slot and obj.animation_data.use_nla == nla

basis = Matrix.Rotation(-1.5707963267948966, 4, "X")
objects = (pivot, cube, grandchild, target)
defaults = {obj.name: (obj.location.copy(), obj.rotation_euler.copy(), obj.scale.copy()) for obj in objects}
truth = {"clips": {}, "parents": {obj.name: obj.parent.name if obj.parent else None for obj in objects}}
for owner, action, slot, _ in saved:
    for obj, _, _, _ in saved:
        obj.animation_data.action = None
        obj.animation_data.use_nla = False
    for obj in objects:
        obj.location, obj.rotation_euler, obj.scale = defaults[obj.name]
    owner.animation_data.action = action
    owner.animation_data.action_slot = slot
    samples = []
    for frame in range(1, 10):
        scene.frame_set(frame)
        worlds = {}
        for obj in objects:
            matrix = basis @ obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world @ basis.inverted()
            matrix.translation *= scene.unit_settings.scale_length
            worlds[obj.name] = [matrix[r][c] for c in range(4) for r in range(4)]
        samples.append(worlds)
    truth["clips"][action.name] = samples
(output / "objects-truth.json").write_text(json.dumps(truth), encoding="utf-8")
# A shear-free local hierarchy with a sheared world is valid. A true local shear must fail, not be flattened.
cube.matrix_parent_inverse = Matrix(((1, 0.4, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
try:
    export_scene(bpy.context, output / "bad.margo", object_animation=True, lights_cameras=False)
except ValueError as error:
    assert "shear/singular" in str(error)
else:
    raise AssertionError("local shear must fail")
print("MARGO_OBJECTS_OK")
