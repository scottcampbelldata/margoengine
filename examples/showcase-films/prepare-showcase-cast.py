"""Convert licensed Rocketbox actors and motion to glTF with Blender."""

import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector


ROOT = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
ASSETS = ROOT / "rocketbox" / "Assets"
ACTORS = (
    "Business_Male_02", "Business_Male_07", "Business_Female_01", "Business_Female_03",
    "Business_Male_01", "Business_Male_05", "Business_Female_02", "Business_Female_04",
)


def import_fbx(path, animate):
    old = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(path), use_anim=animate, use_image_search=False)
    objects = set(bpy.data.objects) - old
    return next(o for o in objects if o.type == "ARMATURE"), objects


def cast_materials(mesh, folder, atlas_path=None):
    files = {path.name: path for path in folder.glob("*.tga")}
    bases = []
    for material in mesh.data.materials:
        name = material.name.split(".")[0]
        color_file = files.get(name + "_color.tga")
        if color_file:
            color = bpy.data.images.load(str(color_file))
            color.scale(1024, 1024)
        elif name.endswith("_glasses"):
            color = bpy.data.images.new(name, 1024, 1024)
            swatch = np.tile(np.array([.17, .14, .11, 1.0], dtype=np.float32), 1024 * 1024)
            color.pixels.foreach_set(swatch)
        else:
            raise ValueError(f"Missing photographic texture for {name}")
        bases.append(color)
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        links = material.node_tree.links
        shader = nodes.new("ShaderNodeBsdfPrincipled")
        shader.inputs["Roughness"].default_value = 0.68 if "head" not in name else 0.55
        output = nodes.new("ShaderNodeOutputMaterial")
        links.new(shader.outputs[0], output.inputs[0])
        image = nodes.new("ShaderNodeTexImage")
        image.image = color
        links.new(image.outputs["Color"], shader.inputs["Base Color"])
        if "opacity" in name:
            links.new(image.outputs["Alpha"], shader.inputs["Alpha"])
        normal_file = files.get(name + "_normal.tga")
        if normal_file and atlas_path is None:
            normal = nodes.new("ShaderNodeTexImage")
            normal.image = bpy.data.images.load(str(normal_file))
            normal.image.colorspace_settings.name = "Non-Color"
            normal.image.scale(1024, 1024)
            decode = nodes.new("ShaderNodeNormalMap")
            decode.inputs["Strength"].default_value = 0.58
            links.new(normal.outputs["Color"], decode.inputs["Color"])
            links.new(decode.outputs[0], shader.inputs["Normal"])

    if atlas_path is None:
        return
    tile = 1024
    tiles = math.ceil(math.sqrt(len(bases)))
    atlas = bpy.data.images.new("Wardrobe atlas", tile * tiles, tile * tiles, alpha=False)
    pixels = np.zeros((tile * tiles, tile * tiles, 4), dtype=np.float32)
    pixels[:, :, :3] = 0.066
    pixels[:, :, 3] = 1.0
    uv = mesh.data.uv_layers.active.data
    for index, color in enumerate(bases):
        source = np.empty(tile * tile * 4, dtype=np.float32)
        color.pixels.foreach_get(source)
        source = source.reshape(tile, tile, 4)
        row, col = divmod(index, tiles)
        # Hair-card edges take the model's hair tone on the opaque crowd path.
        rgb = source[:, :, :3] * source[:, :, 3:] + 0.052 * (1 - source[:, :, 3:])
        pixels[row*tile:(row+1)*tile, col*tile:(col+1)*tile, :3] = rgb
        for face in mesh.data.polygons:
            if face.material_index == index:
                for loop in face.loop_indices:
                    u, v = uv[loop].uv
                    uv[loop].uv = ((col + max(0.002, min(0.998, u))) / tiles, (row + max(0.002, min(0.998, v))) / tiles)
    atlas.pixels.foreach_set(pixels.ravel())
    atlas.filepath_raw = str(atlas_path)
    atlas.file_format = "PNG"
    atlas.save()
    for face in mesh.data.polygons:
        face.material_index = 0
    mesh.data.materials.clear()
    mesh.data.materials.append(bpy.data.materials.new("Crowd wardrobe"))


def sample_motion(path, max_frames=None):
    source, garbage = import_fbx(path, True)
    action = source.animation_data.action
    start, end = map(int, action.frame_range)
    end = min(end, start + max_frames) if max_frames else end
    frames = []
    z = []
    for i in range(start, end + 1):
        bpy.context.scene.frame_set(i)
        frames.append({bone.name: bone.matrix.to_quaternion() for bone in source.pose.bones})
        z.append(source.matrix_world.translation.z)
    for o in garbage:
        bpy.data.objects.remove(o, do_unlink=True)
    return frames, np.asarray(z) - np.mean(z)


def apply_body(rig, orientation, vertical, height):
    rig.location.z = height + vertical
    posed = {}
    for bone in rig.pose.bones:
        anchor = bone.bone.matrix_local.copy()
        if bone.parent:
            anchor = posed[bone.parent.name] @ bone.parent.bone.matrix_local.inverted() @ anchor
        if bone.name in orientation:
            rotation = orientation[bone.name]
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = anchor.to_quaternion().inverted() @ rotation
            posed[bone.name] = Matrix.Translation(anchor.translation) @ rotation.to_matrix().to_4x4()
        else:
            posed[bone.name] = anchor


def key_pose(rig, frame):
    rig.keyframe_insert(data_path="location", frame=frame)
    for bone in rig.pose.bones:
        if bone.rotation_mode == "QUATERNION":
            bone.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=bone.name)


def animate_crowd(rig, prefix):
    height = rig.location.z
    for name, motion, limit in [
        ("Stand", f"all_animations_max_motextr_static/{prefix}_idle_neutral_01.max.fbx", 90),
        ("Walk", f"all_animations_max_motextr_xy/{prefix}_walk_neutral_01.max.fbx", None),
    ]:
        orientations, heights = sample_motion(ASSETS / "Animations" / motion, limit)
        rig.animation_data_create()
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        for i, (pose, z) in enumerate(zip(orientations, heights)):
            apply_body(rig, pose, float(z) * 0.78, height)
            key_pose(rig, i + 1)
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
    bpy.context.scene.frame_set(1)


def aim(bone, source, target):
    direction = (source - bone.head).normalized()
    goal = (target - bone.head).normalized()
    swing = direction.rotation_difference(goal)
    bone.matrix = Matrix.Translation(bone.head) @ (swing @ bone.matrix.to_quaternion()).to_matrix().to_4x4()
    bpy.context.view_layer.update()


def place_wrist(rig, side, target, contact=None):
    # Film world is Y-up. The actor stands at x=.83, z=.08 and faces -X.
    x, y, z = target
    w = Vector((z - 0.08, x - 0.83, y))
    upper, lower, hand = [rig.pose.bones[f"Bip01 {side} {name}"] for name in ("UpperArm", "Forearm", "Hand")]
    to_rig = rig.matrix_world.inverted()
    wrist = to_rig @ w
    fingertip = rig.pose.bones[f"Bip01 {side} Finger12"]
    pinch = None
    if contact is not None:
        cx, cy, cz = contact
        pinch = to_rig @ Vector((cz - 0.08, cx - 0.83, cy))
        axis = (to_rig.to_3x3() @ Vector((0.14, 1, -0.11))).normalized()
        wrist = pinch + axis * (fingertip.head - hand.head).length
    shoulder = upper.head.copy()
    length_a = (lower.head - shoulder).length
    length_b = (hand.head - lower.head).length
    delta = wrist - shoulder
    axis = delta.normalized()
    length = min(delta.length, (length_a + length_b) * 0.994)
    pole = to_rig.to_3x3() @ Vector((-0.12 if side == "L" else 0.16, 0.1, -1.0))
    pole = (pole - axis * pole.dot(axis)).normalized()
    along = (length * length + length_a * length_a - length_b * length_b) / (2 * length)
    elbow = shoulder + axis * along + pole * math.sqrt(max(0, length_a * length_a - along * along))
    aim(upper, lower.head.copy(), elbow)
    aim(lower, hand.head.copy(), shoulder + axis * length)
    if pinch is not None:
        aim(hand, fingertip.head.copy(), pinch)
        thumb = rig.pose.bones[f"Bip01 {side} Finger0"]
        thumb_tip = rig.pose.bones[f"Bip01 {side} Finger02"]
        aim(thumb, thumb_tip.head.copy(), fingertip.head)


def smooth_path(keys, seconds):
    for (a, first), (b, last) in zip(keys, keys[1:]):
        if seconds <= b:
            t = max(0.0, (seconds - a) / (b - a))
            return Vector(first).lerp(Vector(last), t*t*(3-2*t))
    return Vector(keys[-1][1])


RIGHT = [(0, (0.75, 1.03, -0.14)), (5, (0.7, 1.15, -0.11)), (10, (0.54, 1.53, -0.07)),
         (15, (0.48, 1.67, 0.09)), (21, (0.47, 1.81, -0.04)), (26, (0.47, 1.64, -0.015)),
         (31, (0.48, 1.53, -0.11)), (34, (0.51, 1.44, -0.12)), (39, (0.45, 1.62, -0.16)),
         (42, (0.45, 1.61, -0.16)), (46, (0.50, 1.23, -0.20)), (50, (0.44, 1.25, -0.23)),
         (52, (0.45, 1.24, -0.23)), (58, (0.69, 1.09, -0.10)), (90, (0.71, 1.05, -0.10))]
LEFT = [(0, (0.70, 1.02, 0.23)), (8, (0.60, 1.35, 0.21)), (15, (0.53, 1.64, 0.22)),
        (21, (0.51, 1.74, 0.23)), (27, (0.49, 1.66, 0.15)), (33, (0.52, 1.41, 0.19)),
        (43, (0.60, 1.27, 0.17)), (51, (0.67, 1.17, 0.19)), (90, (0.72, 1.05, 0.23))]
LEADER = [(15.5, (0.461, 1.64, 0.098)), (18.4, (0.287, 1.819, 0.095)),
          (21.5, (0.290, 1.740, 0.030)), (24.9, (0.282, 1.624, 0.107)),
          (28.2, (0.287, 1.454, 0.056)), (32.1, (0.292, 1.331, 0.142)), (35.7, (0.461, 1.44, -0.104))]


def animate_projectionist(rig):
    height = rig.location.z
    orientations, heights = sample_motion(
        ASSETS / "Animations/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx", 110,
    )
    rig.animation_data_create()
    # Importing the reference FBX can reset the scene frame rate.
    bpy.context.scene.render.fps = 24
    bpy.context.scene.render.fps_base = 1.0
    action = bpy.data.actions.new("Thread the projector")
    rig.animation_data.action = action
    for frame in range(1, 2163, 4):
        seconds = (frame - 1) / 24
        phase = int(seconds * 19) % (len(orientations) * 2 - 2)
        phase = min(phase, len(orientations) * 2 - 2 - phase)
        apply_body(rig, orientations[phase], float(heights[phase]) * 0.33, height)
        bpy.context.view_layer.update()
        guide = smooth_path(LEADER, seconds) if 15.5 <= seconds <= 35.7 else None
        place_wrist(rig, "R", smooth_path(RIGHT, seconds), guide)
        place_wrist(rig, "L", smooth_path(LEFT, seconds))
        key_pose(rig, frame)


def export_actor(name, projectionist=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 24 if projectionist else 30
    folder = ASSETS / "Avatars" / "Professions" / name
    rig, objects = import_fbx(folder / "Export" / f"{name}.fbx", False)
    mesh = max((o for o in objects if o.type == "MESH"), key=lambda o: len(o.data.vertices))
    for o in objects:
        if o.type == "MESH" and o != mesh:
            bpy.data.objects.remove(o, do_unlink=True)
    path = ROOT / ("projectionist" if projectionist else name.lower())
    cast_materials(mesh, folder / "Textures", None if projectionist else path.with_suffix(".png"))
    rig.animation_data_clear()
    if projectionist:
        animate_projectionist(rig)
    else:
        animate_crowd(rig, "f" if "Female" in name else "m")
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    mesh.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(path.with_suffix(".glb")), use_selection=True, export_format="GLB",
        export_animation_mode="ACTIONS" if projectionist else "NLA_TRACKS", export_frame_range=False,
        export_anim_slide_to_zero=True, export_yup=True)


if __name__ == "__main__":
    if "--projectionist-only" not in sys.argv:
        actors = ACTORS[4:] if "--new-cast-only" in sys.argv else ACTORS
        for actor in actors:
            export_actor(actor)
    if "--new-cast-only" not in sys.argv:
        export_actor(ACTORS[0], projectionist=True)
