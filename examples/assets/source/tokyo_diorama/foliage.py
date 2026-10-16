"""Stylised foliage: a painted leaf-cluster sprite sheet (rendered once per build) on dense alpha-cut cards around a
solid green core, so canopies read as full, rounded and leafy. Topiary trees, potted bushes and boxy hedges.
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

import kit
import polyhaven

SHEET = 'foliage_sprites.png'
LEAF_TONES = ('#2c5524', '#3d7330', '#4f8f3a', '#68a845', '#86c056')
CELL = {'leaf': (0.0, 0.5), 'bloom': (0.5, 1.0)}  # u ranges in the sheet; v spans 0..1


def _emit(name, hex_color):
    mat = bpy.data.materials.get('TD_sheet_' + name) or bpy.data.materials.new('TD_sheet_' + name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    em = nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*kit.srgb(hex_color), 1.0)
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(em.outputs['Emission'], out.inputs['Surface'])
    return mat


def _shape(scene, name, pts, z, color):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, y, z) for x, y in pts], [], [list(range(len(pts)))])
    me.materials.append(_emit(color.strip('#'), color))
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)


def _leaf(cx, cy, length, width, angle, n=14):
    pts = []
    for k in range(n):
        t = math.tau * k / n
        x, y = 0.5 * length * math.cos(t), 0.5 * width * math.sin(t) * (1 - 0.35 * math.cos(t))  # fuller at the base, pointed tip
        pts.append((cx + x * math.cos(angle) - y * math.sin(angle), cy + x * math.sin(angle) + y * math.cos(angle)))
    return pts


def build_sprites():
    """Render the two-cell sprite sheet (leaf cluster | leaves with blossoms) with transparency; returns the image."""
    sheet = bpy.data.scenes.get('TD_FoliageSheet') or bpy.data.scenes.new('TD_FoliageSheet')
    for ob in list(sheet.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    rng = random.Random(5)
    for cell, cx in (('leaf', 0.5), ('bloom', 1.5)):
        z = 0.0
        for layer, tone in enumerate(LEAF_TONES):  # back to front, dark to light: painted depth
            for k in range(26 if layer < 4 else 14):
                r = 0.42 * math.sqrt(rng.random()) * (1.0 - 0.12 * layer)
                a = rng.uniform(0, math.tau)
                x, y = cx + r * math.cos(a), 0.5 + r * math.sin(a)
                z += 0.0005
                _shape(sheet, '%s_leaf_%d_%d' % (cell, layer, k), _leaf(x, y, rng.uniform(0.12, 0.19), rng.uniform(0.06, 0.09), rng.uniform(0, math.tau)), z, tone)
        if cell == 'bloom':
            for k in range(13):
                r = 0.38 * math.sqrt(rng.random())
                a = rng.uniform(0, math.tau)
                x, y = cx + r * math.cos(a), 0.5 + r * math.sin(a)
                z += 0.0005
                for p in range(5):
                    pa = math.tau * p / 5 + a
                    _shape(sheet, 'bloom_%d_%d' % (k, p), _leaf(x + 0.022 * math.cos(pa), y + 0.022 * math.sin(pa), 0.045, 0.034, pa, n=10), z, '#f8f5ee')
                _shape(sheet, 'bloom_%d_eye' % k, _leaf(x, y, 0.018, 0.018, 0, n=8), z + 0.0002, '#f2c94c')
    cam_data = bpy.data.cameras.get('TD_FoliageCam') or bpy.data.cameras.new('TD_FoliageCam')
    cam_data.type, cam_data.ortho_scale = 'ORTHO', 2.0
    cam = bpy.data.objects.new('TD_FoliageCam', cam_data)
    cam.location = (1.0, 0.5, 5.0)
    sheet.collection.objects.link(cam)
    sheet.camera = cam
    sheet.render.engine = 'CYCLES'
    sheet.cycles.samples = 16
    sheet.cycles.max_bounces = 0
    sheet.render.film_transparent = True
    sheet.view_settings.view_transform = 'Standard'
    sheet.render.resolution_x, sheet.render.resolution_y, sheet.render.resolution_percentage = 1024, 512, 100
    sheet.render.image_settings.file_format = 'PNG'
    sheet.render.image_settings.color_mode = 'RGBA'
    path = os.path.join(polyhaven.CACHE, SHEET)
    sheet.render.filepath = path
    wm = bpy.context.window_manager
    window = bpy.context.window or (wm.windows[0] if wm.windows else None)
    override = {'scene': sheet}
    if window is not None:
        override['window'] = window
    with bpy.context.temp_override(**override):
        bpy.ops.render.render(write_still=True, scene=sheet.name)
    for ob in list(sheet.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.scenes.remove(sheet)
    image = bpy.data.images.get(SHEET)
    if image is not None:
        bpy.data.images.remove(image)
    image = bpy.data.images.load(path)
    image.name = SHEET
    return image


def material():
    """Alpha-cut (glTF MASK via Math Round), double-sided foliage material on the sprite sheet."""
    mat = bpy.data.materials.get('TD_foliage') or bpy.data.materials.new('TD_foliage')
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images[SHEET]
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = 0.8
    cut = nodes.new('ShaderNodeMath')
    cut.operation = 'ROUND'
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    links.new(tex.outputs['Alpha'], cut.inputs[0])
    links.new(cut.outputs['Value'], bsdf.inputs['Alpha'])
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    mat.use_backface_culling = False
    mat.diffuse_color = (0.3, 0.55, 0.2, 1.0)
    return mat


class Cards:
    """Collects leaf cards into one mesh (one draw call per group)."""

    def __init__(self, seed):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.rng = random.Random(seed)

    def card(self, centre, normal, size, cell):
        normal = Vector(normal).normalized()
        t = normal.cross(Vector((0, 0, 1)) if abs(normal.z) < 0.95 else Vector((1, 0, 0))).normalized()
        b = normal.cross(t)
        roll = self.rng.uniform(0, math.tau)
        t, b = t * math.cos(roll) + b * math.sin(roll), b * math.cos(roll) - t * math.sin(roll)
        h = size / 2
        verts = [self.bm.verts.new(Vector(centre) + (t * sx + b * sy) * h) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        face = self.bm.faces.new(verts)
        u0, u1 = CELL[cell]
        for loop, (u, v) in zip(face.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))):
            loop[self.uv].uv = (u, v)

    def ball(self, centre, radius, squash=1.0, bloom=0.0, count=None):
        """Rounded canopy: cards on a Fibonacci sphere just outside the core, facing out, with jitter."""
        n = count or max(18, int(260 * radius * radius / 0.0225))
        golden = math.pi * (3 - math.sqrt(5))
        for i in range(n):
            z = 1 - 2 * (i + 0.5) / n
            r = math.sqrt(1 - z * z)
            d = Vector((r * math.cos(golden * i), r * math.sin(golden * i), z))
            d = (d + Vector((self.rng.gauss(0, 0.12), self.rng.gauss(0, 0.12), self.rng.gauss(0, 0.12)))).normalized()
            p = Vector(centre) + Vector((d.x, d.y, d.z * squash)) * radius * self.rng.uniform(0.86, 1.02)
            self.card(p, d + Vector((0, 0, 0.25)), radius * self.rng.uniform(0.62, 0.8), 'bloom' if self.rng.random() < bloom else 'leaf')

    def block(self, centre, size, bloom=0.0, step=0.07):
        """Boxy hedge: cards over the top and sides of a box, leaning outward."""
        cx, cy, cz = centre
        sx, sy, sz = size
        faces = [((0, 0, 1), (sx, sy), lambda a, b: (cx + a, cy + b, cz + sz / 2))]
        for axis, sign in ((0, 1), (0, -1), (1, 1), (1, -1)):
            if axis == 0:
                faces.append(((sign, 0, 0), (sy, sz), lambda a, b, sign=sign: (cx + sign * sx / 2, cy + a, cz + b)))
            else:
                faces.append(((0, sign, 0), (sx, sz), lambda a, b, sign=sign: (cx + a, cy + sign * sy / 2, cz + b)))
        for normal, (w, h), at in faces:
            nu, nv = max(1, int(w / step)), max(1, int(h / step))
            for i in range(nu):
                for j in range(nv):
                    a = -w / 2 + w * (i + self.rng.random()) / nu
                    b = -h / 2 + h * (j + self.rng.random()) / nv
                    n = Vector(normal) + Vector((self.rng.gauss(0, 0.35), self.rng.gauss(0, 0.35), self.rng.gauss(0, 0.35) + 0.2))
                    self.card(Vector(at(a, b)) + Vector(normal) * 0.01, n, step * self.rng.uniform(1.6, 2.1), 'bloom' if self.rng.random() < bloom else 'leaf')

    def finish(self, name, parent):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        return kit._link(name, me, material(), parent=parent)


def topiary(atlas, name, base, height, parent=None, bloom=0.25, pot=True, seed=0):
    """Round-headed standard tree: pot, slim trunk, dense leafy ball."""
    x, y, z = base
    radius = height * 0.24
    group = kit.empty(name, (x, y, z), parent)
    if pot:
        atlas.add(kit.cylinder(name + '_Pot', height * 0.11, height * 0.2, (0, 0, height * 0.1), None, group, segments=16, radius_top=height * 0.13), 'concrete')
        atlas.add(kit.cylinder(name + '_Soil', height * 0.12, 0.01, (0, 0, height * 0.2), None, group, segments=16), 'soil')
    atlas.add(kit.tube(name + '_Trunk', [(0, 0, 0), (0.01, 0, height * 0.45), (-0.01, 0, height - radius)], max(0.012, height * 0.025), None, group, sides=6), 'wood_dark')
    atlas.add(kit.sphere(name + '_Core', radius * 0.86, (0, 0, height - radius), None, group, segments=16, rings=10), 'paint:#35622a')
    cards = Cards(seed)
    cards.ball((0, 0, height - radius), radius, bloom=bloom)
    cards.finish(name + '_Leaves', group)
    return group


def bush(atlas, name, centre, radius, parent=None, bloom=0.0, seed=0):
    atlas.add(kit.sphere(name + '_Core', radius * 0.84, centre, None, parent, scale=(1, 1, 0.85), segments=14, rings=8), 'paint:#35622a')
    cards = Cards(seed)
    cards.ball(centre, radius, squash=0.85, bloom=bloom)
    return cards.finish(name + '_Leaves', parent)


def hedge(atlas, name, centre, size, parent=None, bloom=0.0, seed=0):
    atlas.add(kit.box(name + '_Core', (size[0] * 0.94, size[1] * 0.9, size[2] * 0.94), centre, None, parent, bevel=min(size) * 0.2), 'paint:#35622a')
    cards = Cards(seed)
    cards.block(centre, size, bloom=bloom)
    return cards.finish(name + '_Leaves', parent)
