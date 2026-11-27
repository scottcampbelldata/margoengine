"""Author the original trail walker from the MakeHuman core CC0 assets."""
from array import array
import pathlib
import sys

import addon_utils
import bpy
from mathutils import Quaternion, Vector

output = pathlib.Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_homefile(use_empty=True)
addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=False)
from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService

AssetService.update_all_asset_lists()
human = HumanService._create_default_human_info_dict()
human.update(
    name="Sam • creek surveyor",
    phenotype={
        **human["phenotype"],
        "gender": 1.0, "age": 0.59, "height": 0.46, "weight": 0.38,
        "muscle": 0.59, "proportions": 0.57,
        "race": {"caucasian": 0.05, "asian": 0.10, "african": 0.85},
    },
    targets=[
        {"target": "head-oval", "value": 0.34},
        {"target": "chin-prominent-incr", "value": 0.38},
        {"target": "nose-point-width-incr", "value": 0.22},
        {"target": "neck-scale-horiz-incr", "value": 0.18},
    ],
    skin_mhmat="middleage_african_male/middleage_african_male.mhmat",
    skin_material_type="MAKESKIN",
    eyes_material_type="MAKESKIN",
    eyes="high-poly/high-poly.mhclo",
    eyelashes="eyelashes01/eyelashes01.mhclo",
    eyebrows="eyebrow001/eyebrow001.mhclo",
    hair="short04/short04.mhclo",
    clothes=["male_casualsuit05/male_casualsuit05.mhclo", "shoes02/shoes02.mhclo"],
    rig="mixamo",
)
options = HumanService.get_default_deserialization_settings()
options.update(subdiv_levels=0, load_clothes=True)
HumanService.deserialize_from_dict(human, options)
armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
body = next(obj for obj in bpy.context.scene.objects if obj.name.endswith(".body"))
outfit = next(obj for obj in bpy.context.scene.objects if obj.name.endswith(".male_casualsuit05"))
shoes = next(obj for obj in bpy.context.scene.objects if obj.name.endswith(".shoes02"))


def bake_body_masks(obj):
    """Keep the authored skin and weights while removing covered skin and fitting guides."""
    masks = [modifier.name for modifier in obj.modifiers if modifier.type == "MASK"]
    before = len(obj.data.vertices)
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        if obj.data.shape_keys is not None:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        # Bake in rest space. Applying the armature would discard the skin deformation.
        for name in masks:
            bpy.ops.object.modifier_move_to_index(modifier=name, index=0)
            bpy.ops.object.modifier_apply(modifier=name)
    if len(masks) != 3 or not len(obj.data.vertices) < before:
        raise RuntimeError("The helper, outerwear, and footwear masks must be baked.")
    print(f"Visible skin vertices: {len(obj.data.vertices)} of {before}")


def dye_uniform(obj):
    """Recolour the CC0 textile atlas and preserve its seams and fabric variation."""
    material = obj.data.materials[0]
    source = next(
        node for node in material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image and "casualsuit05_diffuse" in node.image.name
    )
    image = source.image
    image.scale(512, 512)
    width, height = image.size
    pixels = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    for row in range(height):
        for col in range(width):
            offset = 4 * (row * width + col)
            red, green, blue = pixels[offset:offset + 3]
            luminance = 0.22 * red + 0.70 * green + 0.08 * blue
            if row >= height * 0.94 and col > width * 0.80:
                color = (0.08, 0.08, 0.08)
            elif luminance < 0.045:
                continue
            elif row < height * 0.45 and col < width * 0.60 and blue > red * 1.10:
                # Denim is rendered as washed charcoal work trousers.
                color = (luminance * 0.91 + 0.020, luminance * 0.90 + 0.027, luminance * 0.81 + 0.034)
            elif red > green * 1.13 and red > blue * 1.05:
                # Keep the woven placket's pattern, dyed in warmer earth tones.
                color = (luminance * 1.05 + 0.037, luminance * 0.74 + 0.020, luminance * 0.58 + 0.012)
            else:
                # Warm ochre shell without printed artwork.
                color = (luminance * 1.28 + 0.125, luminance * 1.01 + 0.084, luminance * 0.76 + 0.045)
            pixels[offset:offset + 3] = array("f", (min(0.90, channel) for channel in color))
    image.pixels.foreach_set(pixels)
    image.update()
    image.pack()
    material.name = "Ochre field jacket and charcoal trousers"


bake_body_masks(body)
dye_uniform(outfit)
bpy.context.view_layer.update()
# Keep the existing Margo footfall targets when swapping footwear.
ankles = [
    (armature.matrix_world @ joint.head_local).z
    for joint in armature.data.bones
    if joint.name.endswith((":LeftFoot", ":RightFoot"))
]
if len(ankles) != 2 or abs(ankles[0] - ankles[1]) > 0.001:
    raise RuntimeError("Expected paired ankle joints at the same height.")
ankle = sum(ankles) / 2
shoe_to_world = shoes.matrix_world.copy()
world_to_shoe = shoe_to_world.inverted()
sole = min((shoe_to_world @ vertex.co).z for vertex in shoes.data.vertices)
if sole >= ankle:
    raise RuntimeError("The shoe sole must be below the ankle.")
scale = 0.074 / (ankle - sole)
for vertex in shoes.data.vertices:
    position = shoe_to_world @ vertex.co
    if position.z < ankle:
        position.z = ankle + (position.z - ankle) * scale
        vertex.co = world_to_shoe @ position
shoes.data.update()
fitted_sole = min((shoe_to_world @ vertex.co).z for vertex in shoes.data.vertices)
print(f"Ankle above fitted trail sole: {ankle - fitted_sole:.4f} m")

def bone(suffix):
    pose = next(pose for pose in armature.pose.bones if pose.name.rsplit(":", 1)[-1] == suffix)
    pose.rotation_mode = "QUATERNION"
    return pose

def aim(pose, direction):
    bpy.context.view_layer.update()
    parent_space = pose.matrix.to_quaternion()
    before = parent_space @ Vector((0, 1, 0))
    world_delta = before.rotation_difference(Vector(direction).normalized())
    pose.rotation_quaternion = pose.rotation_quaternion @ parent_space.inverted() @ world_delta @ parent_space

for side, sign in (("Left", 1), ("Right", -1)):
    aim(bone(side + "Arm"), (0.37 * sign, -0.07, -0.92))
    aim(bone(side + "ForeArm"), (0.29 * sign, -0.43, -0.85))
    aim(bone(side + "Hand"), (0.18 * sign, -0.39, -0.89))

scene = bpy.context.scene
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 49
animated = {}
for name in ("Spine", "Spine1", "Head", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand"):
    pose = bone(name)
    animated[name] = (pose, pose.rotation_quaternion.copy())
for frame, sway in ((1, 0.0), (13, 0.6), (25, 1.0), (37, 0.5), (49, 0.0)):
    scene.frame_set(frame)
    for name, (pose, rest) in animated.items():
        amplitude = 0.025 if name in ("Spine", "Head") else 0.010
        pose.rotation_quaternion = rest @ Quaternion((0.0, 0.0, 1.0), sway * amplitude)
        pose.keyframe_insert(data_path="rotation_quaternion", frame=frame)

armature.animation_data.action.name = "Balance"
scene.frame_set(1)

# Keep the face and woven fabric legible in the shoulder-height camera view.
for img in bpy.data.images:
    long_side = max(img.size)
    if img.source == "FILE" and long_side > 512:
        ratio = 512 / long_side
        img.scale(round(img.size[0] * ratio), round(img.size[1] * ratio))
        img.pack()

bpy.ops.export_scene.gltf(
    filepath=str(output), export_format="GLB", export_yup=True, export_animations=True,
    export_animation_mode="ACTIONS", export_image_format="WEBP", export_image_quality=82,
    export_materials="EXPORT", export_skins=True, export_morph=False,
)
