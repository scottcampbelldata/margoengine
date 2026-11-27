"""Author the Clark-style timber-and-cell raft in Blender; run with --background --python."""
import json
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[4]
HERE = ROOT / "test-results" / "sea12-raft"
HERE.mkdir(parents=True, exist_ok=True)
TAU = math.tau
TUBE_RADIUS = 0.1524
TUBE_LENGTH = 0.6096
PITCH = 0.6316
COURSES = (-0.594, -0.198, 0.198, 0.594)
DRY_WOOD_DENSITY = 540.0
SHEET_THICKNESS = 0.0009
STEEL_DENSITY = 7850.0
volume_vertices, volume_indices = [], []
materials, groups = {}, {}
wood_volume = 0.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = "METRIC"
for name in ("Timber", "Float Chambers", "Fasteners", "Hand Lines", "Displacement"):
    group = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(group)
    groups[name] = group


def map_image(name, rgb, linear=False):
    size = rgb.shape[0]
    image = bpy.data.images.new(name, width=size, height=size, alpha=False, float_buffer=linear)
    if linear:
        image.colorspace_settings.name = "Non-Color"
    rgba = np.concatenate((np.clip(rgb, 0, 1), np.ones((size, size, 1), dtype=np.float32)), axis=2)
    image.pixels.foreach_set(rgba.astype(np.float32, copy=False).ravel())
    image.file_format = "PNG"
    image.filepath_raw = str(HERE / (name + ".png"))
    image.save()
    image.pack()
    image.filepath = "//" + name + ".png"
    return image


def periodic_noise(x, y, fx, fy, seed):
    rng = np.random.default_rng(seed)
    grid = rng.random((fy, fx))
    vx, vy = x * fx, y * fy
    ix, iy = np.floor(vx).astype(int), np.floor(vy).astype(int)
    u, v = vx - ix, vy - iy
    u, v = u * u * (3 - 2 * u), v * v * (3 - 2 * v)
    k, l = ix % fx, iy % fy
    m, n = (ix + 1) % fx, (iy + 1) % fy
    return (1 - v) * (grid[l, k] * (1 - u) + grid[l, m] * u) + v * (grid[n, k] * (1 - u) + grid[n, m] * u)


def material(name, color, roughness, metallic):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    materials[name] = mat
    return mat, bsdf


def textured_mat(name, albedo, rough, metal, height, detail):
    mat, bsdf = material(name, (0.3, 0.3, 0.3), 0.65, 0)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    def node(img, x, y):
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.location = (x, y)
        return tex
    base = node(map_image(name + "_Color", albedo), -570, 280)
    packed = np.stack((np.ones_like(rough), rough, np.full_like(rough, metal)), axis=2)
    orm = node(map_image(name + "_ORM", packed, True), -570, 0)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-250, 0)
    dv = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * detail
    du = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * detail
    length = np.sqrt(1 + du * du + dv * dv)
    normal = np.stack((0.5 - 0.5 * du / length, 0.5 - 0.5 * dv / length, 0.5 + 0.5 / length), axis=2)
    tex_normal = node(map_image(name + "_Normal", normal, True), -570, -300)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-250, -255)
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(orm.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    links.new(tex_normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def make_materials():
    u, v = np.meshgrid(np.arange(1024) / 1024, np.arange(1024) / 1024)
    grain = periodic_noise(u, v, 11, 183, 161)
    pores = periodic_noise(u, v, 55, 232, 12)
    warp = 0.014 * periodic_noise(u, v, 7, 13, 81) + 0.002 * np.sin(TAU * (2 * u + v))
    pull = np.zeros_like(u)
    knots = np.zeros_like(u)
    for x, y, scale in ((0.18, 0.23, 0.8), (0.60, 0.54, 0.87), (0.84, 0.79, 0.58), (0.43, 0.08, 0.64)):
        a, b = (u - x + 0.5) % 1 - 0.5, (v - y + 0.5) % 1 - 0.5
        radius = np.sqrt((a / 0.30) ** 2 + (b / 0.92) ** 2) / scale
        pull += 0.026 * np.exp(-(radius / 0.11) ** 2)
        knots += 0.11 * np.exp(-(radius / 0.035) ** 2) + 0.034 * np.exp(-(radius / 0.108) ** 2) * (0.5 + 0.5 * np.sin(605 * radius))
    latewood = (0.5 + 0.5 * np.sin(TAU * (34 * (v + warp + pull)))) ** 6
    stain = periodic_noise(u, v, 6, 24, 23)
    value = 0.10 * grain - 0.041 * latewood - knots + 0.065 * stain + 0.036 * pores
    color = np.array([0.485, 0.355, 0.245]) + value[:, :, None] * np.array([1.0, 0.85, 0.65])
    textured_mat("M_Timber_Pine", color, 0.53 + 0.29 * stain - 0.10 * latewood, 0, 0.55 * grain + 0.32 * latewood + 0.30 * pores, 0.75)

    u, v = np.meshgrid(np.arange(512) / 512, np.arange(512) / 512)
    mottling = periodic_noise(u, v, 31, 39, 77)
    oxidation = periodic_noise(u, v, 15, 19, 45) * periodic_noise(u, v, 9, 7, 83)
    bead = periodic_noise(u, v, 130, 140, 8)
    steel = np.array([0.42, 0.451, 0.444]) + (0.10 * mottling - 0.16 * oxidation + 0.042 * bead)[:, :, None]
    textured_mat("M_Tinned_Sheet", steel, 0.45 + 0.27 * oxidation + 0.13 * mottling, 1, 0.60 * bead + 0.26 * mottling, 0.36)
    material("M_Blackened_Iron", (0.086, 0.075, 0.063), 0.65, 1)
    material("M_Hemp_Dark", (0.195, 0.123, 0.063), 0.84, 0)
    material("M_Hemp_Light", (0.293, 0.186, 0.090), 0.88, 0)


def mesh_object(name, coords, faces, mat, group, smooth=False, uv=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(coords, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    groups[group].objects.link(obj)
    if mat:
        data.materials.append(materials[mat])
    if uv:
        mapping = data.uv_layers.new(name="UVMap")
        for polygon in data.polygons:
            polygon.use_smooth = smooth
            for loop in polygon.loop_indices:
                mapping.data[loop].uv = uv(data.vertices[data.loops[loop].vertex_index].co, polygon.normal)
    elif smooth:
        for polygon in data.polygons:
            polygon.use_smooth = True
    return obj


def add_displacement(obj):
    obj.data.calc_loop_triangles()
    start = len(volume_vertices) // 3
    # Blender Z-up to glTF Y-up. This proper rotation preserves winding.
    for vertex in obj.data.vertices:
        x, y, z = vertex.co
        volume_vertices.extend([round(x, 7), round(z, 7), round(-y, 7)])
    for face in obj.data.loop_triangles:
        volume_indices.extend(start + index for index in face.vertices)


def timber(name, center, width, axis, bevel, slot):
    global wood_volume
    sx, sy, sz = (d * 0.5 for d in width)
    x, y, z = center
    coords = [(x + a * sx, y + b * sy, z + c * sz) for a,b,c in
              [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    shell = [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]
    def uv(co, normal):
        across = 1 - axis if abs(normal.z) > 0.55 else 2
        return co[axis] * 0.63 + slot * 0.119, co[across] * 3.4 + slot * 0.073
    obj = mesh_object(name, coords, shell, "M_Timber_Pine", "Timber", uv=uv)
    add_displacement(obj)
    wood_volume += math.prod(width)
    modifier = obj.modifiers.new("Rounded timber edges", "BEVEL")
    modifier.width = bevel
    modifier.segments = 3
    modifier.limit_method = "ANGLE"
    normal = obj.modifiers.new("Weighted face normals", "WEIGHTED_NORMAL")
    normal.keep_sharp = True


def ring_object(name, center, axis, rings, segments, material_name, group, texture_slot=0):
    origin = Vector(center)
    axis = Vector(axis).normalized()
    u = axis.cross(Vector((0, 1, 0))).normalized()
    if u.length < 0.5:
        u = axis.cross(Vector((0, 0, 1))).normalized()
    v = axis.cross(u)
    coords = []
    for t, radius in rings:
        for index in range(segments):
            angle = index * TAU / segments
            coords.append(origin + t * axis + radius * (math.cos(angle) * u + math.sin(angle) * v))
    faces = []
    for ring in range(len(rings) - 1):
        a = ring * segments
        for index in range(segments):
            next_index = (index + 1) % segments
            faces.append((a + index, a + next_index, a + next_index + segments, a + index + segments))
    # Flat caps use triangles through an actual center to keep topology explicit.
    for ring, backwards in ((0, True), (len(rings)-1, False)):
        at = ring * segments
        center_vertex = len(coords)
        coords.append(origin + rings[ring][0] * axis)
        for j in range(segments):
            face = (center_vertex, at + j, at + (j + 1) % segments)
            faces.append(face[::-1] if backwards else face)
    def uv(co, _normal):
        d = co - origin
        return d.dot(axis) * 1.41 + texture_slot * 0.139, math.atan2(d.dot(v), d.dot(u)) / TAU + texture_slot * 0.213
    obj = mesh_object(name, coords, faces, material_name, group, smooth=True, uv=uv)
    sides = (len(rings) - 1) * segments
    uvs = obj.data.uv_layers.active.data
    for face in obj.data.polygons:
        if face.index >= sides:
            face.use_smooth = False
            for index in face.loop_indices:
                d = obj.data.vertices[obj.data.loops[index].vertex_index].co - origin
                uvs[index].uv = (
                    0.5 + d.dot(u) * 2.7 + texture_slot * 0.139,
                    0.5 + d.dot(v) * 2.7 + texture_slot * 0.213,
                )
        else:
            values = [uvs[index].uv.y for index in face.loop_indices]
            if max(values) - min(values) > 0.5:
                for index in face.loop_indices:
                    if uvs[index].uv.y < max(values) - 0.5:
                        uvs[index].uv.y += 1.0
    return obj


def rails_and_fenders():
    deck_stations = [-0.735 + 0.147 * i for i in range(11)]
    for flip in (-1, 1):
        letter = "A" if flip > 0 else "B"
        widths = (0.108, 0.103, 0.111, 0.106, 0.109, 0.119, 0.107, 0.113, 0.103, 0.111, 0.108)
        for j, y in enumerate(deck_stations):
            length = 3.203 - (0.075 if abs(y) > 0.70 else 0.004 * (j % 3))
            timber(
                f"SM_Deck_{letter}_Rail_{j+1:02d}", (0, y, flip * 0.202),
                (length, widths[j], 0.019), 0, 0.004, j + flip * 8,
            )
        for j, x in enumerate((-1.567, -0.9474, -0.3158, 0.3158, 0.9474, 1.567)):
            timber(f"SM_Deck_{letter}_CrossTie_{j+1:02d}", (x, 0, flip*0.172), (0.053, 1.585, 0.041), 1, 0.004, j + flip * 11)
            for piece, y in enumerate(deck_stations):
                ring_object(f"SM_Deck_{letter}_Nut_{j+1:02d}_{piece+1}", (x,y,flip*0.215), (0,0,flip),
                            [(-0.006,0.014),(0.001,0.014),(0.005,0.011),(0.009,0.010)], 6, "M_Blackened_Iron", "Fasteners")
    for side in (-1, 1):
        timber(f"SM_Fender_{'Starboard' if side < 0 else 'Port'}", (0, side*0.829,0),
               (3.220, 0.065, 0.260), 0, 0.016, side*5)
        for x in (-1.567, -0.9474, -0.3158, 0.3158, 0.9474, 1.567):
            ring_object("SM_FenderTiePin", (x, side*0.802, 0), (0,0,1), [(-0.185,0.010),(0.185,0.010)], 12,
                        "M_Blackened_Iron","Fasteners")


def chambers():
    end = TUBE_LENGTH * 0.5
    for course, y in enumerate(COURSES):
        for tube in range(5):
            x = (tube-2) * PITCH
            name = f"{course+1:02d}_{tube+1:02d}"
            rings = [(-end, TUBE_RADIUS-0.014), (-end+0.007, TUBE_RADIUS-0.004),
                     (-end+0.026,TUBE_RADIUS), (end-0.026,TUBE_RADIUS),
                     (end-0.007,TUBE_RADIUS-0.004), (end,TUBE_RADIUS-0.014)]
            ring_object(f"SM_AirChamber_{name}", (x,y,0), (1,0,0), rings, 48,
                        "M_Tinned_Sheet", "Float Chambers", course*5+tube)
            # Match the circular section's area with 16 edges. Keep the visible original at 48.
            sections = 16
            angle = TAU / sections
            area_scale = math.sqrt(angle / math.sin(angle))
            displacement_rings = [(t, radius * area_scale) for t, radius in rings]
            proxy = ring_object(f"SM_SealedFloat_{name}", (x,y,0), (1,0,0), displacement_rings, sections,
                                None, "Displacement")
            add_displacement(proxy)
            for tip in (-1, 1):
                shoulder = x + tip*(end - 0.017)
                ring_object(f"SM_FoldedSeam_{name}_{tip}", (shoulder,y,0), (1,0,0),
                            [(-0.009,TUBE_RADIUS-0.002),(-0.004,TUBE_RADIUS+0.003),
                             (0.004,TUBE_RADIUS+0.003),(0.009,TUBE_RADIUS-0.002)], 48,
                            "M_Blackened_Iron", "Fasteners")
                for k in range(25):
                    theta = k * TAU / 25
                    dy, dz = math.cos(theta), math.sin(theta)
                    r = TUBE_RADIUS + 0.002
                    ring_object(f"SM_Rivet_{name}_{tip}_{k+1:02d}", (shoulder,y+r*dy,r*dz), (0,dy,dz),
                                [(-0.0015,0.004),(0.001,0.004),(0.0027,0.0028)], 7,
                                "M_Blackened_Iron","Fasteners")
            for k in range(21):
                t = (k-10)*0.025
                ring_object(f"SM_LongSeamRivet_{name}_{k+1:02d}", (x+t,y+TUBE_RADIUS,0), (0,1,0),
                            [(-0.002,0.004),(0.0008,0.004),(0.0025,0.0029)], 6,
                            "M_Blackened_Iron","Fasteners")
    for x in (-0.9474, -0.3158, 0.3158, 0.9474):
        for y in COURSES:
            ring_object("SM_ChamberLinkPin", (x,y,0), (0,0,1), [(-0.153,0.008),(0.153,0.008)], 12,
                        "M_Blackened_Iron","Fasteners")


def hemp(name, side, left, right):
    # A safety line spans the outer fender from one timber ring to the next.
    n, cross = 128, 7
    for strand in range(3):
        coords = []
        for i in range(n):
            f = i/(n-1)
            angle = TAU*(22*f + strand/3)
            x = left + (right-left)*f
            y = side*(0.865 + 0.038*math.sin(math.pi*f))
            z = -0.019 - 0.085*math.sin(math.pi*f)
            for j in range(cross):
                theta = j*TAU/cross
                coords.append((x,y+0.0074*math.cos(angle)+0.0048*math.cos(theta),
                               z+0.0074*math.sin(angle)+0.0048*math.sin(theta)))
        faces = []
        for i in range(n-1):
            for j in range(cross):
                a, b = i*cross+j, i*cross+(j+1)%cross
                faces.append((a,b,b+cross,a+cross))
        for i in range(1,cross-1):
            k = (n-1)*cross
            faces.extend(((0,i+1,i),(k,k+i,k+i+1)))
        mesh_object(name+f"_{strand+1}", coords, faces, "M_Hemp_Dark" if strand==0 else "M_Hemp_Light",
                    "Hand Lines", smooth=True)
    for x in (left,right):
        ring_object("SM_HandLineBoss", (x,side*0.859,-0.019), (0,side,0),
                    [(-0.007,0.027),(0.006,0.027),(0.011,0.019)], 12, "M_Blackened_Iron","Fasteners")


def export_runtime():
    render_objects = [obj for name, coll in groups.items() if name != "Displacement" for obj in coll.objects]
    # Preserve individually editable construction parts in the source. The runtime uses one node per material.
    groups["Displacement"].hide_render = True
    groups["Displacement"].hide_viewport = True
    bpy.context.scene["historical_reference"] = "George Clark US146316A; Smithsonian TR.325945. Period interpretation for SEA-12."
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE / "cyprus-raft.blend"), compress=True)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bpy.ops.object.select_all(action="DESELECT")
    for key, mat in materials.items():
        clones = []
        for obj in render_objects:
            if obj.data.materials[0] != mat:
                continue
            mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                                   depsgraph=depsgraph)
            clone = bpy.data.objects.new(key, mesh)
            bpy.context.scene.collection.objects.link(clone)
            clone.select_set(True)
            clones.append(clone)
        bpy.context.view_layer.objects.active = clones[0]
        if len(clones)>1:
            bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = "SM_ClarkRaft_" + key[2:]
        merged.select_set(False)
    for obj in bpy.context.scene.collection.objects:
        if obj.name.startswith("SM_ClarkRaft_"):
            obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(HERE / "cyprus-raft.raw.glb"), export_format="GLB", use_selection=True,
                             export_extras=True, export_texcoords=True, export_normals=True, export_tangents=True,
                             export_materials="EXPORT")


make_materials()
rails_and_fenders()
chambers()
for side in (-1, 1):
    for i, (left,right) in enumerate(((-1.42,-0.51),(-0.46,0.46),(0.51,1.42))):
        hemp(f"SM_HandLine_{side}_{i+1:02d}",side,left,right)

steel_area = 20 * (TAU*TUBE_RADIUS*TUBE_LENGTH + TAU*TUBE_RADIUS**2)
raft_mass = DRY_WOOD_DENSITY*wood_volume + steel_area*SHEET_THICKNESS*STEEL_DENSITY + 12.0
with (HERE / "cyprus-raft-displacement.json").open("w", encoding="utf8") as f:
    json.dump({"vertices": volume_vertices, "indices": volume_indices, "massKg": round(raft_mass, 3),
               "bounds":[3.22, 0.462, 1.815]}, f, separators=(",", ":"))
    f.write("\n")
export_runtime()
print(f"CYPRUS_RAFT {raft_mass:.3f} kg, wood {wood_volume:.4f} m³, physics {len(volume_indices)//3} tris")
