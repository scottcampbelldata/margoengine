"""Author Tomás, the fictional lighthouse keeper, with speech shapes for the short film."""

import math
import pathlib
import sys

import addon_utils
import bpy
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree

output = pathlib.Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_homefile(use_empty=True)
addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=False)

from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
import bl_ext.user_default.mpfb as mpfb

targets = pathlib.Path(mpfb.__file__).parent / "data" / "targets" / "expression" / "units" / "asian"
shape_units = {
    "Smile": {"mouth-corner-puller": .90, "mouth-parling": .18,
              "eye-left-slit": .20, "eye-right-slit": .32},
    "Surprise": {"eyebrows-left-up": .86, "eyebrows-right-up": .76,
                 "eye-left-opened-up": .51, "eye-right-opened-up": .47,
                 "mouth-open": .36, "mouth-pursing": .34},
    "Blink": {"eye-left-closure": 1, "eye-right-closure": 1},
    "AH": {"mouth-open": .86, "mouth-parling": .19, "mouth-depression": .09},
    "EE": {"mouth-retraction": .70, "mouth-corner-puller": .38,
           "mouth-open": .18, "mouth-parling": .15},
    "OO": {"mouth-pursing": .80, "mouth-protusion": .49,
           "mouth-open": .22, "mouth-eversion": .17},
    "M": {"mouth-compression": .82, "mouth-elevation": .21},
}

AssetService.update_all_asset_lists()
profile = HumanService._create_default_human_info_dict()
profile.update(
    name="Tomás",
    phenotype={
        **profile["phenotype"],
        "gender": 1., "age": .68, "height": .51, "weight": .59,
        "muscle": .40, "proportions": .50,
        "race": {"asian": .42, "caucasian": .36, "african": .22},
    },
    targets=[
        {"target": "head-round", "value": .03},
        {"target": "nose-point-width-incr", "value": .20},
        {"target": "chin-prominent-incr", "value": .02},
        {"target": "head-age-decr", "value": .02},
    ],
    skin_mhmat="middleage_asian_male/middleage_asian_male.mhmat",
    skin_material_type="MAKESKIN",
    eyes_material_type="MAKESKIN",
    eyes="high-poly/high-poly.mhclo",
    eyelashes="eyelashes01/eyelashes01.mhclo",
    eyebrows="eyebrow001/eyebrow001.mhclo",
    hair="short01/short01.mhclo",
    clothes=["male_casualsuit03/male_casualsuit03.mhclo"],
)
profile["rig"]="mixamo"
settings = HumanService.get_default_deserialization_settings()
settings.update(subdiv_levels=0, load_clothes=True)
HumanService.deserialize_from_dict(profile, settings)
scene = bpy.context.scene
meshes = [item for item in scene.objects if item.type == "MESH"]
body = next(item for item in meshes if item.name.endswith(".body"))
brows = next(item for item in meshes if item.name.endswith(".eyebrow001"))
lashes = next(item for item in meshes if item.name.endswith(".eyelashes01"))
eyes = next(item for item in meshes if item.name.endswith(".high-poly"))
shirt = next(item for item in meshes if item.name.endswith(".male_casualsuit03"))
hair = next(item for item in meshes if item.name.endswith(".short01"))
def pose_shirt():
    armature=next(item for item in scene.objects if item.type=="ARMATURE")
    def bone(name):
        return next(b for b in armature.pose.bones if b.name.rsplit(":",1)[-1]==name)
    def point_at(joint, child, direct):
        current=child.head-joint.head
        rotation=current.rotation_difference(direct)
        center=joint.head.copy()
        joint.matrix=Matrix.Translation(center) @ rotation.to_matrix().to_4x4() @ Matrix.Translation(-center) @ joint.matrix
        bpy.context.view_layer.update()
    for side in ("Left","Right"):
        shoulder, elbow, wrist = [bone(side+suffix) for suffix in ("Arm","ForeArm","Hand")]
        sign=1 if elbow.head.x>shoulder.head.x else -1
        point_at(shoulder,elbow,Vector((sign*.20,-.10,-1)))
        point_at(elbow,wrist,Vector((sign*.04,-.25,-1)))
    deps=bpy.context.evaluated_depsgraph_get()
    evaluated=shirt.evaluated_get(deps)
    baked=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=deps)
    for modifier in list(shirt.modifiers):
        shirt.modifiers.remove(modifier)
    shirt.data=baked
    bpy.context.view_layer.update()

pose_shirt()


with bpy.context.temp_override(object=body, active_object=body):
    if body.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    skin_masks = [modifier.name for modifier in body.modifiers if modifier.type == "MASK"]

origin = Vector((0, 0, 1.51))

def world_positions(item):
    return [item.matrix_world @ vertex.co for vertex in item.data.vertices]

body_world = world_positions(body)
print("Model height", max(p.z for p in body_world))
print("Body masks", skin_masks)
print("Parts", [(item.name, len(item.data.vertices)) for item in meshes])

basis = body.shape_key_add(name="Basis")
unit_names = sorted(set(name for units in shape_units.values() for name in units))
key_deltas = {}
for name in unit_names:
    key = TargetService.load_target(body, str(targets / (name + ".target.gz")), name="_unit")
    key_deltas[name] = [k.co - b.co for k, b in zip(key.data, basis.data)]
    body.shape_key_remove(key)
shapes = {}
shape_units={key:value for key,value in shape_units.items() if key in {'AH','EE','OO','M','Blink'}}
for name, units in shape_units.items():
    key = body.shape_key_add(name=name)
    deltas = [Vector((0, 0, 0)) for _ in body_world]
    for unit, intensity in units.items():
        for i, delta in enumerate(key_deltas[unit]):
            deltas[i] += delta * intensity
    for i, (base, delta) in enumerate(zip(basis.data, deltas)):
        key.data[i].co = base.co + delta
    shapes[name] = deltas
    print(name, "moving points", sum(d.length > .00001 for d in deltas),
          "maximum", max(d.length for d in deltas))

def attach_eye_morphs(item, active_units):
    surface = KDTree(len(body_world))
    for i, point in enumerate(body_world):
        surface.insert(point, i)
    surface.balance()
    mapped = []
    for point in world_positions(item):
        nearest = surface.find_n(point, 5)
        weights = [(i, 1.0 / max(.00002, d) ** 2) for _, i, d in nearest]
        total = sum(w for _, w in weights)
        mapped.append([(i, w / total) for i, w in weights])
    neutral = item.shape_key_add(name="Basis")
    to_world = body.matrix_world.to_3x3()
    to_local = item.matrix_world.to_3x3().inverted()
    for name in ("Smile", "Surprise", "Blink"):
        if name not in active_units or name not in shapes:
            continue
        key = item.shape_key_add(name=name)
        for i, influences in enumerate(mapped):
            delta = sum((shapes[name][v] * w for v, w in influences), Vector((0,0,0)))
            key.data[i].co = neutral.data[i].co + to_local @ (to_world @ delta)

attach_eye_morphs(lashes, ("Blink",))

def oral_mesh():
    vertices,faces,following,material_indices=[],[],[],[]

    def rounded(center, radii, square, moves, material):
        start=len(vertices)
        phase_count,ring_count=10,6
        for row in range(1,ring_count):
            v=math.pi*(row/ring_count-.5)
            for step in range(phase_count):
                u=math.tau*step/phase_count
                c,s=math.cos(u),math.sin(u)
                phi=math.cos(v)**square
                xyz=(math.copysign(abs(c)**square,c)*phi,
                     math.copysign(abs(s)**square,s)*phi,math.copysign(abs(math.sin(v))**.66,v))
                vertices.append(tuple(a+b*d for a,b,d in zip(center,radii,xyz)))
                following.append(moves)
        low=len(vertices)
        vertices.append((center[0],center[1],center[2]-radii[2]))
        high=len(vertices)
        vertices.append((center[0],center[1],center[2]+radii[2]))
        following.extend([moves,moves])
        for k in range(phase_count):
            n=(k+1)%phase_count
            faces.extend([(low,start+n,start+k),
                          (high,start+(ring_count-2)*phase_count+k,start+(ring_count-2)*phase_count+n)])
            material_indices.extend([material,material])
            for row in range(ring_count-2):
                a=start+row*phase_count
                faces.append((a+k,a+n,a+phase_count+n,a+phase_count+k))
                material_indices.append(material)

    for lower in (False,True):
        for sign in (-1,1):
            for i,(across,width,depth,height) in enumerate([
                (.0041,.0038,.0035,.0040),(.0113,.0033,.0040,.00375),
                (.0176,.00295,.0042,.0039),(.0234,.0028,.0045,.0032),
            ]):
                if lower:
                    across*=.91
                    width*=.86
                front=-.130+.011*(across/.025)**2+(0.005 if lower else 0)
                z=1.4505 if lower else 1.461
                rounded((sign*across,front,z+.0005*i),(width,depth,height),.48,lower,0)
    rounded((0,-.099,1.440),(.019,.015,.0032),.92,True,1)
    mesh=bpy.data.meshes.new("Oral model")
    mesh.from_pydata(vertices,[],faces)
    mesh.update()
    obj=bpy.data.objects.new("Oral model",mesh)
    scene.collection.objects.link(obj)
    for name,color,roughness in [
        ("Ivory enamel",(.654,.587,.486,1),.33),
        ("Tongue",(.17,.039,.042,1),.54),
    ]:
        mat=bpy.data.materials.new(name)
        mat.use_nodes=True
        shader=next(n for n in mat.node_tree.nodes if n.type=="BSDF_PRINCIPLED")
        shader.inputs["Base Color"].default_value=color
        shader.inputs["Roughness"].default_value=roughness
        mesh.materials.append(mat)
    for poly,material in zip(mesh.polygons,material_indices):
        poly.material_index=material
        poly.use_smooth=True
    neutral=obj.shape_key_add(name="Basis")
    for name,angle in (("AH",.29),("EE",.052),("OO",.087),("M",-.008)):
        key=obj.shape_key_add(name=name)
        sin,cos=math.sin(angle),math.cos(angle)
        for i,moves in enumerate(following):
            if not moves:
                continue
            x,y,z=neutral.data[i].co
            y+=.057
            z-=1.474
            key.data[i].co=(x,y*cos-z*sin-.057,y*sin+z*cos+1.474)
    return obj

teeth=oral_mesh()
# Align the separate crowns and tongue to this keeper's own measured lip vertices.
weighted = []
for point, delta in zip(body_world, key_deltas['mouth-compression']):
    if abs(point.x)<.040 and point.y<-.075 and point.z>1.37 and delta.length>.001:
        weighted.append((point,delta.length**2))
if len(weighted)<6:
    raise RuntimeError('Could not locate the keeper’s mouth.')
lip = sum((point*weight for point,weight in weighted), Vector((0,0,0)))/sum(weight for _,weight in weighted)
teeth.location = Vector((lip.x,lip.y+.141,lip.z-1.455))
print('Aligned mouth to',tuple(lip),tuple(teeth.location))
meshes.append(teeth)

def crop(item, minimum, masks=()):
    bpy.ops.object.select_all(action="DESELECT")
    item.select_set(True)
    bpy.context.view_layer.objects.active = item
    scene.tool_settings.mesh_select_mode=(True,False,False)
    for vertex in item.data.vertices:
        labels={entry.group for entry in vertex.groups if entry.weight > .5}
        hidden=any((group in labels)==invert for group,invert in masks)
        vertex.select = hidden or (item.matrix_world @ vertex.co).z < minimum
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")

def cap_material_maps(item, dimension, roughness):
    for material in item.data.materials:
        if not material or not material.use_nodes:
            continue
        tree = material.node_tree
        shader = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
        for key in ("Normal", "Roughness", "Metallic", "Emission Color", "Emission Strength"):
            for link in list(shader.inputs[key].links):
                tree.links.remove(link)
        shader.inputs["Metallic"].default_value = 0.
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Emission Strength"].default_value = 0.
        for key in ("Base Color", "Alpha"):
            links = shader.inputs[key].links
            bitmap = links[0].from_node.image if links and links[0].from_node.type == "TEX_IMAGE" else None
            if bitmap and max(bitmap.size) > dimension:
                w,h = bitmap.size
                bitmap.scale(round(dimension*w/max(w,h)),round(dimension*h/max(w,h)))
                bitmap.pack()

# Existing helper polygons and shirt masks become geometric exclusions while the skin keys stay active.
# The clothing's own mask uses the same fitted base mesh vertex indices.
masked_groups = [(body.vertex_groups.get(body.modifiers[name].vertex_group).index,
                  body.modifiers[name].invert_vertex_group) for name in skin_masks]
crop(body, 1.25, masked_groups)
crop(shirt, 1.16)
for item in meshes:
    for modifier in list(item.modifiers):
        item.modifiers.remove(modifier)
    for polygon in item.data.polygons:
        polygon.use_smooth = True

cap_material_maps(body, 384, .58)
cap_material_maps(eyes, 192, .29)
cap_material_maps(hair, 256, .54)
cap_material_maps(brows, 128, .69)
cap_material_maps(lashes, 128, .70)
cap_material_maps(shirt, 192, .78)

for item in meshes:
    world = item.matrix_world.copy()
    item.parent = None
    item.matrix_world = world
    item.location -= origin

for item in list(scene.objects):
    if item.type != "MESH":
        bpy.data.objects.remove(item, do_unlink=True)

body.name = "Keeper face"
brows.name = "Brow hairs"
lashes.name = "Lashes"
eyes.name = "Irises and sclera"
teeth.name = "Teeth and gums"
shirt.name = "Workshirt"
hair.name = "Hair"
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True,
                         export_image_format="AUTO",export_animations=False,
                         export_apply=False,export_morph=True,export_morph_normal=True)
print("Exported", output)
