# Opens a binary FBX written by exportFBX in Blender's own importer and prints what landed: each camera and light with
# where it stands, where it points and its settings, as JSON. Blender's importer shares no code with ours.
# blender --background --factory-startup --python blender-read-export.py -- /absolute/file.fbx /absolute/out.json
import json
import math
import sys

import bpy
from mathutils import Vector

source, target = sys.argv[sys.argv.index("--") + 1 :]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=source)
bpy.context.view_layer.update()
scene = bpy.context.scene
out = []
for item in bpy.data.objects:
    if item.type not in {"CAMERA", "LIGHT"}:
        continue
    world = item.matrix_world
    # Blender's cameras and lights both look down their own -Z, with +Y up.
    forward = (world.to_3x3() @ Vector((0, 0, -1))).normalized()
    up = (world.to_3x3() @ Vector((0, 1, 0))).normalized()
    row = {
        "name": item.name,
        "type": item.type,
        "at": list(world.translation),
        "forward": list(forward),
        "up": list(up),
    }
    data = item.data
    if item.type == "CAMERA":
        row.update(
            kind=data.type,
            near=data.clip_start,
            far=data.clip_end,
            lens=data.lens,
            sensor=[data.sensor_width, data.sensor_height],
            sensorFit=data.sensor_fit,
            yfov=data.angle_y,
            xfov=data.angle_x,
            orthoScale=data.ortho_scale,
        )
    else:
        row.update(kind=data.type, color=list(data.color), energy=data.energy)
        if data.type == "SPOT":
            row.update(spotSize=data.spot_size, spotBlend=data.spot_blend)
    out.append(row)
with open(target, "w", encoding="utf8") as file:
    json.dump({"unit": scene.unit_settings.scale_length, "objects": out}, file, indent=1)
