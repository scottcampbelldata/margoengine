"""Build the original gallery attendant from the official MPFB core human and clothing."""
import pathlib
import sys

import addon_utils
import bpy

output=pathlib.Path(sys.argv[sys.argv.index("--")+1])
bpy.ops.wm.read_homefile(use_empty=True)
addon_utils.enable("bl_ext.user_default.mpfb",default_set=True,persistent=False)
from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService

AssetService.update_all_asset_lists()
human=HumanService._create_default_human_info_dict()
human.update(
    name="Rita · gallery attendant",
    phenotype={
        **human["phenotype"],"gender":.04,"age":.64,"height":.52,"weight":.48,"muscle":.45,"proportions":.48,
        "race":{"caucasian":.24,"asian":.12,"african":.64},
    },
    targets=[
        {"target":"head-oval","value":.18},
        {"target":"nose-point-width-incr","value":.17},
        {"target":"neck-scale-horiz-incr","value":.06},
    ],
    skin_mhmat="middleage_african_female/middleage_african_female.mhmat",
    skin_material_type="MAKESKIN",
    hair="bob02/bob02.mhclo",
    eyes="low-poly/low-poly.mhclo",
    clothes=["toigo_female_double-breasted_suit/toigo_female_double-breasted_suit.mhclo","shoes02/shoes02.mhclo"],
    rig="mixamo",
)
options=HumanService.get_default_deserialization_settings()
options.update(subdiv_levels=0,load_clothes=True)
HumanService.deserialize_from_dict(human,options)
body=next(o for o in bpy.context.scene.objects if o.name.endswith(".body"))

with bpy.context.temp_override(object=body,active_object=body,selected_objects=[body]):
    if body.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True,apply_mix=True)
    masks=[mod.name for mod in body.modifiers if mod.type=="MASK"]
    for name in masks:
        bpy.ops.object.modifier_move_to_index(modifier=name,index=0)
        bpy.ops.object.modifier_apply(modifier=name)
if len(masks)<3:
    raise RuntimeError("Rita requires the base, clothing and footwear surface masks.")

limits={"body":2900,"toigo_female_double-breasted_suit":2910,"shoes02":520,"bob02":800,"low-poly":260}
for obj in bpy.context.scene.objects:
    if obj.type!="MESH":
        continue
    tag=obj.name.rsplit(".",1)[-1]
    target=limits.get(tag)
    if target:
        count=sum(len(p.vertices)-2 for p in obj.data.polygons)
        if count>target:
            remesh=obj.modifiers.new("Preserve visible curves for both renderers","DECIMATE")
            remesh.ratio=target/count
            remesh.use_collapse_triangulate=True
            with bpy.context.temp_override(object=obj,active_object=obj,selected_objects=[obj]):
                bpy.ops.object.modifier_apply(modifier=remesh.name)
        print(tag,len(obj.data.vertices),len(obj.data.polygons))
for image in bpy.data.images:
    if image.source=="FILE" and max(image.size)>256:
        ratio=256/max(image.size)
        image.scale(round(image.size[0]*ratio),round(image.size[1]*ratio))
        image.pack()
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True,
    export_skins=True,export_animations=False,export_materials="EXPORT",
    export_image_format="WEBP",export_image_quality=78,export_morph=False)
