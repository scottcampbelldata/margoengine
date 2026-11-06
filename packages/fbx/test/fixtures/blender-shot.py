# Authors the shot fixture: a cube, two cameras and four lights, exported through Blender's own FBX exporter.
# Usage: blender --background --factory-startup --python blender-shot.py -- <folder>
# Writes blender-shot.fbx (default axes, Y up) and blender-shot-zup.fbx (Z up). CC0, see README.md.
import json
import math
import sys
from pathlib import Path

import bpy
from io_scene_fbx import export_fbx_bin
from mathutils import Vector

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def link(obj):
    scene.collection.objects.link(obj)
    return obj


bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
bpy.context.object.name = 'Box'

rig = link(bpy.data.objects.new('CameraRig', None))
rig.location = (1, -2, 0)

lens = bpy.data.cameras.new('LensData')
lens.lens = 35
lens.sensor_width = 36
lens.sensor_fit = 'HORIZONTAL'
lens.clip_start = 0.25
lens.clip_end = 250
hero = link(bpy.data.objects.new('Hero', lens))
hero.parent = rig
hero.location = (4, -6, 3)
hero.rotation_euler = (math.radians(70), 0, math.radians(35))

flat = bpy.data.cameras.new('FlatData')
flat.type = 'ORTHO'
flat.ortho_scale = 8
flat.clip_start = 0.5
flat.clip_end = 90
top = link(bpy.data.objects.new('Top', flat))
top.location = (0, 0, 20)

point = bpy.data.lights.new('BulbData', 'POINT')
point.energy = 250
point.color = (1, 0.5, 0.25)
link(bpy.data.objects.new('Bulb', point)).location = (3, 2, 4)

sun = bpy.data.lights.new('SunData', 'SUN')
sun.energy = 3
sun.color = (1, 1, 0.75)
sky = link(bpy.data.objects.new('Sky', sun))
sky.rotation_euler = (math.radians(40), 0, math.radians(120))

spot = bpy.data.lights.new('SpotData', 'SPOT')
spot.energy = 800
spot.spot_size = math.radians(60)
spot.spot_blend = 0.5
beam = link(bpy.data.objects.new('Beam', spot))
beam.location = (-3, -3, 6)
beam.rotation_euler = (math.radians(30), math.radians(-20), 0)

area = bpy.data.lights.new('PanelData', 'AREA')
area.energy = 100
link(bpy.data.objects.new('Panel', area)).location = (0, 4, 3)

# The hero camera dollies over one second.
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 25
hero.keyframe_insert('location', frame=1)
hero.location = (5, -6, 3)
hero.keyframe_insert('location', frame=25)
scene.frame_set(1)
bpy.context.view_layer.update()

# Ground truth in Blender's own axes, read from the evaluated scene.
truth = {}
for obj in (hero, top, beam, sky):
    world = obj.matrix_world
    truth[obj.name] = {
        'position': list(world.translation),
        'forward': list((world.to_3x3() @ Vector((0, 0, -1))).normalized()),
        'up': list((world.to_3x3() @ Vector((0, 1, 0))).normalized()),
    }
truth['Hero']['yfov'] = 2 * math.atan(math.tan(lens.angle_x / 2) * 1080 / 1920)
truth['Top']['xmag'] = flat.ortho_scale / 2
for data in (point, sun, spot, area):
    truth[data.name] = {'color': list(data.color), 'energy': data.energy}
truth['SpotData']['outer'] = spot.spot_size / 2
truth['SpotData']['inner'] = spot.spot_size / 2 * (1 - spot.spot_blend)
(folder / 'blender-shot.json').write_text(json.dumps(truth, indent=1) + '\n')

# The exporter hardcodes InheritType 1, which this fixture does not exercise: every object here has unit scale, where
# the modes agree. Same step as blender-rig.py, made while the exporter builds the file; no bytes are changed after it.
original_set = export_fbx_bin.elem_props_template_set


def uniform_scale_inheritance(template, props, ptype, name, value, *args, **kwargs):
    if name == b'InheritType':
        value = 0
    return original_set(template, props, ptype, name, value, *args, **kwargs)


export_fbx_bin.elem_props_template_set = uniform_scale_inheritance
for name, forward, up in (('blender-shot.fbx', '-Z', 'Y'), ('blender-shot-zup.fbx', 'Y', 'Z')):
    bpy.ops.export_scene.fbx(
        filepath=str(folder / name), use_selection=False, object_types={'MESH', 'CAMERA', 'LIGHT', 'EMPTY'},
        axis_forward=forward, axis_up=up, apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',
        bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
        bake_anim_force_startend_keying=True, bake_anim_step=1, bake_anim_simplify_factor=0,
    )
