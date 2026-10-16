"""Sign artwork atlas: original lettering (Noto Sans CJK, SIL OFL, bundled with Blender) and simple shape illustrations,
rendered once with Cycles into `signs_atlas.png`. `panel()` places a UV-mapped sign face in the scene.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

import kit
import polyhaven

GRID = 8            # 8 x 8 cells of 256 px on a 2048 atlas
PX = 2048

# id: (cells w, cells h, background, text colour, border, text, vertical, icon, lit)
SIGNS = {
    'billboard': (4, 2, '#fbe7c6', '#7a3b1e', '#3a2a22', 'たぬき茶', False, 'tanuki', True),
    'vending': (2, 3, '#e8463a', '#ffffff', '#b8322a', '', False, 'drinks', True),
    'kissa': (3, 1, '#4a2e1f', '#f6e3bd', '#2a1a12', '喫茶 たぬき', False, 'cup', False),
    'izakaya': (3, 1, '#2b2522', '#ff9a3c', '#121010', '居酒屋 まる', False, 'lantern', True),
    'ramen_v': (1, 3, '#c8332b', '#fff4e0', '#5a1612', 'ラーメン', True, None, True),
    'coffee_v': (1, 3, '#5a3420', '#fff4e0', '#2a1a12', 'コーヒー', True, None, False),
    'pharmacy_v': (1, 3, '#ffffff', '#d23a2f', '#d23a2f', '薬局', True, None, True),
    'ramen_h': (2, 1, '#f3c54a', '#3a2010', '#3a2010', 'らーめん', False, 'bowl', False),
    'sushi': (2, 1, '#f4f1ea', '#1f3a66', '#1f3a66', '寿司', False, 'fish', False),
    'sake_v': (1, 2, '#1f2c4a', '#ffffff', '#0e1626', '酒', True, None, False),
    'books': (2, 1, '#2f6b4f', '#ffffff', '#1d4231', '本屋', False, None, False),
    'tobacco': (1, 2, '#d8392f', '#ffffff', '#8a1f18', 'たばこ', True, None, True),
    'street': (2, 1, '#2b5aa8', '#ffffff', '#ffffff', '電車通り', False, None, False),
    'bath': (2, 1, '#7fc4c8', '#18394a', '#18394a', '銭湯', False, 'waves', False),
    'menu': (1, 2, '#2c2a26', '#f2e6c8', '#6a4a2a', '中華そば\n餃子\nビール', False, None, False),
    'noren_a': (2, 1, '#1f2f55', '#ffffff', '#1f2f55', 'らーめん', False, None, False),
    'noren_b': (2, 1, '#7a2a22', '#ffffff', '#7a2a22', 'おでん', False, None, False),
    'open': (1, 1, '#ffffff', '#c8332b', '#c8332b', '営業中', False, None, False),
    'coffee': (1, 1, '#3a2418', '#ffffff', '#f2c06a', '', False, 'cup', True),
    'coin': (1, 1, '#f1c24a', '#7a4a10', '#7a4a10', '', False, 'coin', True),
    'lantern_red': (1, 1, '#d8382f', '#1a1210', '#d8382f', '祭', False, None, True),
    'lantern_white': (1, 1, '#f6efe0', '#c8332b', '#f6efe0', '酒', False, None, True),
    'no_bikes': (1, 1, '#ffffff', '#c8332b', '#c8332b', '駐輪\n禁止', False, None, False),
    'poster_a': (1, 1, '#f7d7c4', '#2a3a7a', '#f7d7c4', '夏祭り', False, 'flower', False),
    'poster_b': (1, 1, '#c9e4f0', '#1e2a44', '#c9e4f0', '花火', False, 'burst', False),
    'number': (1, 1, '#2b3a4a', '#ffffff', '#ffffff', '三丁目\n７', False, None, False),
}

_rects = {}


def _font():
    path = os.path.join(bpy.utils.system_resource('DATAFILES'), 'fonts', 'Noto Sans CJK Regular.woff2')
    return bpy.data.fonts.load(path, check_existing=True)


def _pack():
    """Shelf-pack the signs into the grid; returns id -> (cx, cy, w, h) in cells (cx, cy = lower-left)."""
    placed, free = {}, [[True] * GRID for _ in range(GRID)]
    for sid, spec in sorted(SIGNS.items(), key=lambda kv: -kv[1][0] * kv[1][1]):
        w, h = spec[0], spec[1]
        done = False
        for y in range(GRID - h + 1):
            for x in range(GRID - w + 1):
                if all(free[y + j][x + i] for i in range(w) for j in range(h)):
                    for i in range(w):
                        for j in range(h):
                            free[y + j][x + i] = False
                    placed[sid] = (x, y, w, h)
                    done = True
                    break
            if done:
                break
        if not done:
            raise ValueError('sign atlas full at ' + sid)
    return placed


def _emit(scene, name, hex_color):
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


def _shape(scene, name, verts_2d, z, hex_color, faces=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, y, z) for x, y in verts_2d], [], faces or [list(range(len(verts_2d)))])
    me.materials.append(_emit(scene, hex_color.strip('#'), hex_color))
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


def _ellipse(cx, cy, rx, ry, n=40, start=0.0, end=math.tau):
    return [(cx + rx * math.cos(start + (end - start) * k / n), cy + ry * math.sin(start + (end - start) * k / n)) for k in range(n + (0 if end - start >= math.tau - 1e-6 else 1))]


def _rounded(x0, y0, x1, y1, r, seg=6):
    pts = []
    for cx, cy, a0 in ((x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180), (x1 - r, y0 + r, 270)):
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _icon(scene, kind, x, y, s, z, tag):
    """Original simple illustrations drawn from flat shapes; (x, y) centre, s size."""
    shapes = []
    add = lambda name, pts, col, dz=0.0: shapes.append(_shape(scene, '%s_%s' % (tag, name), pts, z + dz, col))  # noqa: E731
    if kind == 'tanuki':
        add('ear_l', _ellipse(x - 0.3 * s, y + 0.32 * s, 0.13 * s, 0.13 * s), '#6b4630')
        add('ear_r', _ellipse(x + 0.3 * s, y + 0.32 * s, 0.13 * s, 0.13 * s), '#6b4630')
        add('head', _ellipse(x, y, 0.42 * s, 0.38 * s), '#a87650', 0.001)
        add('muzzle', _ellipse(x, y - 0.12 * s, 0.2 * s, 0.15 * s), '#f3e2c4', 0.002)
        add('mask_l', _ellipse(x - 0.17 * s, y + 0.04 * s, 0.13 * s, 0.09 * s), '#3b2a22', 0.002)
        add('mask_r', _ellipse(x + 0.17 * s, y + 0.04 * s, 0.13 * s, 0.09 * s), '#3b2a22', 0.002)
        add('eye_l', _ellipse(x - 0.16 * s, y + 0.05 * s, 0.045 * s, 0.05 * s), '#ffffff', 0.003)
        add('eye_r', _ellipse(x + 0.16 * s, y + 0.05 * s, 0.045 * s, 0.05 * s), '#ffffff', 0.003)
        add('nose', _ellipse(x, y - 0.07 * s, 0.05 * s, 0.035 * s), '#2a1c16', 0.003)
        add('cheek_l', _ellipse(x - 0.28 * s, y - 0.12 * s, 0.06 * s, 0.035 * s), '#f2a39a', 0.003)
        add('cheek_r', _ellipse(x + 0.28 * s, y - 0.12 * s, 0.06 * s, 0.035 * s), '#f2a39a', 0.003)
        add('leaf', [(x - 0.05 * s, y + 0.3 * s), (x + 0.12 * s, y + 0.48 * s), (x + 0.08 * s, y + 0.3 * s)], '#5c9a3e', 0.004)
    elif kind == 'cup':
        add('cup', _ellipse(x, y - 0.05 * s, 0.25 * s, 0.22 * s, start=math.pi, end=math.tau) + [(x + 0.25 * s, y + 0.05 * s), (x - 0.25 * s, y + 0.05 * s)], '#ffffff')
        add('handle', _ellipse(x + 0.27 * s, y - 0.02 * s, 0.08 * s, 0.07 * s), '#ffffff')
        add('saucer', _ellipse(x, y - 0.3 * s, 0.34 * s, 0.05 * s), '#e9d3a8', 0.001)
        for k, dx in enumerate((-0.1, 0.0, 0.1)):
            add('steam%d' % k, [(x + dx * s - 0.015 * s, y + 0.12 * s), (x + dx * s + 0.015 * s, y + 0.12 * s), (x + dx * s + 0.03 * s, y + 0.34 * s), (x + dx * s, y + 0.34 * s)], '#f5e9d0')
    elif kind == 'bowl':
        add('bowl', _ellipse(x, y, 0.36 * s, 0.26 * s, start=math.pi, end=math.tau), '#c8332b')
        add('rim', _ellipse(x, y + 0.01 * s, 0.37 * s, 0.05 * s), '#7a1c16', 0.001)
        add('stick1', [(x - 0.05 * s, y), (x - 0.02 * s, y), (x + 0.25 * s, y + 0.38 * s), (x + 0.22 * s, y + 0.38 * s)], '#d9b37a', 0.002)
        add('stick2', [(x + 0.03 * s, y), (x + 0.06 * s, y), (x + 0.33 * s, y + 0.34 * s), (x + 0.3 * s, y + 0.34 * s)], '#d9b37a', 0.002)
        add('pattern', _ellipse(x, y - 0.12 * s, 0.12 * s, 0.04 * s), '#ffffff', 0.002)
    elif kind == 'fish':
        add('body', _ellipse(x - 0.03 * s, y, 0.3 * s, 0.14 * s), '#e86a4a')
        add('tail', [(x + 0.24 * s, y), (x + 0.42 * s, y + 0.13 * s), (x + 0.42 * s, y - 0.13 * s)], '#e86a4a')
        add('belly', _ellipse(x - 0.06 * s, y - 0.05 * s, 0.2 * s, 0.05 * s), '#ffd2bf', 0.001)
        add('eye', _ellipse(x - 0.22 * s, y + 0.03 * s, 0.035 * s, 0.035 * s), '#1a1a1a', 0.002)
    elif kind == 'lantern':
        add('body', _ellipse(x, y, 0.18 * s, 0.3 * s), '#ff7a3a')
        add('top', [(x - 0.12 * s, y + 0.28 * s), (x + 0.12 * s, y + 0.28 * s), (x + 0.12 * s, y + 0.34 * s), (x - 0.12 * s, y + 0.34 * s)], '#1a1210', 0.001)
        add('bottom', [(x - 0.12 * s, y - 0.34 * s), (x + 0.12 * s, y - 0.34 * s), (x + 0.12 * s, y - 0.28 * s), (x - 0.12 * s, y - 0.28 * s)], '#1a1210', 0.001)
    elif kind == 'coin':
        add('coin', _ellipse(x, y, 0.38 * s, 0.38 * s), '#e0a92e')
        add('rim', _ellipse(x, y, 0.31 * s, 0.31 * s), '#f4cf5c', 0.001)
        add('hole', [(x - 0.08 * s, y - 0.08 * s), (x + 0.08 * s, y - 0.08 * s), (x + 0.08 * s, y + 0.08 * s), (x - 0.08 * s, y + 0.08 * s)], '#7a4a10', 0.002)
    elif kind == 'waves':
        for k in range(3):
            add('wave%d' % k, _ellipse(x - 0.2 * s + 0.2 * s * k, y, 0.09 * s, 0.09 * s, start=0, end=math.pi), '#ffffff')
    elif kind == 'flower':
        for k in range(5):
            a = math.tau * k / 5
            add('petal%d' % k, _ellipse(x + 0.16 * s * math.cos(a), y + 0.16 * s * math.sin(a), 0.11 * s, 0.11 * s), '#f06d8a')
        add('centre', _ellipse(x, y, 0.08 * s, 0.08 * s), '#ffd54a', 0.001)
    elif kind == 'burst':
        for k in range(10):
            a = math.tau * k / 10
            add('ray%d' % k, [(x, y), (x + 0.38 * s * math.cos(a - 0.08), y + 0.38 * s * math.sin(a - 0.08)), (x + 0.38 * s * math.cos(a + 0.08), y + 0.38 * s * math.sin(a + 0.08))], ('#ff6a5a', '#ffd54a', '#7ad0ff')[k % 3])
    elif kind == 'drinks':
        colors = ('#2b6cb0', '#f2c94c', '#27ae60', '#eb5757', '#ffffff', '#9b51e0', '#f2994a', '#56ccf2')
        for row in range(4):
            for col in range(5):
                cx, cy = x - 0.36 * s + col * 0.18 * s, y + 0.38 * s - row * 0.2 * s
                add('can%d%d' % (row, col), _rounded(cx - 0.06 * s, cy - 0.08 * s, cx + 0.06 * s, cy + 0.08 * s, 0.025 * s), colors[(row * 3 + col) % len(colors)])
                add('btn%d%d' % (row, col), _ellipse(cx, cy - 0.11 * s, 0.015 * s, 0.015 * s), '#9be7ff', 0.001)
        add('slot', _rounded(x - 0.4 * s, y - 0.62 * s, x + 0.4 * s, y - 0.46 * s, 0.03 * s), '#2a2a2a')
        add('panel', _rounded(x - 0.44 * s, y - 0.4 * s, x + 0.44 * s, y + 0.5 * s, 0.03 * s), '#f4f7f8', -0.0005)
    return shapes


def build_atlas():
    """Render every sign into the atlas image (cached per build); returns the image."""
    global _rects
    _rects = _pack()
    sheet = bpy.data.scenes.get('TD_SignSheet')
    if sheet is not None:
        for ob in list(sheet.collection.all_objects):
            bpy.data.objects.remove(ob, do_unlink=True)
    else:
        sheet = bpy.data.scenes.new('TD_SignSheet')
    font = _font()
    for sid, (cx, cy, w, h) in _rects.items():
        _, _, bg, fg, border, text, vertical, icon, _ = SIGNS[sid]
        inset = 0.035
        _shape(sheet, sid + '_border', _rounded(cx + 0.01, cy + 0.01, cx + w - 0.01, cy + h - 0.01, 0.12), 0.0, border)
        _shape(sheet, sid + '_bg', _rounded(cx + inset + 0.03, cy + inset + 0.03, cx + w - inset - 0.03, cy + h - inset - 0.03, 0.09), 0.001, bg)
        text_box = [cx + 0.12, cy + 0.12, cx + w - 0.12, cy + h - 0.12]
        if icon:
            if text and w < 2:  # narrow sign: illustration above, caption below
                size = w * 0.62
                _icon(sheet, icon, cx + w / 2, cy + h - 0.1 - size / 2, size, 0.002, sid)
                text_box[3] = cy + h - 0.14 - size
            elif text:
                size = min(h, 1.0) * 0.9
                _icon(sheet, icon, cx + 0.12 + size / 2, cy + h / 2, size, 0.002, sid)
                text_box[0] = cx + 0.18 + size
            else:
                _icon(sheet, icon, cx + w / 2, cy + h / 2, min(w, h) * 0.9, 0.002, sid)
        if text:
            cu = bpy.data.curves.new(sid + '_text', 'FONT')
            cu.body = '\n'.join(text.replace('ー', '丨')) if vertical else text  # vertical long-vowel mark
            cu.font = font
            cu.align_x, cu.align_y = 'CENTER', 'CENTER'
            cu.space_line = 0.9
            cu.resolution_u = 3
            ob = bpy.data.objects.new(sid + '_text', cu)
            ob.data.materials.append(_emit(sheet, fg.strip('#'), fg))
            sheet.collection.objects.link(ob)
            sheet.view_layers[0].update()
            dims = ob.dimensions
            bw, bh = text_box[2] - text_box[0], text_box[3] - text_box[1]
            k = min(bw / max(dims.x, 1e-4), bh / max(dims.y, 1e-4)) * 0.92
            ob.scale = (k, k, 1)
            ob.location = ((text_box[0] + text_box[2]) / 2, (text_box[1] + text_box[3]) / 2, 0.004)
    cam_data = bpy.data.cameras.new('TD_SheetCam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = GRID
    cam = bpy.data.objects.new('TD_SheetCam', cam_data)
    cam.location = (GRID / 2, GRID / 2, 5)
    sheet.collection.objects.link(cam)
    sheet.camera = cam
    sheet.render.engine = 'CYCLES'
    sheet.cycles.samples = 16
    sheet.cycles.max_bounces = 0
    sheet.view_settings.view_transform = 'Standard'
    sheet.render.resolution_x = sheet.render.resolution_y = PX
    sheet.render.resolution_percentage = 100
    sheet.render.image_settings.file_format = 'PNG'
    path = os.path.join(polyhaven.CACHE, 'signs_atlas.png')
    sheet.render.filepath = path
    world = bpy.data.worlds.get('TD_SheetWorld') or bpy.data.worlds.new('TD_SheetWorld')
    world.color = (0.1, 0.1, 0.1)
    sheet.world = world
    wm = bpy.context.window_manager
    window = bpy.context.window or (wm.windows[0] if wm.windows else None)
    override = {'scene': sheet}
    if window is not None:
        override['window'] = window
    with bpy.context.temp_override(**override):
        bpy.ops.render.render(write_still=True, scene=sheet.name)
    image = bpy.data.images.get('signs_atlas.png')
    if image is not None:
        bpy.data.images.remove(image)
    image = bpy.data.images.load(path)
    image.name = 'signs_atlas.png'
    for ob in list(sheet.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.scenes.remove(sheet)
    return image


def _material(image, lit):
    name = 'TD_signs_lit' if lit else 'TD_signs'
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = 0.45
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if lit:
        links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.3
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    mat.diffuse_color = (0.9, 0.85, 0.75, 1.0)
    return mat


def uv_rect(sid):
    cx, cy, w, h = _rects[sid]
    return cx / GRID, cy / GRID, (cx + w) / GRID, (cy + h) / GRID


def panel(name, sid, width, loc, parent, rot=(0, 0, 0), image=None, double=False):
    """A sign face of the given width (height from the sign's aspect), facing -Y in local space, UV-mapped to its cell."""
    image = image or bpy.data.images['signs_atlas.png']
    w_cells, h_cells = SIGNS[sid][0], SIGNS[sid][1]
    height = width * h_cells / w_cells
    u0, v0, u1, v1 = uv_rect(sid)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    faces = [((-width / 2, -0.001, -height / 2), (width / 2, -0.001, -height / 2), (width / 2, -0.001, height / 2), (-width / 2, -0.001, height / 2), False)]
    if double:
        faces.append(((width / 2, 0.001, -height / 2), (-width / 2, 0.001, -height / 2), (-width / 2, 0.001, height / 2), (width / 2, 0.001, height / 2), True))
    for a, b, c, d, back in faces:
        f = bm.faces.new([bm.verts.new(p) for p in (a, b, c, d)])
        coords = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        if back:
            coords = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        for loop, (u, v) in zip(f.loops, coords):
            loop[uv].uv = (u, v)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = kit._link(name, me, _material(image, SIGNS[sid][8]), loc, rot, parent=parent)
    return ob, height
