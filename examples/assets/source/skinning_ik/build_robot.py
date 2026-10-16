"""Original Margo Light Keeper workshop island; execute through Blender MCP.

All geometry, the joint hierarchy, smooth skin weights, materials and furniture
are authored here. Coordinates below use glTF Y-up. Semantic forward is -Z.
"""
from pathlib import Path
import bpy
import json
import math
import traceback
import struct
import runpy
from mathutils import Vector, Quaternion

ROOT = Path(globals().get("PROJECT_ROOT", Path(__file__).resolve().parents[4]))
ASSETS = ROOT / "examples/assets"
SOURCE = ASSETS / "source/skinning_ik"
EVIDENCE = ROOT / "test-results/ik"


def g(p):
    return Vector((p[0], -p[2], p[1]))


def material(name, color, roughness=0.65, metallic=0, emission=None):
    m=bpy.data.materials.new(name)
    m.diffuse_color=(*color,1)
    m.use_nodes=True
    bsdf=m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value=(*color,1)
    bsdf.inputs["Roughness"].default_value=roughness
    bsdf.inputs["Metallic"].default_value=metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value=(*color,1)
        bsdf.inputs["Emission Strength"].default_value=emission
    return m


def finish(o,name,mat):
    o.name=name
    o.data.materials.append(mat)
    return o


def box(name,pos,size,mat,bevel=0.025):
    bpy.ops.mesh.primitive_cube_add(size=1,location=g(pos))
    o=finish(bpy.context.object,name,mat)
    o.dimensions=(size[0],size[2],size[1])
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        b=o.modifiers.new("Machined corner radius","BEVEL")
        b.width=bevel
        b.segments=3
        bpy.ops.object.modifier_apply(modifier=b.name)
        for p in o.data.polygons:p.use_smooth=True
        normals=o.modifiers.new("Weighted machined normals","WEIGHTED_NORMAL")
        normals.keep_sharp=True
        bpy.ops.object.modifier_apply(modifier=normals.name)
    return o


def cylinder(name,pos,radius,height,mat,vertices=48,top=None):
    if top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=height,location=g(pos))
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=radius,radius2=top,depth=height,location=g(pos))
    o=finish(bpy.context.object,name,mat)
    for p in o.data.polygons:
        p.use_smooth=len(p.vertices)==4
    return o


def rod(name,a,b,radius,mat,vertices=24):
    va,vb=g(a),g(b)
    o=cylinder(name,(0,0,0),radius,(vb-va).length,mat,vertices)
    o.location=(va+vb)*.5
    o.rotation_mode="QUATERNION"
    o.rotation_quaternion=Vector((0,0,1)).rotation_difference((vb-va).normalized())
    return o


def sphere(name,pos,radius,mat,segments=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=12,radius=radius,location=g(pos))
    o=finish(bpy.context.object,name,mat)
    for p in o.data.polygons:p.use_smooth=True
    return o


def ellipsoid(name,pos,size,mat):
    o=sphere(name,pos,1,mat,32)
    o.dimensions=(size[0],size[2],size[1])
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return o


def torso_shell(mat):
    rings=[(.70,.13,.11),(.75,.19,.14),(.94,.235,.17),(1.04,.225,.16),(1.115,.16,.12)]
    verts=[]
    faces=[]
    n=40
    for y,rx,rz in rings:
        for k in range(n):
            a=2*math.pi*k/n
            c,s=math.cos(a),math.sin(a)
            verts.append(g((rx*math.copysign(abs(c)**.67,c),y,.025+rz*math.copysign(abs(s)**.67,s))))
    for i in range(len(rings)-1):
        for k in range(n):
            j=(k+1)%n
            faces.append((i*n+k,i*n+j,(i+1)*n+j,(i+1)*n+k))
    faces.extend([tuple(reversed(range(n))),tuple((len(rings)-1)*n+k for k in range(n))])
    mesh=bpy.data.meshes.new("Tapered rounded torso shell")
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new("Tapered rounded porcelain torso shell",mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    for p in mesh.polygons:p.use_smooth=len(p.vertices)==4
    return o


def shaped_armor(name,a,b,r0,r1,mat):
    a,b=g(a),g(b)
    tangent=(b-a).normalized()
    side=tangent.cross(Vector((0,0,1)))
    if side.length<.1:side=tangent.cross(Vector((0,1,0)))
    side.normalize()
    normal=tangent.cross(side).normalized()
    rings=[(0,r0*.70),(.08,r0),(.42,r0*1.04),(.76,r1*1.08),(.94,r1),(1,r1*.67)]
    n=32
    verts=[]
    faces=[]
    for t,r in rings:
        center=a+(b-a)*t
        for i in range(n):
            angle=2*math.pi*i/n
            verts.append(center+side*math.cos(angle)*r+normal*math.sin(angle)*r*.86)
    for ring in range(len(rings)-1):
        for i in range(n):
            j=(i+1)%n
            faces.append((ring*n+i,ring*n+j,(ring+1)*n+j,(ring+1)*n+i))
    faces.extend([tuple(reversed(range(n))),tuple((len(rings)-1)*n+i for i in range(n))])
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    for p in mesh.polygons:p.use_smooth=len(p.vertices)==4
    return o


def curved_chest(mat):
    profiles=[(.745,.145,.133),(.80,.19,.155),(.95,.23,.178),(1.035,.218,.168),(1.085,.17,.143)]
    n=28
    verts=[]
    faces=[]
    for y,rx,rz in profiles:
        for i in range(n+1):
            a=math.pi+math.pi*.07+math.pi*.86*i/n
            c,s=math.cos(a),math.sin(a)
            verts.append(g((rx*math.copysign(abs(c)**.67,c),y,.025+rz*math.copysign(abs(s)**.67,s))))
    for row in range(len(profiles)-1):
        for i in range(n):faces.append((row*(n+1)+i,row*(n+1)+i+1,(row+1)*(n+1)+i+1,(row+1)*(n+1)+i))
    mesh=bpy.data.meshes.new("Compound curved teal chest armor")
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new("Compound curved teal chest armor",mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    for p in mesh.polygons:p.use_smooth=True
    bpy.context.view_layer.objects.active=o
    solid=o.modifiers.new("Enamel panel thickness","SOLIDIFY")
    solid.thickness=.008
    bpy.ops.object.modifier_apply(modifier=solid.name)
    return o


def chest_z(x,y):
    profiles=[(.745,.145,.133),(.80,.19,.155),(.95,.23,.178),(1.035,.218,.168),(1.085,.17,.143)]
    for (a,rx0,rz0),(b,rx1,rz1) in zip(profiles,profiles[1:]):
        if a<=y<=b:
            t=(y-a)/(b-a)
            rx=rx0+(rx1-rx0)*t
            rz=rz0+(rz1-rz0)*t
            c=min(1,(abs(x)/rx)**(1/.67))
            return .025-rz*(max(0,1-c*c)**(.67/2))-.004
    return -.14


def skin(o,arm,bone,weights=None):
    # Mesh stays at its authored world rest transform. Identity armature object
    # and identity parent inverse produce unambiguous inverse bind matrices.
    o.parent=arm
    mod=o.modifiers.new("Margo four influence skin","ARMATURE")
    mod.object=arm
    if weights is None:
        group=o.vertex_groups.new(name=bone)
        group.add(list(range(len(o.data.vertices))),1,"REPLACE")
    else:
        for name,values in weights.items():
            group=o.vertex_groups.new(name=name)
            for vertex,weight in values:
                if weight>0:group.add([vertex],weight,"REPLACE")
    return o


def sleeve(name,points,names,arm,mat):
    a,b,c=map(g,points)
    u=(b-a).length
    v=(c-b).length
    steps=32
    sides=16
    verts=[]
    faces=[]
    weights={n:[] for n in names}
    for i in range(steps+1):
        s=(u+v)*i/steps
        if s<=u:
            center=a+(b-a)*(s/u)
            tangent=(b-a).normalized()
        else:
            center=b+(c-b)*((s-u)/v)
            tangent=(c-b).normalized()
        # Smooth the rest centerline through the elbow's short bellows section.
        if abs(s-u)<.075:
            tangent=((b-a).normalized()*(u+.075-s)+(c-b).normalized()*(s-u+.075)).normalized()
        side=tangent.cross(Vector((0,0,1)))
        if side.length<.1:side=tangent.cross(Vector((0,1,0)))
        side.normalize()
        normal=tangent.cross(side).normalized()
        radius=.058-.012*(s/(u+v))
        segment_t=s/u if s<=u else (s-u)/v
        def smooth(t):
            t=max(0,min(1,t))
            return t*t*(3-2*t)
        armored=smooth((segment_t-.12)/.06)*smooth((.75-segment_t)/.07)
        radius*=1-.60*armored
        # Ribs are geometry and share smooth weights across the elbow.
        radius*=1+.10*math.cos(i*math.pi)
        half_blend=min(.045,min(u,v)*.15)
        blend=max(0,min(1,(s-u+half_blend)/(2*half_blend)))
        for k in range(sides):
            angle=2*math.pi*k/sides
            index=len(verts)
            verts.append(center+radius*(side*math.cos(angle)+normal*math.sin(angle)))
            weights[names[0]].append((index,1-blend))
            weights[names[1]].append((index,blend))
    for i in range(steps):
        for k in range(sides):
            n=(k+1)%sides
            faces.append((i*sides+k,i*sides+n,(i+1)*sides+n,(i+1)*sides+k))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(steps*sides+k for k in range(sides)))
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    for p in mesh.polygons:p.use_smooth=True
    skin(o,arm,None,weights)
    return o


def leaf(name,a,b,width,mat):
    a,b=g(a),g(b)
    axis=(b-a).normalized()
    side=axis.cross(Vector((0,0,1)))
    if side.length<.1:side=axis.cross(Vector((0,1,0)))
    side.normalize()
    mid=(a+b)*.5
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([a,mid-side*width,b,mid+side*width,mid+Vector((0,0,.03))],[],[(0,1,4),(1,2,4),(2,3,4),(3,0,4)])
    o=bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    return o


def chest_marking(text,y,size,mat,arm):
    bpy.ops.object.text_add(location=g((0,y,chest_z(0,y)-.0015)))
    obj=bpy.context.object
    obj.name="Painted chest marking / "+text
    obj.data.body=text
    obj.data.align_x="CENTER"
    obj.data.size=size
    obj.data.extrude=.0002
    obj.data.resolution_u=4
    obj.rotation_euler=(math.pi/2,0,math.pi)
    obj.data.materials.append(mat)
    bpy.ops.object.convert(target="MESH")
    skin(bpy.context.object,arm,"Body")
    return bpy.context.object


def pegboard(name,pos,width,height,mat):
    # Closed perforations are modeled as rings, rather than painted dots.
    nx,ny=8,7
    dx,dy=width/nx,height/ny
    verts=[]
    faces=[]
    for iy in range(ny):
        for ix in range(nx):
            cx=pos[0]-width*.5+(ix+.5)*dx
            cy=pos[1]-height*.5+(iy+.5)*dy
            start=len(verts)
            outer=[(-dx*.5,-dy*.5),(0,-dy*.5),(dx*.5,-dy*.5),(dx*.5,0),(dx*.5,dy*.5),(0,dy*.5),(-dx*.5,dy*.5),(-dx*.5,0)]
            inner=[(math.cos(-3*math.pi/4+k*math.pi/4)*.009,math.sin(-3*math.pi/4+k*math.pi/4)*.009) for k in range(8)]
            for z in (pos[2]-.013,pos[2]+.013):
                verts.extend(g((cx+x,cy+y,z)) for x,y in outer+inner)
            for k in range(8):
                n=(k+1)%8
                faces.extend([(start+k,start+n,start+8+n,start+8+k),
                    (start+16+n,start+16+k,start+24+k,start+24+n),
                    (start+8+k,start+8+n,start+24+n,start+24+k),
                    (start+k,start+16+k,start+16+n,start+n)])
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    o=bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(mat)
    return o


def export(path,selected=False,animations=False):
    bpy.ops.export_scene.gltf(filepath=str(path),export_format="GLB",use_selection=selected,
        export_apply=False,export_texcoords=True,export_normals=True,export_tangents=True,
        export_materials="EXPORT",export_image_format="AUTO",
        export_draco_mesh_compression_enable=False,export_yup=True,
        export_skins=True,export_all_influences=False,export_animations=animations,
        export_animation_mode="ACTIONS",export_force_sampling=False,
        export_frame_range=True,export_cameras=False,export_lights=False,export_extras=True)
    # Blender's matrix decomposition emits harmless ~1e-7 deviations on bone
    # scales. Canonicalize those unit transforms for strict runtime IK checks.
    blob=path.read_bytes()
    json_len=struct.unpack_from("<I",blob,12)[0]
    document=json.loads(blob[20:20+json_len])
    for node in document.get("nodes",[]):
        if "scale" in node and max(abs(v-1) for v in node["scale"])<1e-6:
            del node["scale"]
    skinned={i for i,node in enumerate(document["nodes"]) if "skin" in node}
    for node in document["nodes"]:
        if "children" in node:
            node["children"]=[i for i in node["children"] if i not in skinned]
            if not node["children"]:del node["children"]
    for scene in document["scenes"]:
        scene["nodes"]=list(dict.fromkeys(scene["nodes"]+sorted(skinned)))
    document["asset"]["copyright"]="Copyright (c) 2026 Scott Campbell. MIT License."
    encoded=json.dumps(document,separators=(",",":"),ensure_ascii=False).encode("utf-8")
    encoded+=b" "*((-len(encoded))%4)
    remainder=blob[20+json_len:]
    path.write_bytes(struct.pack("<III",0x46546C67,2,20+len(encoded)+len(remainder))+struct.pack("<II",len(encoded),0x4E4F534A)+encoded+remainder)


def build():
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    # The dedicated MCP instance contains only a startup file or this source.
    if bpy.data.filepath and Path(bpy.data.filepath).name!="skinning-ik.blend":
        raise RuntimeError("Preserve the open source and open an empty file first")
    if not bpy.data.filepath and bpy.data.is_dirty:
        raise RuntimeError("Preserve the unsaved Blender scene before rebuilding")
    for o in list(bpy.data.objects):bpy.data.objects.remove(o,do_unlink=True)
    for action in list(bpy.data.actions):bpy.data.actions.remove(action)
    for mesh in list(bpy.data.meshes):
        if mesh.users==0:bpy.data.meshes.remove(mesh)
    for mat in list(bpy.data.materials):
        if mat.users==0:bpy.data.materials.remove(mat)
    for im in list(bpy.data.images):
        if im.users==0 and im.type not in {"RENDER_RESULT","COMPOSITING"}:bpy.data.images.remove(im)

    cream=material("Light keeper / porcelain enamel",(.80,.75,.61),.35,.12)
    teal=material("Light keeper / oxidized teal",(.025,.075,.068),.46,.25)
    dark=material("Light keeper / flexible charcoal bellows",(.025,.035,.036),.75)
    copper=material("Light keeper / copper joints",(.54,.26,.105),.32,.8)
    visor=material("Light keeper / deep glass visor",(.012,.035,.038),.16,.25)
    eye=material("Light keeper / amber optical glow",(.95,.36,.045),.22,.3,1.2)
    walnut=material("Workshop / warm walnut",(.22,.10,.044),.5)
    sand=material("Workshop / pale stone plinth",(.55,.50,.40),.95)
    clay=material("Workshop / clay ceramic",(.53,.22,.12),.9)
    green=material("Workshop / sage foliage",(.055,.15,.035),.85)
    soil=material("Workshop / dark soil",(.04,.027,.016),1)
    paper=material("Workshop / sketchbook paper",(.83,.79,.67),.95)

    shoulder=(-.24,1.03,0)
    elbow=(-.44,.84,-.08)
    wrist=(-.48,1.04,-.23)
    rshoulder=(.25,1.03,.01)
    relbow=(.34,.82,.05)
    rwrist=(.29,.70,-.06)
    defs=[("Root",(0,0,0),(0,.20,0),None),
          ("Body",(0,.70,.02),(0,1.10,.02),"Root"),
          ("Head",(0,1.15,0),(0,1.40,0),"Body"),
          ("UpperArm",shoulder,elbow,"Body"),
          ("Forearm",elbow,wrist,"UpperArm"),
          ("Hand",wrist,(-.48,1.04,-.34),"Forearm"),
          ("RightUpperArm",rshoulder,relbow,"Body"),
          ("RightForearm",relbow,rwrist,"RightUpperArm"),
          ("RightHand",rwrist,(.29,.65,-.09),"RightForearm")]
    data=bpy.data.armatures.new("LightKeeperRig")
    arm=bpy.data.objects.new("LightKeeper",data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active=arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name,head,tail,parent in defs:
        bone=data.edit_bones.new(name)
        bone.head=g(head)
        bone.tail=g(tail)
        if parent:bone.parent=data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.show_in_front=True
    arm["copyright"]="Copyright 2026 Scott Campbell. Original Margo Engine Light Keeper robot and workshop. MIT."
    arm["forward"]="glTF -Z"
    arm["ik_chain"]="UpperArm > Forearm > Hand"

    # Continuous weighted skin bends visibly across the elbow, with 2 influences.
    sleeve("Left arm continuous deforming bellows",(shoulder,elbow,wrist),("UpperArm","Forearm"),arm,dark)
    sleeve("Right arm continuous bellows",(rshoulder,relbow,rwrist),("RightUpperArm","RightForearm"),arm,dark)
    for prefix,pts,bones in [("Left",(shoulder,elbow,wrist),("UpperArm","Forearm","Hand")),("Right",(rshoulder,relbow,rwrist),("RightUpperArm","RightForearm","RightHand"))]:
        for i in range(2):
            a,b=Vector(pts[i]),Vector(pts[i+1])
            d=b-a
            skin(shaped_armor(prefix+" sculpted enamel arm shell "+str(i),a+d*.18,a+d*.68,.078 if i==0 else .063,.056 if i==0 else .052,cream),arm,bones[i])
            offset=Vector((0,0,.06))
            skin(rod(prefix+" exposed arm piston barrel",a+d*.17+offset,a+d*.46+offset,.017,dark),arm,bones[i])
            skin(rod(prefix+" polished arm piston shaft",a+d*.44+offset,a+d*.77+offset,.008,copper),arm,bones[i])
        skin(sphere(prefix+" shoulder copper bearing",pts[0],.083,copper),arm,bones[0])
        cap=Vector(pts[0])+(Vector(pts[1])-Vector(pts[0]))*.12
        skin(ellipsoid(prefix+" curved porcelain shoulder cap",cap,(.18,.18,.165),cream),arm,bones[0])
        skin(sphere(prefix+" elbow copper hinge",pts[1],.058,copper),arm,bones[1])
        skin(sphere(prefix+" wrist bearing",pts[2],.048,copper),arm,bones[2])
        pole=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[1])).normalized()
        for point,radius,bone in [(Vector(pts[0]),.080,bones[0]),(Vector(pts[1]),.059,bones[1])]:
            skin(rod(prefix+" exposed bearing axle",point-pole*.07,point+pole*.07,radius*.52,dark),arm,bone)
            for side in (-1,1):
                skin(rod(prefix+" copper bearing washer",point+pole*side*.065,point+pole*side*.079,radius,copper),arm,bone)
                skin(rod(prefix+" hexagonal bearing hub",point+pole*side*.080,point+pole*side*.087,radius*.37,dark,6),arm,bone)
    skin(ellipsoid("Curved palm supporting the orb",(-.48,1.04,-.245),(.14,.052,.125),dark),arm,"Hand")
    skin(ellipsoid("Palm porcelain back armor",(-.48,1.018,-.245),(.13,.026,.115),cream),arm,"Hand")
    for x in (-.53,-.48,-.43):
        tip_z=-.23-math.sqrt((.10465342044830322+.012)**2-(x+.48)**2-.03**2)
        points=[(x,1.05,-.275),(x,1.075,-.315),(x,1.115,tip_z-.008),(x,1.14,tip_z)]
        for i,(a,b) in enumerate(zip(points,points[1:])):
            skin(rod("Gripping finger phalange "+str(i),a,b,.012,cream if i!=1 else teal),arm,"Hand")
            skin(sphere("Gripping finger dark knuckle",a,.014,dark,16),arm,"Hand")
        skin(sphere("Gripping finger pad",points[-1],.013,dark,16),arm,"Hand")
    thumb=[(-.425,1.045,-.22),(-.382,1.078,-.22),(-.387,1.12,-.23)]
    for a,b in zip(thumb,thumb[1:]):
        skin(rod("Opposing thumb phalange",a,b,.014,cream),arm,"Hand")
        skin(sphere("Opposing thumb knuckle",a,.016,copper,16),arm,"Hand")
    skin(box("Right gripper",(.29,.675,-.075),(.105,.08,.09),teal,.018),arm,"RightHand")

    skin(torso_shell(cream),arm,"Body")
    skin(curved_chest(teal),arm,"Body")
    for side in (-1,1):
        trim=[(side*x,y,chest_z(side*x,y)) for x,y in [(.12,.815),(.165,.91),(.15,1.025)]]
        for a,b in zip(trim,trim[1:]):
            skin(rod("Chest copper edge trim",a,b,.006,copper),arm,"Body")
        for y in (.84,1.02):
            skin(sphere("Chest copper shell fastener",(side*.135,y,chest_z(side*.135,y)),.012,copper,16),arm,"Body")
    for x in (-.055,0,.055):
        skin(box("Chest lower ventilation slit",(x,.835,chest_z(x,.835)),(.028,.008,.008),dark,.002),arm,"Body")
    chest_marking("M",1.025,.032,cream,arm)
    chest_marking("01",.877,.022,cream,arm)
    skin(cylinder("Copper neck collar",(0,1.15,0),.061,.075,copper,48),arm,"Head")
    for y in (1.123,1.14,1.157,1.174,1.19):
        skin(cylinder("Exposed ribbed neck articulation",(0,y,0),.065,.008,dark,48),arm,"Head")
    skin(box("Smaller rounded porcelain optical skull",(0,1.315,-.005),(.305,.23,.25),cream,.065),arm,"Head")
    skin(box("Binocular dark mechanical mounting plate",(0,1.33,-.138),(.282,.162,.025),dark,.04),arm,"Head")
    for x in (-.074,.074):
        skin(rod("Binocular cream lens housing",(x,1.34,-.138),(x,1.34,-.190),.072,cream),arm,"Head")
        skin(rod("Binocular copper lens barrel",(x,1.34,-.191),(x,1.34,-.203),.066,copper),arm,"Head")
        skin(rod("Binocular dark optical rim",(x,1.34,-.204),(x,1.34,-.215),.057,dark),arm,"Head")
        skin(rod("Binocular inner copper focus ring",(x,1.34,-.216),(x,1.34,-.222),.047,copper),arm,"Head")
        skin(rod("Binocular recessed optical glass",(x,1.34,-.223),(x,1.34,-.226),.041,visor),arm,"Head")
        skin(rod("Dim metallic amber iris",(x,1.34,-.227),(x,1.34,-.230),.018,copper),arm,"Head")
        skin(rod("Tiny luminous amber pupil",(x,1.34,-.231),(x,1.34,-.233),.0085,eye),arm,"Head")
        for angle in (math.pi*.25,math.pi*.75,math.pi*1.25,math.pi*1.75):
            sx,sy=x+math.cos(angle)*.059,1.34+math.sin(angle)*.059
            skin(rod("Lens housing recessed screw",(sx,sy,-.204),(sx,sy,-.210),.004,dark),arm,"Head")
        skin(sphere("Optical glass glint",(x-.011,1.351,-.231),.0035,cream,12),arm,"Head")
    skin(box("Dark optical brow",(0,1.407,-.09),(.23,.025,.10),dark,.012),arm,"Head")
    skin(box("Top copper range sensor",(0,1.441,-.01),(.105,.026,.075),copper,.009),arm,"Head")
    for x in (-.022,0,.022):
        skin(box("Range sensor grille",(x,1.449,-.049),(.01,.012,.005),dark,.002),arm,"Head")
    for x,side in ((-.15,-1),(.15,1)):
        skin(rod("Head copper side bearing",(x,1.33,0),(x+side*.035,1.33,0),.055,copper),arm,"Head")
        skin(rod("Head dark side cap",(x+side*.035,1.33,0),(x+side*.043,1.33,0),.037,dark),arm,"Head")
    skin(box("Small copper mouth",(0,1.245,-.136),(.07,.012,.018),copper,.005),arm,"Head")
    skin(box("Finished back battery panel",(0,.93,.192),(.29,.27,.025),teal,.025),arm,"Body")
    for y in (.85,.90,.95,1.0):
        skin(box("Battery cooling vent",(0,y,.211),(.20,.014,.012),dark,.004),arm,"Body")
    for x in (-.12,.12):
        for y in (.82,1.04):
            skin(sphere("Rear copper fastener",(x,y,.212),.012,copper,12),arm,"Body")
    for y in (1.27,1.32,1.37):
        skin(box("Head rear ventilation",(0,y,.126),(.21,.015,.012),teal,.005),arm,"Head")
    skin(cylinder("Exposed narrow dark waist swivel",(0,.715,.025),.105,.075,dark,48),arm,"Root")
    skin(cylinder("Copper waist pressure ring",(0,.727,.025),.108,.012,copper,48),arm,"Root")
    skin(ellipsoid("Sculpted porcelain hip shell",(0,.655,.025),(.285,.15,.24),cream),arm,"Root")
    skin(ellipsoid("Curved porcelain pelvic guard",(0,.65,-.093),(.17,.11,.04),cream),arm,"Root")
    for side in (-1,1):
        skin(rod("Exposed hip copper bearing",(side*.125,.665,.025),(side*.175,.665,.025),.060,copper),arm,"Root")
        skin(rod("Hip hexagonal pressure fastener",(side*.176,.665,.025),(side*.185,.665,.025),.028,dark,6),arm,"Root")
    for x in (-.13,.13):
        skin(rod("Dark thigh mechanical core",(x,.66,.025),(x,.37,.015),.049,dark),arm,"Root")
        skin(shaped_armor("Long tapered porcelain thigh armor",(x,.660,.028),(x,.432,.018),.075,.057,cream),arm,"Root")
        for y in (.402,.414,.426):
            skin(cylinder("Exposed thigh ribbed gaiter",(x,y,.018),.057,.006,dark,32),arm,"Root")
        skin(sphere("Copper knee",(x,.37,.015),.069,copper),arm,"Root")
        skin(rod("Knee lateral pressure axle",(x-.08,.37,.015),(x+.08,.37,.015),.041,dark),arm,"Root")
        skin(rod("Dark calf mechanical core",(x,.34,.015),(x,.145,.015),.042,dark),arm,"Root")
        skin(shaped_armor("Sculpted tapered porcelain calf",(x,.315,.018),(x,.168,.014),.067,.051,cream),arm,"Root")
        skin(shaped_armor("Teal shin armor inset",(x,.30,-.027),(x,.18,-.029),.044,.030,teal),arm,"Root")
        skin(sphere("Articulated copper ankle",(x,.145,.015),.055,copper),arm,"Root")
        skin(box("Slim porcelain boot heel",(x,.073,.018),(.142,.125,.135),cream,.032),arm,"Root")
        skin(box("Articulated slim porcelain toe",(x,.050,-.10),(.130,.082,.145),cream,.030),arm,"Root")
        skin(box("Thin grounded boot sole",(x,.004,-.04),(.146,.010,.255),dark,.003),arm,"Root")
        for z in (-.10,-.07):
            skin(box("Inset toe articulation seam",(x,.092,z),(.10,.003,.005),dark,.001),arm,"Root")

    furniture_path=SOURCE/"workshop.py"
    runpy.run_path(str(furniture_path))["build"]({**globals(),**locals()})

    # Each material becomes one skinned assembly with all named vertex groups.
    # This preserves the articulated parts while avoiding hundreds of draws.
    assemblies={}
    for obj in list(bpy.context.scene.objects):
        if obj.type=="MESH" and obj.parent==arm:
            key=obj.data.materials[0].name
            assemblies.setdefault(key,[]).append(obj)
    for name,parts in assemblies.items():
        labels=[obj.name for obj in parts]
        bpy.ops.object.select_all(action="DESELECT")
        for obj in parts:obj.select_set(True)
        bpy.context.view_layer.objects.active=parts[0]
        if len(parts)>1:bpy.ops.object.join()
        obj=bpy.context.object
        obj.name="LightKeeper assembly / "+name.split(" / ")[-1]
        obj["authored_parts"]=json.dumps(labels)

    scene=bpy.context.scene
    scene.frame_start,scene.frame_end=1,97
    scene.render.fps=24
    head=arm.pose.bones["Head"]
    head.rotation_mode="QUATERNION"
    for f,angle in ((1,0),(25,.018),(49,0),(73,-.012),(97,0)):
        head.rotation_quaternion=Quaternion((0,1,0),angle)
        head.keyframe_insert(data_path="rotation_quaternion",frame=f,group="Optical idle")
    arm.animation_data.action.name="Light keeper idle"
    scene.frame_set(1)
    for p in arm.pose.bones:p.scale=(1,1,1)

    bpy.ops.object.camera_add(location=g((-2.7,1.9,-3.6)))
    camera=bpy.context.object
    camera.name="Light keeper workshop review camera"
    camera.rotation_euler=(g((.12,.86,0))-camera.location).to_track_quat("-Z","Y").to_euler()
    camera.data.lens=48
    scene.camera=camera
    for name,pos,energy,size in [("Warm key",(-2,4,-3),600,4),("Workshop fill",(2,3,2),400,3)]:
        bpy.ops.object.light_add(type="AREA",location=g(pos))
        o=bpy.context.object
        o.name=name
        o.data.energy=energy
        o.data.shape="DISK"
        o.data.size=size
        o.rotation_euler=(g((0,.7,0))-o.location).to_track_quat("-Z","Y").to_euler()
    scene.world.color=(.16,.16,.16)
    scene.render.engine="BLENDER_EEVEE"
    scene.render.resolution_x=1200
    scene.render.resolution_y=1100
    scene.render.resolution_percentage=100
    scene.view_settings.view_transform="AgX"
    surface_module=SOURCE/"surface_textures.py"
    if surface_module.exists():
        runpy.run_path(str(surface_module))["apply"](scene,ROOT)
    dedication_module=SOURCE/"dedication.py"
    if dedication_module.exists():
        runpy.run_path(str(dedication_module))["apply"](scene,ROOT)
    for obj in scene.objects:
        if obj.type=="MESH":
            surface_uv=obj.data.uv_layers.get("SurfaceUV")
            for layer in list(obj.data.uv_layers):
                if layer!=surface_uv:obj.data.uv_layers.remove(layer)
            if surface_uv:
                obj.data.uv_layers.active=surface_uv
                surface_uv.active_render=True
            # Blender's tangent generator rejects ngons even though the glTF
            # exporter can triangulate positions. Apply this before deformation.
            bpy.context.view_layer.objects.active=obj
            tri=obj.modifiers.new("Portable tangent triangulation","TRIANGULATE")
            if hasattr(tri,"keep_custom_normals"):tri.keep_custom_normals=True
            obj.modifiers.move(len(obj.modifiers)-1,0)
            bpy.ops.object.modifier_apply(modifier=tri.name)
    export(ASSETS/"skinning-ik.glb",animations=True)

    chrome=material("Interaction orb / polished silver mirror",(.91,.93,.95),.045,1)
    orb=sphere("Mirror interaction orb",(0,0,0),.10465342044830322,chrome,48)
    bpy.ops.object.select_all(action="DESELECT")
    orb.select_set(True)
    bpy.context.view_layer.objects.active=orb
    export(ASSETS/"skinning-ik-orb.glb",selected=True)
    orb.location=g((-.48,1.17,-.23))
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS/"source/skinning-ik.blend"))
    report={"status":"complete","origin":[0,0,0],"forward":[0,0,-1],
        "shoulder":list(shoulder),"elbow":list(elbow),"wrist":list(wrist),
        "orb":[-.48,1.17,-.23],"orbRadius":.10465342044830322,
        "orbWristOffset":[0,.13,0],"chain":["UpperArm","Forearm","Hand"],
        "head":"Head","camera":[-2.7,1.9,-3.6],"cameraTarget":[.12,.86,0],
        "main":str(ASSETS/"skinning-ik.glb"),"orbAsset":str(ASSETS/"skinning-ik-orb.glb"),
        "blend":bpy.data.filepath}
    (EVIDENCE/"blender-build-status.json").write_text(json.dumps(report,indent=2))
    scene.render.filepath=str(EVIDENCE/"blender-robot.png")
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS/"source/skinning-ik.blend"))
    return report


if __name__=="__main__":
    try:
        result=build()
    except Exception:
        EVIDENCE.mkdir(parents=True,exist_ok=True)
        (EVIDENCE/"blender-build-status.json").write_text(json.dumps({"status":"error","traceback":traceback.format_exc()},indent=2))
        raise
