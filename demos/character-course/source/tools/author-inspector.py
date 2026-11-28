"""Create the original Tidal Gauge Station inspector from MPFB's CC0 core assets."""
from array import array
import collections
import gzip
import json
import math
import pathlib
import struct
import sys

import addon_utils
import bpy
from mathutils import Vector

output=pathlib.Path(sys.argv[sys.argv.index("--")+1])
bpy.ops.wm.read_homefile(use_empty=True)
addon_utils.enable("bl_ext.user_default.mpfb",default_set=True,persistent=False)
from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService

AssetService.update_all_asset_lists()
human=HumanService._create_default_human_info_dict()
human.update(
    name="Nora · intake inspector",
    phenotype={
        **human["phenotype"],
        "gender":0.06,"age":0.455,"height":0.50,"weight":0.41,
        "muscle":0.43,"proportions":0.47,
        "race":{"caucasian":0.27,"asian":0.68,"african":0.05},
    },
    targets=[
        {"target":"head-oval","value":0.20},
        {"target":"chin-prominent-incr","value":0.11},
        {"target":"nose-point-width-incr","value":0.13},
        {"target":"neck-scale-horiz-incr","value":0.13},
    ],
    skin_mhmat="middleage_asian_female/middleage_asian_female.mhmat",
    skin_material_type="MAKESKIN",
    eyes="low-poly/low-poly.mhclo",
    hair="ponytail01/ponytail01.mhclo",
    clothes=["male_worksuit01/male_worksuit01.mhclo","shoes02/shoes02.mhclo"],
    rig="mixamo",
)
options=HumanService.get_default_deserialization_settings()
options.update(subdiv_levels=0,load_clothes=True)
HumanService.deserialize_from_dict(human,options)
arm=next(o for o in bpy.context.scene.objects if o.type=="ARMATURE")
body=next(o for o in bpy.context.scene.objects if o.name.endswith(".body"))
meshes=[o for o in bpy.context.scene.objects if o.type=="MESH"]
names={bone.name.rsplit(":",1)[-1]:bone for bone in arm.pose.bones}

def apply(obj,name):
    with bpy.context.temp_override(object=obj,active_object=obj,selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=name)

with bpy.context.temp_override(object=body,active_object=body,selected_objects=[body]):
    if body.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True,apply_mix=True)
    masks=[mod.name for mod in body.modifiers if mod.type=="MASK"]
    for name in masks:
        bpy.ops.object.modifier_move_to_index(modifier=name,index=0)
        bpy.ops.object.modifier_apply(modifier=name)
if len(masks)<3:
    raise RuntimeError("The skin must use the helper, clothing and boots masks.")

def aim(name,direction):
    bone=names[name]
    bone.rotation_mode="QUATERNION"
    bpy.context.view_layer.update()
    basis=bone.matrix.to_quaternion()
    before=basis@Vector((0,1,0))
    delta=before.rotation_difference(Vector(direction).normalized())
    bone.rotation_quaternion=bone.rotation_quaternion@basis.inverted()@delta@basis

for side,sign in (("Left",1),("Right",-1)):
    aim(side+"Arm",(0.21*sign,-0.02,-0.98))
    aim(side+"ForeArm",(0.13*sign,-0.20,-0.97))
    aim(side+"Hand",(0.05*sign,-0.19,-0.98))
bpy.context.view_layer.update()

keys=["Hips","Spine","Spine1","Spine2","Neck","Head"]
for side in ("Left","Right"):
    keys.extend(side+name for name in ("Shoulder","Arm","ForeArm","Hand","UpLeg","Leg","Foot","ToeBase"))
indices={names[name].name:i for i,name in enumerate(keys)}
full_names={bone.name:bone for bone in arm.pose.bones}

def retained(bone):
    while bone and bone.name not in indices:
        bone=bone.parent
    return indices.get(bone.name,0) if bone else 0

def coords(point):
    return [point.x,point.z,-point.y]

scene=bpy.context.evaluated_depsgraph_get()
def evaluated(obj):
    return obj.evaluated_get(scene)

shoes=next(o for o in meshes if o.name.endswith(".shoes02"))
sole=min((shoes.matrix_world@v.co).z for v in evaluated(shoes).data.vertices)
head=(arm.matrix_world@names["Head"].head).z
scale=1.0
if not 1.2<head-sole<1.85:
    raise RuntimeError(f"Unexpected character scale, head joint at {head-sole:.3f} m")

def convert(point):
    p=coords(point)
    return [p[0]*scale,(p[1]-sole)*scale,p[2]*scale]

joints=[]
for name in keys:
    bone=names[name]
    parent=retained(bone.parent) if bone.parent else -1
    joints.append([name,parent,convert(arm.matrix_world@bone.head)])
print("Sole elevation, joints, head height:",sole,len(joints),head-sole)

targets={"body":1470,"male_worksuit01":2250,"shoes02":440,"ponytail01":520,"low-poly":170}
palette={
    "skin":"#c38769",
    "lip":"#a15b58",
    "hair":"#342a28",
    "eyes":"#776858",
    "boot":"#443631",
    "denim":"#527381",
    "helmet":"#c27f48",
    "brim":"#9f6436",
    "seam":"#496b7a",
    "sleeve":"#c8c4ae",
}
all_bins=collections.defaultdict(list)

clothing_img=next((image for image in bpy.data.images if "worksuit01_diffuse" in image.name),None)
if clothing_img is None:
    raise RuntimeError("The original workwear diffuse map supplies cloth boundaries.")
clothing_img.scale(384,384)
workwear_pixels=array("f",[0.0])*(384*384*4)
clothing_img.pixels.foreach_get(workwear_pixels)

def tone(name,p,n,uv):
    x,y,z=p
    if name=="male_worksuit01":
        u=max(0,min(383,round(uv[0]*383)))
        v=max(0,min(383,round(uv[1]*383)))
        index=(v*384+u)*4
        red,green,blue=workwear_pixels[index:index+3]
        saturated=max(red,green,blue)-min(red,green,blue)
        if (red+green+blue)/3>.36 and saturated<.195:
            return "sleeve"
        if (red+green+blue)/3<.18:
            return "seam"
        return "denim"
    if name=="shoes02":return "boot"
    if name=="ponytail01":return "hair"
    if name=="low-poly":return "eyes"
    if name=="body" and 1.46<y<1.49 and abs(x)<.035 and z>.045 and n[2]>.45:
        return "lip"
    return "skin"

for obj in meshes:
    source=obj.name.rsplit(".",1)[-1]
    if source not in targets:
        continue
    count=sum(max(1,len(poly.vertices)-2) for poly in obj.data.polygons)
    modifier=obj.modifiers.new("Runtime mesh reducer","DECIMATE")
    modifier.ratio=min(1,targets[source]/max(1,count))
    modifier.use_collapse_triangulate=True
    bpy.context.view_layer.update()
    snapshot=evaluated(obj)
    mesh=snapshot.data
    mesh.calc_loop_triangles()
    group_names={group.index:group.name for group in obj.vertex_groups}
    positions=[convert(snapshot.matrix_world@v.co) for v in mesh.vertices]
    normal_matrix=snapshot.matrix_world.to_3x3().inverted().transposed()
    normals=[coords((normal_matrix@v.normal).normalized()) for v in mesh.vertices]
    weights=[]
    for v in mesh.vertices:
        merged=collections.defaultdict(float)
        for record in v.groups:
            if record.weight>.005 and group_names.get(record.group) in full_names:
                merged[retained(full_names[group_names[record.group]])]+=record.weight
        top=sorted(merged.items(),key=lambda p:p[1],reverse=True)[:3] or [(0,1)]
        total=sum(val for _,val in top)
        top=[(index,round(255*weight/total)) for index,weight in top]
        top[0]=(top[0][0],top[0][1]+255-sum(v for _,v in top))
        top+= [(0,0)]*(3-len(top))
        weights.append(top)
    clusters=collections.defaultdict(list)
    uv_map=mesh.uv_layers.active
    for tri in mesh.loop_triangles:
        verts=tuple(tri.vertices)
        centre=[sum(positions[v][i] for v in verts)/3 for i in range(3)]
        normal=[sum(normals[v][i] for v in verts)/3 for i in range(3)]
        uv=[sum(uv_map.data[loop].uv[i] for loop in tri.loops)/3 for i in range(2)] if uv_map else (0,0)
        clusters[tone(source,centre,normal,uv)].append(verts)
    for material,triangles in clusters.items():
        used={}
        data=[]
        face=[]
        for triangle in triangles:
            for v in triangle:
                if v not in used:
                    used[v]=len(data)
                    packed_normal=tuple(max(-127,min(127,round(f*127))) for f in normals[v])
                    data.append((tuple(round(f*2048) for f in positions[v]),packed_normal,weights[v]))
                face.append(used[v])
        all_bins[material].append((data,face))
    print(source,len(positions),len(mesh.loop_triangles),{key:len(value) for key,value in clusters.items()})

# An original turned hardhat shell, with a longer front bill.
helmet_rings=[
    (1.447,.092,.098),
    (1.447,.113,.129),
    (1.455,.116,.134),
    (1.466,.110,.119),
    (1.470,.098,.108),
    (1.493,.099,.102),
    (1.517,.092,.094),
    (1.542,.074,.080),
    (1.558,.044,.051),
    (1.567,.004,.005),
]
head_index=keys.index("Head")
helmet_details=collections.defaultdict(lambda:([],[],{}))
for j in range(len(helmet_rings)-1):
    group="helmet" if j>=3 else "brim"
    raw,faces,already=helmet_details[group]
    def vertex(row,i):
        index=(row,i%30)
        if index not in already:
            t=i*math.tau/30
            angle=math.cos(t)
            height,rx,rz=helmet_rings[row]
            rz+=(.014*max(0,math.sin(t))) if row<4 else 0
            flap=.007*math.sin(t) if row<4 else 0
            x,z=rx*angle,.037+rz*math.sin(t)
            previous=helmet_rings[max(0,row-1)]
            next_ring=helmet_rings[min(len(helmet_rings)-1,row+1)]
            dy=next_ring[0]-previous[0]
            dr=previous[1]-next_ring[1]
            if abs(dy)+abs(dr)<1e-6:dy=1
            normal=Vector((dy*angle,dr,dy*math.sin(t))).normalized()
            raw.append((tuple(round(f*2048) for f in (x,height+flap,z)),
                tuple(round(v*127) for v in normal),[(head_index,255),(0,0),(0,0)]))
            already[index]=len(raw)-1
        return already[index]
    for i in range(30):
        a,b,c,d=vertex(j,i),vertex(j+1,i),vertex(j+1,i+1),vertex(j,i+1)
        faces.extend((a,b,c,a,c,d))
for name,(vertices,faces,_) in helmet_details.items():
    all_bins[name].append((vertices,faces))
blocks=[]
headers=[]
for material,groups in all_bins.items():
    records=[]
    faces=[]
    for data,face in groups:
        faces.extend(index+len(records) for index in face)
        records.extend(data)
    # Transpose the vertex channels so incremental changes compress together.
    raw=bytearray()
    for axis in range(3):
        previous=0
        for p,_,_ in records:
            delta=p[axis]-previous
            raw.extend(struct.pack("<h",delta))
            previous=p[axis]
    for record in records:
        x,y,z=(v/127 for v in record[1])
        length=abs(x)+abs(y)+abs(z)
        if length<1e-6:y,z,length=1,0,1
        x,y,z=x/length,y/length,z/length
        if y<0:
            x,z=(1-abs(z))*(1 if x>=0 else -1),(1-abs(x))*(1 if z>=0 else -1)
        raw.extend(struct.pack("<bb",round(x*92),round(z*92)))
    for i in range(3):
        raw.extend(bytes(s[i][0] for _,_,s in records))
    for i in range(2):
        raw.extend(bytes(s[i][1] for _,_,s in records))
    previous=0
    for face_index in faces:
        delta=face_index-previous
        token=2*delta if delta>=0 else -2*delta-1
        previous=face_index
        while token>=128:
            raw.append((token&127)|128)
            token>>=7
        raw.append(token)
    blocks.append(raw)
    headers.append({"name":material,"color":palette[material],"vertices":len(records),"indices":len(faces)})
metadata=json.dumps({"joints":joints,"meshes":headers},separators=(",",":")).encode()
payload=struct.pack("<I",len(metadata))+metadata+b"".join(blocks)
output.write_bytes(gzip.compress(payload,compresslevel=9,mtime=0))
print("Asset bytes:",len(payload),output.stat().st_size)
