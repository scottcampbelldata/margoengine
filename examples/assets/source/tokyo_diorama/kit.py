"""Shared helpers for the Tokyo corner diorama (Blender 5.3, bpy + bmesh only)."""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

FPS = 24
FRAME_START = 1
FRAME_END = 289  # 12 s loop: (289 - 1) / 24
SCENE = None


def srgb(hex_color):
    """'#rrggbb' -> linear RGB tuple."""
    h = hex_color.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def reset_scene():
    """Create or empty the 'Diorama' scene. Headless builds reuse the factory scene; the GUI keeps the user's scenes."""
    global SCENE
    if bpy.app.background:
        scene = bpy.context.scene
        scene.name = 'Diorama'
    else:
        scene = bpy.data.scenes.get('Diorama') or bpy.data.scenes.new('Diorama')
        window = bpy.context.window or bpy.context.window_manager.windows[0]
        window.scene = scene
    for ob in list(scene.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.actions):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)
    scene.render.fps = FPS
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
    SCENE = scene
    return scene


def material(name, color, roughness=0.75, metallic=0.0, emission=None, strength=0.0, double_sided=False):
    """Principled material 'TD_<name>', reused (and updated) across re-runs."""
    mat = bpy.data.materials.get('TD_' + name) or bpy.data.materials.new('TD_' + name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None) or nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (*srgb(color), 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Emission Color'].default_value = (*srgb(emission or '#000000'), 1.0)
    bsdf.inputs['Emission Strength'].default_value = strength if emission else 0.0
    mat.use_backface_culling = not double_sided
    mat.diffuse_color = (*srgb(color), 1.0)  # Solid-mode viewport colour in the live Blender session
    return mat


def _link(name, data, mat=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), parent=None):
    ob = bpy.data.objects.new(name, data)
    SCENE.collection.objects.link(ob)
    if data is not None and mat is not None:
        data.materials.append(mat)
    ob.parent = parent
    ob.location = loc
    ob.rotation_euler = rot
    ob.scale = scale
    return ob


def _mesh(name, bm, smooth=False):
    if smooth:
        for face in bm.faces:
            face.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def empty(name, loc, parent=None):
    ob = _link(name, None, loc=loc, parent=parent)
    ob.empty_display_size = 0.2
    return ob


def box(name, size, loc, mat, parent=None, rot=(0, 0, 0), bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, profile=0.5, affect='EDGES')
    return _link(name, _mesh(name, bm), mat, loc, rot, parent=parent)


def boxes(name, specs, mat, parent=None):
    """Many boxes in one mesh. specs: [(size, loc)] or [(size, loc, rot_euler)] in the object's local space."""
    bm = bmesh.new()
    for spec in specs:
        size, loc = spec[0], spec[1]
        rot = Euler(spec[2] if len(spec) > 2 else (0, 0, 0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.LocRotScale(Vector(loc), rot, Vector(size)))
    return _link(name, _mesh(name, bm), mat, parent=parent)


def cylinder(name, radius, depth, loc, mat, parent=None, rot=(0, 0, 0), segments=16, radius_top=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius,
                          radius2=radius if radius_top is None else radius_top, depth=depth)
    return _link(name, _mesh(name, bm, smooth=True), mat, loc, rot, parent=parent)


def sphere(name, radius, loc, mat, parent=None, scale=(1, 1, 1), segments=16, rings=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius)
    return _link(name, _mesh(name, bm, smooth=True), mat, loc, scale=scale, parent=parent)


def ico(name, radius, loc, mat, parent=None, scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
    return _link(name, _mesh(name, bm), mat, loc, scale=scale, parent=parent)


def prism(name, w, d, h, loc, mat, parent=None):
    """Gable roof: ridge along X, base w x d at z=0, apex at z=h."""
    bm = bmesh.new()
    a = [bm.verts.new(v) for v in ((-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (w / 2, d / 2, 0), (-w / 2, d / 2, 0))]
    r = [bm.verts.new((-w / 2, 0, h)), bm.verts.new((w / 2, 0, h))]
    for face in ((a[0], a[1], r[1], r[0]), (a[2], a[3], r[0], r[1]), (a[0], r[0], a[3]), (a[1], a[2], r[1]), (a[0], a[3], a[2], a[1])):
        bm.faces.new(face)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _link(name, _mesh(name, bm), mat, loc, parent=parent)


def rounded_slab(name, w, d, r, h, loc, mat, parent=None, seg=6):
    """Rounded-rectangle block, top face at the object origin, extruded h downward."""
    bm = bmesh.new()
    outline = []
    for cx, cy, start in ((w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, 90), (-w / 2 + r, -d / 2 + r, 180), (w / 2 - r, -d / 2 + r, 270)):
        for k in range(seg + 1):
            angle = math.radians(start + 90 * k / seg)
            outline.append(bm.verts.new((cx + r * math.cos(angle), cy + r * math.sin(angle), 0)))
    top = bm.faces.new(outline)
    extruded = bmesh.ops.extrude_face_region(bm, geom=[top])
    bmesh.ops.translate(bm, vec=(0, 0, -h), verts=[e for e in extruded['geom'] if isinstance(e, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _link(name, _mesh(name, bm), mat, loc, parent=parent)


def tube(name, points, radius, mat, parent=None, sides=6):
    """Open tube along a polyline (wires, rails, pipes, wheel rims)."""
    bm = bmesh.new()
    pts = [Vector(p) for p in points]
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u = t.cross(Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))).normalized()
        v = t.cross(u)
        rings.append([bm.verts.new(p + radius * (math.cos(k * math.tau / sides) * u + math.sin(k * math.tau / sides) * v)) for k in range(sides)])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
    return _link(name, _mesh(name, bm, smooth=True), mat, parent=parent)


def sag(a, b, drop, n=16):
    """Points of a sagging wire from a to b (parabola, lowest point `drop` below the chord)."""
    a, b = Vector(a), Vector(b)
    return [a.lerp(b, i / n) - Vector((0, 0, drop * 4 * (i / n) * (1 - i / n))) for i in range(n + 1)]


def ring(center, radius, axis, n=24):
    """Closed circle of points around `axis` ('X' or 'Y'), for wheel rims."""
    c = Vector(center)
    pts = []
    for k in range(n + 1):
        a = k * math.tau / n
        offset = Vector((0, math.cos(a), math.sin(a))) if axis == 'X' else Vector((math.cos(a), 0, math.sin(a)))
        pts.append(c + radius * offset)
    return pts


def glyph_specs(width, height, seed, cells=3, depth=0.012):
    """Abstract brush-stroke marks for a sign face in the XZ plane (front at -Y). Not real text."""
    rng = random.Random(seed)
    specs = []
    cell = width / cells
    for c in range(cells):
        cx = -width / 2 + cell * (c + 0.5)
        for _ in range(3):
            if rng.random() < 0.5:
                specs.append(((cell * rng.uniform(0.35, 0.7), depth, height * 0.08), (cx + rng.uniform(-0.1, 0.1) * cell, 0, rng.uniform(-0.3, 0.3) * height)))
            else:
                specs.append(((cell * 0.08, depth, height * rng.uniform(0.35, 0.7)), (cx + rng.uniform(-0.25, 0.25) * cell, 0, rng.uniform(-0.15, 0.15) * height)))
    return specs


def key(ob, frame, **values):
    for path, value in values.items():
        setattr(ob, path, value)
        ob.keyframe_insert(data_path=path, frame=frame)


def spin(ob, axis, turns):
    """Continuous rotation about an Euler axis over the whole clip (exporter samples every frame)."""
    rot = list(ob.rotation_euler)
    rot[axis] = 0.0
    key(ob, FRAME_START, rotation_euler=rot)
    rot[axis] = math.tau * turns
    key(ob, FRAME_END, rotation_euler=rot)


def swing(ob, axis, amplitude_deg, cycles, phase=0.0, step=6):
    """Sine swing about an Euler axis; integer `cycles` keeps the loop seamless."""
    base = list(ob.rotation_euler)
    for frame in range(FRAME_START, FRAME_END + 1, step):
        t = (frame - FRAME_START) / (FRAME_END - FRAME_START)
        rot = list(base)
        rot[axis] = base[axis] + math.radians(amplitude_deg) * math.sin(math.tau * (cycles * t + phase))
        key(ob, frame, rotation_euler=rot)


def text_mesh(name, text, height, loc, mat, parent=None, rot=(0, 0, 0), depth=0.0, width=None, space_line=1.0):
    """Flat (or extruded) lettering in Noto Sans CJK (SIL OFL, bundled with Blender), converted to a mesh."""
    import os
    font = bpy.data.fonts.load(os.path.join(bpy.utils.system_resource('DATAFILES'), 'fonts', 'Noto Sans CJK Regular.woff2'), check_existing=True)
    cu = bpy.data.curves.new(name + '_curve', 'FONT')
    cu.body, cu.font, cu.extrude, cu.resolution_u = text, font, depth, 2
    cu.align_x, cu.align_y = 'CENTER', 'CENTER'
    cu.space_line = space_line
    tmp = bpy.data.objects.new(name + '_tmp', cu)
    SCENE.collection.objects.link(tmp)
    view_layer = SCENE.view_layers[0]
    view_layer.update()
    scale = height / max(tmp.dimensions.y, 1e-4)
    tmp_dims_x = tmp.dimensions.x
    depsgraph = view_layer.depsgraph
    depsgraph.update()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(depsgraph))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(cu)
    sx = width / max(tmp_dims_x, 1e-4) if width else scale  # a width stretches the lettering, like road paint
    ob = _link(name, me, mat, loc, rot, (sx, scale, scale), parent)
    return ob
