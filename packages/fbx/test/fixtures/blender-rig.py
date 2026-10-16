# SPDX-License-Identifier: CC0-1.0
# Original Margo Engine DCC test asset. Run with Blender 5.3:
# blender --background --factory-startup --python blender-rig.py -- /absolute/path/blender-rig.fbx
from pathlib import Path
import math
import sys

import bpy
from io_scene_fbx import export_fbx_bin
from mathutils import Matrix

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.name = 'Bend'
scene.render.fps = 24
scene.frame_start = 0
scene.frame_end = 24
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0

# Three closed tapered fan blades, each rigidly weighted to its own control.
# The controls share a world-space origin and rest orientation, as the three
# rotating shafts in a mechanical rig do. This keeps every TransformLink at
# identity and avoids requiring the importer's unsupported bind conventions.
vertices, faces = [], []
blade = [(-.14, .35, -.08), (.14, .35, -.08), (.32, 2, -.08), (-.32, 2, -.08),
         (-.14, .35, .08), (.14, .35, .08), (.32, 2, .08), (-.32, 2, .08)]
for index in range(3):
    angle = index * math.tau / 3
    c, s = math.cos(angle), math.sin(angle)
    vertices.extend((c*x - s*y - 1, s*x + c*y, z) for x, y, z in blade)
    offset = index * 8
    faces.extend(tuple(offset + k for k in face) for face in
                 ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
                  (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)))
mesh = bpy.data.meshes.new('FanMesh')
mesh.from_pydata(vertices, [], faces)
mesh.update()
fan = bpy.data.objects.new('Fan', mesh)
scene.collection.objects.link(fan)
# Deliberately nonidentity mesh bind space makes all sixteen matrix components
# worth checking: Transform = translation(+1, 0, 0), TransformLink = identity.
fan.location = (1, 0, 0)
material = bpy.data.materials.new('Blue')
material.diffuse_color = (.12, .45, .8, 1)
fan.data.materials.append(material)

armature = bpy.data.armatures.new('FanRig')
rig = bpy.data.objects.new('Rig', armature)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
base = None
for name in ('Base', 'Middle', 'Tip'):
    bone = armature.edit_bones.new(name)
    bone.head = (0, 0, 0)
    bone.tail = (0, 1, 0)
    if base:
        bone.parent = base
        bone.use_connect = False
    else:
        base = bone
bpy.ops.object.mode_set(mode='OBJECT')

for index, name in enumerate(('Base', 'Middle', 'Tip')):
    fan.vertex_groups.new(name=name).add(list(range(index*8, index*8+8)), 1, 'REPLACE')
modifier = fan.modifiers.new('Skin', 'ARMATURE')
modifier.object = rig
fan.parent = rig

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

# Check the authored bind pose through Blender's evaluated armature modifier.
# The importer test independently checks the converted bind palette is identity.
for bone in rig.pose.bones:
    assert all(abs(bone.matrix[row][col] - Matrix.Identity(4)[row][col]) < 1e-6
               for row in range(4) for col in range(4))
evaluated = fan.evaluated_get(bpy.context.evaluated_depsgraph_get())
for original, deformed in zip(fan.data.vertices, evaluated.data.vertices):
    assert (original.co - deformed.co).length < 1e-6

# Blender's legacy FBX exporter hardcodes RSrs (InheritType=1). Request RrSs
# while the exporter constructs the file. The two modes are equivalent here:
# every object and bone has unit scale throughout the animation. No FBX bytes,
# cluster matrices, or curve data are rewritten after the exporter runs.
original_set = export_fbx_bin.elem_props_template_set
def uniform_scale_inheritance(template, props, ptype, name, value, *args, **kwargs):
    if name == b'InheritType':
        value = 0
    return original_set(template, props, ptype, name, value, *args, **kwargs)
export_fbx_bin.elem_props_template_set = uniform_scale_inheritance
assert all(tuple(obj.scale) == (1, 1, 1) for obj in (rig, fan))
assert all(tuple(bone.scale) == (1, 1, 1) for bone in rig.pose.bones)

output = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
bpy.ops.export_scene.fbx(
    filepath=str(output), use_selection=False, object_types={'ARMATURE', 'MESH'},
    axis_forward='Y', axis_up='Z', apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_ALL', add_leaf_bones=False,
    use_armature_deform_only=True, bake_anim=True,
    bake_anim_use_all_bones=False, bake_anim_use_nla_strips=False,
    bake_anim_use_all_actions=False, bake_anim_step=1,
    bake_anim_simplify_factor=0, bake_anim_force_startend_keying=True,
    use_mesh_modifiers=False, mesh_smooth_type='OFF', path_mode='AUTO',
)
print('EXPORTED', output)
