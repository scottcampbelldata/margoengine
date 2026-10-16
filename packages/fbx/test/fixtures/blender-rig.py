# SPDX-License-Identifier: CC0-1.0
# Original Margo Engine test asset. Run with Blender 5.3:
# blender --background --factory-startup --python blender-rig.py -- /absolute/path/blender-rig.fbx
from pathlib import Path
import math
import sys

import bpy
from io_scene_fbx import export_fbx_bin

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.name = 'Bend'
scene.render.fps = 24
scene.frame_start = 0
scene.frame_end = 24
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0

# A closed, seven-ring octagonal column: 56 control points and 50 faces.
# Intermediate rings blend adjacent joint weights to make deformation visible.
vertices = [(0.25 * math.cos(k * math.pi / 4), 0.25 * math.sin(k * math.pi / 4), z / 2)
            for z in range(7) for k in range(8)]
faces = [tuple(reversed(range(8)))]
faces += [(ring * 8 + k, ring * 8 + (k + 1) % 8,
           (ring + 1) * 8 + (k + 1) % 8, (ring + 1) * 8 + k)
          for ring in range(6) for k in range(8)]
faces += [tuple(range(48, 56))]
mesh = bpy.data.meshes.new('ColumnMesh')
mesh.from_pydata(vertices, [], faces)
mesh.update()
column = bpy.data.objects.new('Column', mesh)
scene.collection.objects.link(column)
material = bpy.data.materials.new('Blue')
material.diffuse_color = (0.12, 0.45, 0.8, 1)
column.data.materials.append(material)

armature = bpy.data.armatures.new('ColumnRig')
rig = bpy.data.objects.new('Rig', armature)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
previous = None
for index, name in enumerate(('Base', 'Middle', 'Tip')):
    bone = armature.edit_bones.new(name)
    bone.head = (0, 0, index)
    bone.tail = (0, 0, index + 1)
    if previous:
        bone.parent = previous
        bone.use_connect = True
    previous = bone
bpy.ops.object.mode_set(mode='OBJECT')

for index, name in enumerate(('Base', 'Middle', 'Tip')):
    group = column.vertex_groups.new(name=name)
    for vertex, (_, _, z) in enumerate(vertices):
        weight = max(0, 1 - abs(z - index)) if z < 2 else float(index == 2)
        if weight:
            group.add([vertex], weight, 'REPLACE')
modifier = column.modifiers.new('Skin', 'ARMATURE')
modifier.object = rig
column.parent = rig

for name, degrees in (('Middle', 90), ('Tip', -45)):
    bone = rig.pose.bones[name]
    bone.rotation_mode = 'XYZ'
    for frame, angle in ((0, 0), (24, math.radians(degrees))):
        bone.rotation_euler = (0, 0, angle)
        bone.keyframe_insert(data_path='rotation_euler', frame=frame)
action = rig.animation_data.action
action.name = 'Bend'
for layer in action.layers:
    for strip in layer.strips:
        for channelbag in strip.channelbags:
            for curve in channelbag.fcurves:
                for keyframe in curve.keyframe_points:
                    keyframe.interpolation = 'LINEAR'
scene.frame_set(0)

# Blender's legacy FBX exporter hardcodes RSrs (InheritType=1). Request RrSs
# while the exporter constructs the file. The two modes are equivalent for
# this asset: every object and bone has unit scale throughout its animation.
# This changes exporter configuration only; no FBX bytes are patched afterward.
original_set = export_fbx_bin.elem_props_template_set
def uniform_scale_inheritance(template, props, ptype, name, value, *args, **kwargs):
    if name == b'InheritType':
        value = 0
    return original_set(template, props, ptype, name, value, *args, **kwargs)
export_fbx_bin.elem_props_template_set = uniform_scale_inheritance
assert all(tuple(obj.scale) == (1, 1, 1) for obj in (rig, column))
assert all(tuple(bone.scale) == (1, 1, 1) for bone in rig.pose.bones)

output = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
bpy.ops.export_scene.fbx(
    filepath=str(output), use_selection=False, object_types={'ARMATURE', 'MESH'},
    axis_forward='-Z', axis_up='Y', apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_ALL', add_leaf_bones=False,
    use_armature_deform_only=True, bake_anim=True,
    bake_anim_use_all_bones=False, bake_anim_use_nla_strips=False,
    bake_anim_use_all_actions=False, bake_anim_step=1,
    bake_anim_simplify_factor=0, bake_anim_force_startend_keying=True,
    use_mesh_modifiers=False, mesh_smooth_type='OFF', path_mode='AUTO',
)
print('EXPORTED', output)
