# Builds the Orrery scene in headless Blender and exports examples/orrery/orrery.glb.
#
#   blender --background --factory-startup --python-exit-code 1 --python examples/orrery/blender/build_orrery.py -- \
#       --layout examples/orrery/blender/layout.json --out examples/orrery/orrery.glb [--fast]
#
# Everything is made here from numbers: the wheels are cut with true involute teeth from the tooth counts and
# modules in layout.json (written by examples/orrery/layout.ts), the calendar ring is engraved from Earth's computed
# longitudes, and every texture is a Cycles bake of procedural nodes. No model, image or font file is read; text uses
# Blender's built-in font. --fast skips the bakes (flat colours) for quick geometry checks.
import bpy
import bmesh
import json
import math
import random
import sys
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


FAST = '--fast' in ARGS
L = json.load(open(arg('--layout', 'examples/orrery/blender/layout.json')))
OUT = arg('--out', 'examples/orrery/orrery.glb')
random.seed(7)
TAU = math.pi * 2

# ---------------------------------------------------------------------------------------------------------------------
# Scene and helpers

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.images):
    for block in list(coll):
        coll.remove(block)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
COLL = scene.collection


def link(obj, parent=None):
    COLL.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name, location=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(name, None)
    obj.location = location
    return link(obj, parent)


def mesh_object(name, bm, material, parent=None, location=(0, 0, 0), smooth=30):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth is not None:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth))
    if 'Color' in me.color_attributes:
        me.color_attributes.active_color = me.color_attributes['Color']
    if material is not None:
        me.materials.append(material)
    obj = bpy.data.objects.new(name, me)
    obj.location = location
    return link(obj, parent)


def polar(r, a):
    return (r * math.cos(a), r * math.sin(a))


def lathe(profile, segments=96, start=0.0, sweep=TAU):
    """A surface of revolution about z from (r, z) points; closed when the sweep is a full turn."""
    bm = bmesh.new()
    full = abs(sweep - TAU) < 1e-9
    count = segments if full else segments + 1
    rings = []
    for i in range(count):
        a = start + sweep * i / segments
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((r * ca, r * sa, z)) for r, z in profile])
    for i in range(segments):
        r0, r1 = rings[i], rings[(i + 1) % count]
        for j in range(len(profile) - 1):
            quad = (r0[j], r1[j], r1[j + 1], r0[j + 1])
            if len({v.co.to_tuple(7) for v in quad}) >= 3:
                try:
                    bm.faces.new(quad)
                except ValueError:
                    pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    return bm


def cylinder(r, z0, z1, segments=48, caps=True):
    profile = ([(0, z0)] if caps else []) + [(r, z0), (r, z1)] + ([(0, z1)] if caps else [])
    return lathe(profile, segments)


def box(sx, sy, sz, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    return bm


def sphere(r, segments=48, rings=24, center=(0, 0, 0)):
    bm = bmesh.new()
    bm.loops.layers.uv.new('UVMap')
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=r, calc_uvs=True)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    return bm


def merge(*bms):
    out = bmesh.new()
    for bm in bms:
        me = bpy.data.meshes.new('tmp')
        bm.to_mesh(me)
        out.from_mesh(me)
        bpy.data.meshes.remove(me)
        bm.free()
    return out


def transformed(bm, matrix):
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return bm


def prism(loops, z0, z1, chamfer=0.0):
    """Extrudes 2D loops (outer outline first, then holes) from z0 to z1, with the outline's edges chamfered."""
    bm = bmesh.new()

    def ring(loop, z, inset):
        pts = offset_loop(loop, inset) if inset else loop
        return [bm.verts.new((x, y, z)) for x, y in pts]

    def side(a, b):
        n = len(a)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))

    caps = []
    for k, loop in enumerate(loops):
        inset = chamfer  # holes run clockwise, so the same sign moves them away from the material
        if chamfer:
            levels = [ring(loop, z0, inset), ring(loop, z0 + chamfer, 0), ring(loop, z1 - chamfer, 0), ring(loop, z1, inset)]
        else:
            levels = [ring(loop, z0, 0), ring(loop, z1, 0)]
        for a, b in zip(levels, levels[1:]):
            side(a, b)
        caps.append((levels[0], levels[-1]))
    for which in (0, 1):
        edges = []
        for c in caps:
            vs = c[which]
            edges += [bm.edges.get((vs[i], vs[(i + 1) % len(vs)])) for i in range(len(vs))]
        bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def offset_loop(loop, d):
    """Moves every point of a closed loop d inward (counterclockwise loops; negative d moves outward)."""
    n = len(loop)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(loop[i - 1]), Vector(loop[i]), Vector(loop[(i + 1) % n])
        e0 = (p1 - p0).normalized()
        e1 = (p2 - p1).normalized()
        n0 = Vector((-e0.y, e0.x))
        n1 = Vector((-e1.y, e1.x))
        bis = n0 + n1
        if bis.length < 1e-9:
            bis = n0
        bis.normalize()
        cos = max(bis.dot(n0), 0.35)
        q = p1 + bis * (d / cos)
        out.append((q.x, q.y))
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Materials. Procedural ones are baked to images by bake_material() unless --fast.

def principled(name, color=(0.8, 0.8, 0.8), rough=0.5, metal=0.0, **extra):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    names = {
        'coat': 'Coat Weight',
        'coat_rough': 'Coat Roughness',
        'emission': 'Emission Color',
        'emission_strength': 'Emission Strength',
        'transmission': 'Transmission Weight',
        'ior': 'IOR',
        'alpha': 'Alpha',
        'specular': 'Specular IOR Level',
    }
    for key, value in extra.items():
        socket = bsdf.inputs[names[key]]
        socket.default_value = (*value, 1) if isinstance(value, tuple) else value
    return mat


# Brass and steel: linear base colours.
BRASS = principled('brass', (0.88, 0.64, 0.3), 0.2, 1.0)
BRASS_POLISHED = principled('brass_polished', (0.92, 0.7, 0.36), 0.1, 1.0)
BRASS_AGED = principled('brass_aged', (0.72, 0.52, 0.24), 0.28, 1.0)
# The calendar dial: satin brass, a little darker and rougher than the wheels. Flat and facing the window, a polished
# ring mirrors the bright sky and outshines the whole mechanism; satin spreads that reflection out so the dial sits
# with the rest of the brass and its blackened engraving still reads.
DIAL = principled('dial_brass', (0.6, 0.43, 0.2), 0.58, 1.0)
GILT = principled('gilt', (1.0, 0.74, 0.32), 0.14, 1.0)
STEEL = principled('steel', (0.55, 0.56, 0.58), 0.22, 1.0)
BLUED = principled('blued_steel', (0.035, 0.05, 0.13), 0.18, 1.0)
NIELLO = principled('niello', (0.012, 0.010, 0.009), 0.45, 0.0)
GLASS = principled('glass', (0.965, 0.985, 0.978), 0.0, 0.0, transmission=1.0, ior=1.52)
# The bell jar: a touch of roughness spreads the window's reflection on its shoulder into a soft sheen instead of a
# bright streak; the glass stays clear, since roughness only blurs what the surface reflects.
DOME_GLASS = principled('dome_glass', (0.965, 0.985, 0.978), 0.2, 0.0, transmission=1.0, ior=1.52)
BULB = principled('bulb', (1.0, 0.8, 0.55), 0.3, 0.0, emission=(1.0, 0.72, 0.42), emission_strength=40.0)
SKY = principled('window_sky', (0.0, 0.0, 0.0), 1.0, 0.0, emission=(0.55, 0.68, 0.9), emission_strength=2.4)
BOOKS = principled('books', (1, 1, 1), 0.55, 0.0)
_books_color = BOOKS.node_tree.nodes.new('ShaderNodeVertexColor')
_books_color.layer_name = 'Color'
BOOKS.node_tree.links.new(_books_color.outputs['Color'], BOOKS.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
SHADE = principled('lamp_shade', (0.02, 0.22, 0.09), 0.08, 0.0, coat=1.0, coat_rough=0.02,
                   emission=(0.02, 0.35, 0.12), emission_strength=0.6)
SHADE_INNER = principled('lamp_shade_inner', (0.85, 0.82, 0.74), 0.4, 0.0, emission=(1.0, 0.86, 0.66), emission_strength=1.5)
PAINT = principled('wall_paint', (0.035, 0.05, 0.042), 0.75, 0.0)
CEILING = principled('ceiling', (0.3, 0.29, 0.27), 0.9, 0.0)
IVORY = principled('ivory', (0.78, 0.72, 0.6), 0.25, 0.0)


def node(mat, kind, **props):
    n = mat.node_tree.nodes.new(kind)
    for key, value in props.items():
        setattr(n, key, value)
    return n


def procedural(name, rough=0.4, coat=0.0, metal=0.0):
    """A Principled material whose colour and roughness come from node graphs built by the caller."""
    mat = principled(name, rough=rough, metal=metal, coat=coat, coat_rough=0.04)
    return mat, mat.node_tree.nodes['Principled BSDF']


def ramp(mat, stops):
    r = node(mat, 'ShaderNodeValToRGB')
    els = r.color_ramp.elements
    while len(els) < len(stops):
        els.new(0.5)
    for el, (pos, color) in zip(els, stops):
        el.position = pos
        el.color = (*color, 1)
    return r


def coords(mat, scale=1.0, space='Object'):
    tc = node(mat, 'ShaderNodeTexCoord')
    mp = node(mat, 'ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale, scale, scale)
    mat.node_tree.links.new(tc.outputs[space], mp.inputs['Vector'])
    return mp.outputs['Vector']


def walnut(name, scale=1.0, coat=1.0, tone=1.0, fibre=(1.5, 70.0), wander=0.0, fibre_weight=0.7, gloss=(0.5, 0.3)):
    """Plank wood: long fibres along x, a few darker figure bands wandering across them, fine pores.

    fibre is the fibre noise's stretch (along, across), wander its distortion, fibre_weight how much the fibres set the
    colour, and gloss the roughness at the dark and light ends of the grain."""
    mat, bsdf = procedural(name, 0.45, coat)
    lk = mat.node_tree.links.new
    tc = node(mat, 'ShaderNodeTexCoord')

    def stretched(sx, syz):
        mp = node(mat, 'ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (sx * scale, syz * scale, syz * scale)
        lk(tc.outputs['Object'], mp.inputs['Vector'])
        return mp.outputs['Vector']

    fibres = node(mat, 'ShaderNodeTexNoise')
    fibres.inputs['Scale'].default_value = 1.0
    fibres.inputs['Detail'].default_value = 10.0
    fibres.inputs['Roughness'].default_value = 0.62
    fibres.inputs['Distortion'].default_value = wander
    lk(stretched(*fibre), fibres.inputs['Vector'])
    warp = node(mat, 'ShaderNodeTexNoise')
    warp.inputs['Scale'].default_value = 1.0
    warp.inputs['Detail'].default_value = 2.0
    lk(stretched(0.8, 3.0), warp.inputs['Vector'])
    mix = node(mat, 'ShaderNodeMix', data_type='VECTOR')
    mix.inputs['Factor'].default_value = 0.35
    lk(stretched(1.0, 1.0), mix.inputs['A'])
    lk(warp.outputs['Color'], mix.inputs['B'])
    figure = node(mat, 'ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y')
    figure.inputs['Scale'].default_value = 5.0
    figure.inputs['Distortion'].default_value = 1.2
    figure.inputs['Detail'].default_value = 4.0
    lk(mix.outputs['Result'], figure.inputs['Vector'])
    pores = node(mat, 'ShaderNodeTexNoise')
    pores.inputs['Scale'].default_value = 1.0
    pores.inputs['Detail'].default_value = 1.0
    lk(stretched(60.0, 400.0), pores.inputs['Vector'])
    a = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
    lk(fibres.outputs['Fac'], a.inputs[0])
    a.inputs[1].default_value = fibre_weight
    # Figure bands, plus the fibres' share of the mean when they weigh less, so the wood keeps its overall tone.
    b = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
    lk(figure.outputs['Fac'], b.inputs[0])
    b.inputs[1].default_value = 0.16
    b.inputs[2].default_value = (0.7 - fibre_weight) * 0.5
    lk(b.outputs[0], a.inputs[2])
    c = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
    lk(pores.outputs['Fac'], c.inputs[0])
    c.inputs[1].default_value = 0.12
    lk(a.outputs[0], c.inputs[2])
    t = tone
    col = ramp(mat, [(0.3, (0.028 * t, 0.012 * t, 0.006 * t)), (0.5, (0.075 * t, 0.036 * t, 0.016 * t)),
                     (0.66, (0.15 * t, 0.078 * t, 0.034 * t)), (0.8, (0.22 * t, 0.12 * t, 0.055 * t))])
    lk(c.outputs[0], col.inputs['Fac'])
    lk(col.outputs['Color'], bsdf.inputs['Base Color'])
    rr = ramp(mat, [(0.3, (gloss[0],) * 3), (0.8, (gloss[1],) * 3)])
    lk(c.outputs[0], rr.inputs['Fac'])
    lk(rr.outputs['Color'], bsdf.inputs['Roughness'])
    return mat


def leather():
    mat, bsdf = procedural('leather', 0.6)
    lk = mat.node_tree.links.new
    v = coords(mat, 1.0)
    vor = node(mat, 'ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE')
    vor.inputs['Scale'].default_value = 140.0
    lk(v, vor.inputs['Vector'])
    cloud = node(mat, 'ShaderNodeTexNoise')
    cloud.inputs['Scale'].default_value = 4.0
    cloud.inputs['Detail'].default_value = 6.0
    lk(v, cloud.inputs['Vector'])
    add = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
    lk(cloud.outputs['Fac'], add.inputs[0])
    add.inputs[1].default_value = 0.8
    lk(vor.outputs['Distance'], add.inputs[2])
    col = ramp(mat, [(0.25, (0.006, 0.03, 0.016)), (0.75, (0.03, 0.085, 0.045))])
    lk(add.outputs[0], col.inputs['Fac'])
    lk(col.outputs['Color'], bsdf.inputs['Base Color'])
    rr = ramp(mat, [(0.2, (0.38, 0.38, 0.38)), (0.8, (0.62, 0.62, 0.62))])
    lk(add.outputs[0], rr.inputs['Fac'])
    lk(rr.outputs['Color'], bsdf.inputs['Roughness'])
    return mat


def stone(name, stops, scale=6.0, bands=0.0, veins=0.0, rough=(0.18, 0.3), specks=None):
    """Polished stone or enamel for the planet balls: noise, latitude bands and veins in object space."""
    mat, bsdf = procedural(name, rough[0])
    lk = mat.node_tree.links.new
    v = coords(mat, 1.0, 'Generated')
    n = node(mat, 'ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = 8.0
    n.inputs['Roughness'].default_value = 0.6
    lk(v, n.inputs['Vector'])
    fac = n.outputs['Fac']
    if bands:
        sep = node(mat, 'ShaderNodeSeparateXYZ')
        lk(v, sep.inputs[0])
        warp = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
        lk(n.outputs['Fac'], warp.inputs[0])
        warp.inputs[1].default_value = 0.25 / bands
        lk(sep.outputs['Z'], warp.inputs[2])
        sine = node(mat, 'ShaderNodeMath', operation='SINE')
        mul = node(mat, 'ShaderNodeMath', operation='MULTIPLY')
        lk(warp.outputs[0], mul.inputs[0])
        mul.inputs[1].default_value = bands
        lk(mul.outputs[0], sine.inputs[0])
        half = node(mat, 'ShaderNodeMath', operation='MULTIPLY_ADD')
        lk(sine.outputs[0], half.inputs[0])
        half.inputs[1].default_value = 0.35
        lk(n.outputs['Fac'], half.inputs[2])
        fac = half.outputs[0]
    if veins:
        w = node(mat, 'ShaderNodeTexWave', wave_type='BANDS')
        w.inputs['Scale'].default_value = veins
        w.inputs['Distortion'].default_value = 14.0
        w.inputs['Detail'].default_value = 6.0
        lk(v, w.inputs['Vector'])
        p = node(mat, 'ShaderNodeMath', operation='POWER')
        lk(w.outputs['Fac'], p.inputs[0])
        p.inputs[1].default_value = 18.0
        mx = node(mat, 'ShaderNodeMath', operation='MAXIMUM')
        lk(fac, mx.inputs[0])
        lk(p.outputs[0], mx.inputs[1])
        fac = mx.outputs[0]
    col = ramp(mat, stops)
    lk(fac, col.inputs['Fac'])
    out = col.outputs['Color']
    if specks:
        vor = node(mat, 'ShaderNodeTexVoronoi')
        vor.inputs['Scale'].default_value = specks[0]
        vor.inputs['Randomness'].default_value = 1.0
        lk(v, vor.inputs['Vector'])
        gt = node(mat, 'ShaderNodeMath', operation='LESS_THAN')
        lk(vor.outputs['Distance'], gt.inputs[0])
        gt.inputs[1].default_value = specks[1]
        mixc = node(mat, 'ShaderNodeMix', data_type='RGBA')
        lk(gt.outputs[0], mixc.inputs['Factor'])
        lk(out, mixc.inputs['A'])
        mixc.inputs['B'].default_value = (*specks[2], 1)
        out = mixc.outputs['Result']
    lk(out, bsdf.inputs['Base Color'])
    rr = node(mat, 'ShaderNodeMapRange')
    lk(fac, rr.inputs['Value'])
    rr.inputs['To Min'].default_value = rough[0]
    rr.inputs['To Max'].default_value = rough[1]
    lk(rr.outputs['Result'], bsdf.inputs['Roughness'])
    return mat


def plaster(name, color, rough=0.8):
    mat, bsdf = procedural(name, rough)
    lk = mat.node_tree.links.new
    v = coords(mat, 1.0)
    n = node(mat, 'ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = 3.0
    n.inputs['Detail'].default_value = 10.0
    lk(v, n.inputs['Vector'])
    col = ramp(mat, [(0.3, tuple(c * 0.7 for c in color)), (0.7, color)])
    lk(n.outputs['Fac'], col.inputs['Fac'])
    lk(col.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


BAKES = []  # (object, material, size)


def bake_later(obj, size):
    BAKES.append((obj, size))
    return obj


def bake_all():
    """Bakes the colour and roughness of every procedural material into images and rewires it to them."""
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 8
    done = {}
    # Every object that shares a baked material needs UVs too; it samples the same image through its own.
    baked = {o.data.materials[0].name for o, _ in BAKES}
    for obj in list(COLL.objects):
        if obj.type == "MESH" and obj.data.materials and obj.data.materials[0].name in baked and all(o is not obj for o, _ in BAKES):
            BAKES.append((obj, 0))
    for obj, size in BAKES:
        mat = obj.data.materials[0]
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        if not obj.data.uv_layers:
            obj.data.uv_layers.new(name='UVMap')
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
            bpy.ops.object.mode_set(mode='OBJECT')
        if FAST or size == 0:
            continue
        if mat.name in done:
            continue
        nt = mat.node_tree
        bsdf = nt.nodes['Principled BSDF']
        out = nt.nodes['Material Output']
        emit = nt.nodes.new('ShaderNodeEmission')
        images = {}
        for channel, colorspace in (('Base Color', 'sRGB'), ('Roughness', 'Non-Color'), ('Emission Color', 'sRGB')):
            src = bsdf.inputs[channel].links[0].from_socket if bsdf.inputs[channel].links else None
            if src is None:
                continue
            img = bpy.data.images.new(f'{mat.name}_{channel.split()[0].lower()}', size, size, alpha=False)
            img.colorspace_settings.name = colorspace
            tex = nt.nodes.new('ShaderNodeTexImage')
            tex.image = img
            nt.nodes.active = tex
            nt.links.new(src, emit.inputs['Color'])
            nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
            bpy.ops.object.bake(type='EMIT', margin=8)
            img.pack()
            images[channel] = tex
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        nt.nodes.remove(emit)
        for channel, tex in images.items():
            nt.links.new(tex.outputs['Color'], bsdf.inputs[channel])
        done[mat.name] = True


# ---------------------------------------------------------------------------------------------------------------------
# Wheels with involute teeth

PRESSURE = math.radians(20)


def inv(a):
    return math.tan(a) - a


def wheel_outline(teeth, m):
    """Counterclockwise outline of a spur wheel, tooth 0 centred on +x: involute flanks from the base circle (radial
    below it), straight tip lands and a three-point root."""
    r = m * teeth / 2
    rb = r * math.cos(PRESSURE)
    ra = r + m
    rf = r - 1.25 * m
    half_pitch = math.pi / (2 * teeth)

    def half_width(rho):
        rho = max(rho, rb)
        return half_pitch + inv(PRESSURE) - inv(math.acos(min(1.0, rb / rho)))

    start = max(rb, rf)
    flank = [start + (ra - start) * t for t in (0.0, 0.18, 0.38, 0.6, 0.8, 1.0)]
    pts = []
    for k in range(teeth):
        c = TAU * k / teeth
        if rf < rb:
            pts.append(polar(rf, c - half_width(rb)))
        pts += [polar(rho, c - max(half_width(rho), 0.0)) for rho in flank]
        pts += [polar(rho, c + max(half_width(rho), 0.0)) for rho in reversed(flank)]
        if rf < rb:
            pts.append(polar(rf, c + half_width(rb)))
        pts.append(polar(rf, c + math.pi / teeth))
    return pts


def spoke_windows(rim, hub, spokes, width, segs=10):
    loops = []
    for j in range(spokes):
        s0 = TAU * j / spokes
        s1 = TAU * (j + 1) / spokes
        a0r = s0 + math.asin(width / 2 / rim)
        a1r = s1 - math.asin(width / 2 / rim)
        a0h = s0 + math.asin(width / 2 / hub)
        a1h = s1 - math.asin(width / 2 / hub)
        outer = [polar(rim, a0r + (a1r - a0r) * i / segs) for i in range(segs + 1)]
        inner = [polar(hub, a1h + (a0h - a1h) * i / max(2, segs // 3)) for i in range(max(2, segs // 3) + 1)]
        loops.append(list(reversed(outer + inner)))
    return loops


def wheel(name, teeth, m, bore, thickness, material, parent, z, crossings=True):
    """A wheel centred on its parent's axis at height z (relative), tooth 0 on local +x."""
    rf = m * (teeth - 2.5) / 2
    loops = [wheel_outline(teeth, m)]
    rim = rf - max(2.4 * m, 0.0028)
    hub = bore + 0.0045
    if crossings and rim - hub > 0.007:
        spokes = 4 if rim < 0.025 else 5 if rim < 0.045 else 6
        width = min(max(0.12 * rim, 0.0026), 0.0055)
        loops += spoke_windows(rim, hub, spokes, width)
    bm = prism(loops, z - thickness / 2, z + thickness / 2, chamfer=min(0.00022, m * 0.18))
    # A raised boss round the bore.
    boss = cylinder(bore + 0.0028, z - thickness / 2 - 0.0012, z + thickness / 2 + 0.0012, 32)
    return mesh_object(name, merge(bm, boss), material, parent, smooth=35)


# ---------------------------------------------------------------------------------------------------------------------
# The orrery

ORRERY = empty('orrery')
PL = L['plinth']
TOP = PL['height']


def build_plinth():
    r, h = PL['radius'], PL['height']
    profile = [(0, 0), (r - 0.012, 0), (r, 0.004), (r, 0.014), (r - 0.006, 0.02), (r - 0.012, 0.024),
               (r - 0.012, 0.05), (r - 0.006, 0.054), (r - 0.004, 0.06), (r - 0.012, 0.066), (r - 0.024, h - 0.002),
               (r - 0.028, h), (0, h)]
    # The plinth top fills the view under the dome, seen at a grazing angle. Its glossy grain (roughness 0.3 to 0.5,
    # following straight fibres) stretched the window and the Sun lamp into long bright parallel streaks there, like
    # light leaking in; the sun through the dome and the clearcoat were ruled out (no change with either off). A satin
    # polish (0.52 to 0.6) spreads those reflections into soft sheens, and short, wandering fibres break up the grain.
    top = walnut('walnut', 2.0, tone=1.15, fibre=(5.0, 40.0), wander=0.8, fibre_weight=0.45, gloss=(0.6, 0.52))
    obj = mesh_object('plinth', lathe(profile, 160), top, ORRERY, smooth=40)
    bake_later(obj, 2048)
    # Calendar ring inlay: a polished brass annulus flush with the walnut.
    c = L['calendar']
    ring = lathe([(c['inner'] - 0.004, TOP - 0.002), (c['inner'] - 0.004, TOP + 0.0006), (c['outer'] + 0.004, TOP + 0.0006),
                  (c['outer'] + 0.004, TOP - 0.002)], 256)
    mesh_object('calendar_ring', ring, DIAL, ORRERY, smooth=20)
    engrave_calendar(c)


def text_mesh(text, size):
    cu = bpy.data.curves.new('glyph', 'FONT')
    cu.body = text
    cu.size = size
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    obj = bpy.data.objects.new('glyph', cu)
    COLL.objects.link(obj)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    width = obj.dimensions.x
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return bm, width


def place_flat(bm, radius, angle, z):
    """Lays glyph geometry flat on the ring: its +x along the anticlockwise tangent, its +y toward the centre."""
    tangent = Vector((-math.sin(angle), math.cos(angle), 0))
    inward = Vector((-math.cos(angle), -math.sin(angle), 0))
    m = Matrix((
        (tangent.x, inward.x, 0, radius * math.cos(angle)),
        (tangent.y, inward.y, 0, radius * math.sin(angle)),
        (0, 0, 1, z),
        (0, 0, 0, 1),
    ))
    return transformed(bm, m)


def tick(radius0, radius1, angle, width, z):
    bm = box(radius1 - radius0, width, 0.0004, ((radius0 + radius1) / 2, 0, z))
    return transformed(bm, Matrix.Rotation(angle, 4, 'Z'))


def arc_text(text, radius, centre_angle, size, z, spacing=1.12):
    """Curved text along an arc, centred on centre_angle, read from outside the ring."""
    glyphs = [text_mesh(ch, size) if ch != ' ' else (None, size * 0.4) for ch in text]
    widths = [(w if w > 0 else size * 0.4) * spacing for _, w in glyphs]
    total = sum(widths)
    pos = -total / 2
    parts = []
    for (bm, _), w in zip(glyphs, widths):
        a = centre_angle + (pos + w / 2) / radius
        if bm is not None:
            parts.append(place_flat(bm, radius, a, z))
        pos += w
    return parts


def engrave_calendar(c):
    z = TOP + 0.00065
    parts = []
    # Degrees, outside: every degree, longer each 5 and 10, numbered every 10.
    outer = c['outer']
    for d in range(360):
        a = math.radians(d)
        length = 0.011 if d % 10 == 0 else 0.0068 if d % 5 == 0 else 0.0042
        parts.append(tick(outer - length, outer, a, 0.00055 if d % 10 else 0.0008, z))
        if d % 10 == 0:
            bm, _ = text_mesh(str(d), 0.0072)
            parts.append(place_flat(bm, outer - 0.0175, a, z))
    # Boundary lines between the bands.
    for radius in (c['inner'], c['split'], c['split'] + 0.0035, c['outer'] + 0.0005):
        parts.append(lathe([(radius - 0.00035, z - 0.0002), (radius - 0.00035, z), (radius + 0.00035, z),
                            (radius + 0.00035, z - 0.0002)], 360))
    # Earth's dates, inside: a tick each day, longer each 5th and 10th, a full line where a month begins.
    split = c['split']
    for i, day in enumerate(c['days']):
        a = math.radians(day['longitude'])
        if day['day'] == 1:
            parts.append(tick(c['inner'], split, a, 0.0008, z))
        else:
            length = 0.0075 if day['day'] % 10 == 0 else 0.0055 if day['day'] % 5 == 0 else 0.0032
            parts.append(tick(split - length, split, a, 0.0005, z))
            if day['day'] in (10, 20):
                bm, _ = text_mesh(str(day['day']), 0.0044)
                parts.append(place_flat(bm, split - 0.0115, a, z))
    for month in range(12):
        days = [d['longitude'] for d in c['days'] if d['month'] == month]
        first, last = days[0], days[-1] + (360 if days[-1] < days[0] else 0)
        mid = math.radians((first + last) / 2 + 0.5)
        parts += arc_text(c['months'][month], c['inner'] + 0.0105, mid, 0.0078, z)
    mesh_object('calendar_engraving', merge(*parts), NIELLO, ORRERY, smooth=None)


def build_frame():
    pl = L['plates']
    z0, z1, t, R = pl['bottom'], pl['top'], pl['thickness'], pl['radius']
    # Open frame: two pierced rings with three bridges each, held by six turned pillars.
    cen = L['centres']
    parts = []
    for z in (z0, z1):
        parts.append(lathe([(R - 0.014, z), (R, z), (R, z + t), (R - 0.014, z + t), (R - 0.014, z)], 160))
        # Bridges: centre to L2, L2 to L1, and L1 to the rim, each a flat bar.
        for (ax, ay), (bx, by) in (((0, 0), cen['L2']), (cen['L2'], cen['L1']), ((0, 0), polar(R - 0.007, math.radians(200))),
                                   ((0, 0), polar(R - 0.007, math.radians(320))), (cen['L1'], polar(R - 0.007, math.radians(110)))):
            dx, dy = bx - ax, by - ay
            length = math.hypot(dx, dy)
            bar = box(length, 0.012, t, (ax + dx / 2, ay + dy / 2, z + t / 2))
            parts.append(transformed(bar, Matrix.Translation((ax + dx / 2, ay + dy / 2, 0)) @ Matrix.Rotation(math.atan2(dy, dx), 4, 'Z') @ Matrix.Translation((-(ax + dx / 2), -(ay + dy / 2), 0))))
        for x, y in ((0, 0), cen['L1'], cen['L2']):
            parts.append(cylinder(0.009, z - 0.0006, z + t + 0.0006, 40))
            parts[-1] = transformed(parts[-1], Matrix.Translation((x, y, 0)))
    for k in range(6):
        x, y = polar(R - 0.007, math.radians(30 + 60 * k))
        pillar = lathe([(0, z0), (0.0048, z0), (0.0048, z0 + t + 0.004), (0.0034, z0 + t + 0.008), (0.003, (z0 + z1) / 2),
                        (0.0034, z1 - 0.004), (0.0048, z1 - 0.0005), (0.0048, z1), (0, z1)], 24)
        parts.append(transformed(pillar, Matrix.Translation((x, y, 0))))
        foot = lathe([(0, TOP), (0.009, TOP), (0.0085, TOP + 0.004), (0.005, TOP + 0.008), (0.005, z0), (0, z0)], 32)
        parts.append(transformed(foot, Matrix.Translation((x, y, 0))))
    mesh_object('frame', merge(*parts), BRASS_AGED, ORRERY, smooth=40)
    # Screws on the plates: blued steel heads.
    screws = []
    for z in (z1 + t,):
        for k in range(6):
            x, y = polar(R - 0.007, math.radians(30 + 60 * k))
            screws.append(transformed(sphere(0.0035, 16, 8), Matrix.Translation((x, y, z)) @ Matrix.Scale(0.6, 4, (0, 0, 1))))
    mesh_object('screws', merge(*screws), BLUED, ORRERY)
    # The stud arbor L2 (fixed) and the Sun's arbor are steel.
    arbors = [transformed(cylinder(L['arbor'], z0 - 0.002, z1 + t + 0.003, 24), Matrix.Translation((*cen['L2'], 0)))]
    arbors.append(cylinder(0.003, z0 - 0.002, L['sun']['z'], 24))
    mesh_object('arbors', merge(*arbors), STEEL, ORRERY)


def build_trains():
    cen = L['centres']
    drive = empty('drive', (*cen['L1'], 0), ORRERY)
    pl = L['plates']
    mesh_object('drive_arbor', cylinder(L['arbor'], pl['bottom'] - 0.004, pl['top'] + pl['thickness'] + 0.012, 24), STEEL, drive)
    # A knurled winding knob on top of the drive arbor.
    knob = lathe([(0, 0), (0.008, 0), (0.0095, 0.002), (0.0095, 0.008), (0.008, 0.01), (0, 0.01)], 48)
    mesh_object('drive_knob', transformed(knob, Matrix.Translation((0, 0, pl['top'] + pl['thickness'] + 0.012))), BRASS_POLISHED, drive)
    t = L['wheelThickness']
    for p in L['planets']:
        w = p['wheels']
        wheel(f"wheel_{p['name']}_a", w['a']['teeth'], w['a']['module'], L['arbor'], t, BRASS, drive, w['a']['z'])
        sleeve = empty(f"sleeve_{p['name']}", (*cen['L2'], 0), ORRERY)
        wheel(f"wheel_{p['name']}_b", w['b']['teeth'], w['b']['module'], L['arbor'], t, BRASS, sleeve, w['b']['z'])
        wheel(f"wheel_{p['name']}_c", w['c']['teeth'], w['c']['module'], L['arbor'], t, BRASS, sleeve, w['c']['z'])
        mesh_object(f"sleeve_{p['name']}_pipe", lathe([(L['arbor'] + 0.0001, w['b']['z']), (L['arbor'] + 0.0022, w['b']['z']),
                                                        (L['arbor'] + 0.0022, w['c']['z']), (L['arbor'] + 0.0001, w['c']['z'])], 24),
                    BRASS, sleeve)
        tube = empty(f"tube_{p['name']}", (0, 0, 0), ORRERY)
        wheel(f"wheel_{p['name']}_d", w['d']['teeth'], w['d']['module'], p['tube'], t, BRASS, tube, w['d']['z'])
        mesh_object(f"tube_{p['name']}_pipe", lathe([(p['tube'] - 0.0012, w['d']['z']), (p['tube'], w['d']['z']),
                                                      (p['tube'], p['armZ'] + 0.0045), (p['tube'] - 0.0012, p['armZ'] + 0.0045)], 40),
                    BRASS_POLISHED, tube)


PLANET_LOOK = {
    'mercury': lambda: stone('mercury_stone', [(0.3, (0.16, 0.15, 0.14)), (0.55, (0.36, 0.34, 0.32)), (0.8, (0.58, 0.56, 0.53))], 9.0,
                             rough=(0.25, 0.4)),
    'venus': lambda: stone('venus_enamel', [(0.3, (0.7, 0.6, 0.42)), (0.7, (0.9, 0.84, 0.66))], 4.0, veins=3.0, rough=(0.12, 0.2)),
    'earth': lambda: stone('earth_blue', [(0.25, (0.02, 0.09, 0.4)), (0.6, (0.04, 0.2, 0.66)), (0.9, (0.2, 0.42, 0.82))], 6.0,
                           veins=3.0, rough=(0.08, 0.16)),
    'mars': lambda: stone('mars_carnelian', [(0.25, (0.45, 0.07, 0.02)), (0.6, (0.75, 0.2, 0.05)), (0.9, (0.9, 0.4, 0.14))], 5.0,
                          rough=(0.08, 0.14)),
    'jupiter': lambda: stone('jupiter_agate', [(0.0, (0.32, 0.13, 0.04)), (0.3, (0.66, 0.42, 0.22)), (0.5, (0.9, 0.8, 0.62)),
                                               (0.7, (0.52, 0.26, 0.1)), (1.0, (0.94, 0.88, 0.76))], 3.0, bands=8.0, rough=(0.12, 0.2)),
    'saturn': lambda: stone('saturn_agate', [(0.0, (0.62, 0.46, 0.2)), (0.5, (0.86, 0.72, 0.44)), (1.0, (0.94, 0.86, 0.66))], 3.0,
                            bands=5.0, rough=(0.12, 0.2)),
    'uranus': lambda: stone('uranus_aquamarine', [(0.3, (0.32, 0.66, 0.66)), (0.8, (0.6, 0.88, 0.86))], 3.0, rough=(0.06, 0.12)),
    'neptune': lambda: stone('neptune_cobalt', [(0.3, (0.008, 0.02, 0.16)), (0.7, (0.03, 0.07, 0.42))], 6.0, rough=(0.1, 0.18)),
}


def build_arms():
    z_plane = L['planetZ']
    for p in L['planets']:
        name, r, z = p['name'], p['orbit'], p['armZ']
        arm = empty(f"arm_{name}", (0, 0, 0), ORRERY)
        parts = []
        collar = lathe([(p['tube'], z - 0.0042), (p['tube'] + 0.0035, z - 0.0042), (p['tube'] + 0.0035, z + 0.0042),
                        (p['tube'], z + 0.0042)], 40)
        parts.append(collar)
        # The arm: a flat bar tapering outward, with a counterweight arm opposite.

        w0, w1, th = 0.0055, 0.0032, 0.0028
        outline = [(p['tube'], -w0 / 2), (r, -w1 / 2), (r, w1 / 2), (p['tube'], w0 / 2)]
        bar = prism([outline], z - th / 2, z + th / 2, chamfer=0.0004)
        parts.append(bar)
        cw = min(0.05, 0.35 * r + 0.02)
        parts.append(prism([[(-cw, -w1 / 2), (-p['tube'], -w0 / 2), (-p['tube'], w0 / 2), (-cw, w1 / 2)]], z - th / 2, z + th / 2, 0.0004))
        parts.append(sphere(0.0042 + 0.002 * (r / 0.47), 24, 12, (-cw - 0.003, 0, z)))
        # The post: a turned column from the arm to under the planet.
        top = z_plane - p['radius'] - 0.0015
        post = lathe([(0, z - th / 2), (0.0032, z - th / 2), (0.0032, z + th / 2 + 0.003), (0.0019, z + th / 2 + 0.006),
                      (0.0015, top - 0.006), (0.0022, top - 0.004), (0.0022, top - 0.002), (0.0012, top), (0, top + 0.001)], 24)
        parts.append(transformed(post, Matrix.Translation((r, 0, 0))))
        mesh_object(f"arm_{name}_brass", merge(*parts), BRASS_POLISHED, arm, smooth=40)
        # The planet, centred above the post; turned by the page to keep its axis fixed in space.
        ball = mesh_object(f"planet_{name}", sphere(p['radius'], 64, 32), PLANET_LOOK[name](), arm, (r, 0, z_plane))
        bake_later(ball, 1024 if p['radius'] > 0.014 else 512)
        if p['ring']:
            ri, ro = p['ring']['inner'], p['ring']['outer']
            bands = [(ri, ri + 0.42 * (ro - ri)), (ri + 0.47 * (ro - ri), ri + 0.8 * (ro - ri)), (ri + 0.84 * (ro - ri), ro)]
            rings = [lathe([(a, -0.0003), (b, -0.0003), (b, 0.0003), (a, 0.0003), (a, -0.0003)], 128) for a, b in bands]
            mesh_object(f"ring_{name}", merge(*rings), GILT, ball, smooth=20)
        # Moons on a carrier that turns about the post's axis.
        for i, moon in enumerate(p['moons']):
            carrier = empty(f"moons_{name}_{moon['name']}", (r, 0, 0), arm)
            zc = z_plane - p['radius'] - 0.0035 - 0.0026 * i
            bits = [lathe([(0.0016, zc - 0.0012), (0.0026, zc - 0.0012), (0.0026, zc + 0.0012), (0.0016, zc + 0.0012)], 24)]
            bits.append(prism([[(0.0022, -0.0006), (moon['arm'], -0.0005), (moon['arm'], 0.0005), (0.0022, 0.0006)]],
                              zc - 0.0006, zc + 0.0006))
            bits.append(transformed(cylinder(0.0006, zc, z_plane - moon['radius'] * 0.8, 12), Matrix.Translation((moon['arm'], 0, 0))))
            mesh_object(f"moonarm_{name}_{moon['name']}", merge(*bits), BRASS_POLISHED, carrier)
            look = IVORY if moon['name'] != 'moon' else stone('moon_stone', [(0.3, (0.3, 0.3, 0.29)), (0.8, (0.62, 0.6, 0.57))], 12.0,
                                                               rough=(0.3, 0.45))
            mb = mesh_object(f"moon_{name}_{moon['name']}", sphere(moon['radius'], 24, 12), look, carrier, (moon['arm'], 0, z_plane))
            if look is not IVORY:
                bake_later(mb, 256)


def sun_glass():
    """The Sun's glass: a lit amber globe whose glow is granulated, slightly brighter and paler in some cells than in
    others, so it reads as glass with a lamp behind it, not a flat disc. Baked into an emission image."""
    mat, bsdf = procedural('sun_glow', 0.3)
    bsdf.inputs['Base Color'].default_value = (1.0, 0.6, 0.2, 1)
    bsdf.inputs['Emission Strength'].default_value = 8.5
    lk = mat.node_tree.links.new
    v = coords(mat, 1.0)
    cells = node(mat, 'ShaderNodeTexVoronoi', feature='SMOOTH_F1')
    cells.inputs['Scale'].default_value = 260.0
    cells.inputs['Smoothness'].default_value = 0.6
    lk(v, cells.inputs['Vector'])
    grain = node(mat, 'ShaderNodeTexNoise')
    grain.inputs['Scale'].default_value = 90.0
    grain.inputs['Detail'].default_value = 6.0
    lk(v, grain.inputs['Vector'])
    mix = node(mat, 'ShaderNodeMix', data_type='FLOAT')
    mix.inputs['Factor'].default_value = 0.5
    lk(cells.outputs['Distance'], mix.inputs['A'])
    lk(grain.outputs['Fac'], mix.inputs['B'])
    col = ramp(mat, [(0.25, (0.9, 0.34, 0.07)), (0.7, (1.0, 0.56, 0.2))])
    lk(mix.outputs['Result'], col.inputs['Fac'])
    lk(col.outputs['Color'], bsdf.inputs['Emission Color'])
    return mat


def build_sun():
    s = L['sun']
    sun = mesh_object('sun', sphere(s['radius'], 64, 32), sun_glass(), ORRERY, (0, 0, s['z']))
    bake_later(sun, 512)
    # A plain glowing globe on a gilt cup: no crown of rays, which read as a face (eyes and whiskers) from the
    # opening view.
    cup = lathe([(0, -s['radius'] - 0.012), (0.004, -s['radius'] - 0.012), (0.012, -s['radius'] - 0.002), (0.0155, -s['radius'] * 0.55),
                 (0.0145, -s['radius'] * 0.5), (0.003, -s['radius'] - 0.008), (0, -s['radius'] - 0.008)], 48)
    mesh_object('sun_cup', cup, GILT, sun)


def build_dome():
    d = L['dome']
    r, z0 = d['radius'], TOP + 0.016
    base = lathe([(r - 0.012, TOP), (r + 0.01, TOP), (r + 0.012, TOP + 0.004), (r + 0.006, TOP + 0.008), (r + 0.007, TOP + 0.013),
                  (r + 0.002, z0 + 0.002), (r - 0.006, z0 + 0.002), (r - 0.006, TOP)], 192)
    mesh_object('dome_base', base, BRASS, ORRERY, smooth=40)
    # A bell jar with a real wall: the outside up and over, the inside back down, closed at the foot, so its rim and
    # silhouette show the glass's thickness.
    t = d['thickness']
    wall_top = TOP + d['wall']
    outer = [(r, z0), (r, wall_top)] + [(r * math.cos(a), wall_top + d['cap'] * math.sin(a))
                                         for a in [(math.pi / 2) * i / 32 for i in range(1, 33)]]
    inner = [((r - t) * math.cos(a), wall_top + (d['cap'] - t) * math.sin(a)) for a in [(math.pi / 2) * i / 32 for i in range(32, 0, -1)]]
    inner += [(r - t, wall_top), (r - t, z0)]
    outer[-1] = (0.0, outer[-1][1])
    inner[0] = (0.0, inner[0][1])
    dome = mesh_object('dome', lathe(outer + inner + [(r, z0)], 160), DOME_GLASS, ORRERY, smooth=50)
    dome_root = dome
    # The finial: a turned knob with a ball top, seated on a wide rosette that hugs the glass, so it reads as fixed to
    # the jar even where the glass under it is invisible.
    ball = [(0.011 * math.cos(math.radians(a)), 0.033 + 0.011 * math.sin(math.radians(a))) for a in range(-60, 90, 10)] + [(0, 0.044)]
    finial = lathe([(0, 0), (0.036, 0), (0.0375, 0.0018), (0.034, 0.0036), (0.022, 0.0052), (0.014, 0.0068), (0.0105, 0.0095),
                    (0.0075, 0.013), (0.0068, 0.017), (0.0092, 0.019), (0.0092, 0.0215), (0.0062, 0.0235)] + ball, 64)
    mesh_object('dome_finial', transformed(finial, Matrix.Translation((0, 0, wall_top + d['cap'] - 0.0008))), BRASS, dome_root, smooth=40)


# ---------------------------------------------------------------------------------------------------------------------
# The study: desk, walls, window, bookcase, lamp

ROOM = empty('study')
FLOOR = -0.76
WALL_BACK = 1.75
WALL_LEFT = -2.3
WALL_RIGHT = 2.6


def build_room():
    desk_wood = walnut('desk_wood', 1.0, coat=0.5, tone=1.7)
    top = box(2.6, 1.3, 0.045, (0.1, 0.25, -0.0225))
    desk = mesh_object('desk', top, desk_wood, ROOM)
    bake_later(desk, 2048)
    edge = box(2.62, 1.32, 0.012, (0.1, 0.25, -0.051))
    apron = box(2.5, 1.2, 0.12, (0.1, 0.25, -0.12))
    mesh_object('desk_body', merge(edge, apron), desk_wood, ROOM)
    pad = mesh_object('desk_leather', box(1.9, 0.95, 0.0012, (0.0, 0.22, 0.0006)), leather(), ROOM)
    bake_later(pad, 1024)
    floor = mesh_object('floor', box(6, 6, 0.02, (0, 0, FLOOR - 0.01)), walnut('floor_wood', 0.5, coat=0.3), ROOM)
    bake_later(floor, 1024)
    walls = plaster('walls', (0.11, 0.13, 0.105))
    back = mesh_object('wall_back', box(6, 0.1, 3.6, (0, WALL_BACK + 0.05, FLOOR + 1.8)), walls, ROOM)
    bake_later(back, 1024)
    right = mesh_object('wall_right', box(0.1, 6, 3.6, (WALL_RIGHT + 0.05, 0, FLOOR + 1.8)), walls, ROOM)
    bake_later(right, 1024)
    front = mesh_object('wall_front', box(6, 0.1, 3.6, (0, -3.2, FLOOR + 1.8)), PAINT, ROOM)
    mesh_object('ceiling', box(6, 6, 0.1, (0, 0, FLOOR + 3.0)), CEILING, ROOM)
    # Left wall with a tall window: four pieces round the opening.
    wx0, wx1 = -0.75, 0.35     # opening along y
    wz0, wz1 = -0.05, 1.75     # opening height
    pieces = [box(0.12, 6, wz0 - (FLOOR - 0.1), (WALL_LEFT - 0.06, 0, (wz0 + FLOOR - 0.1) / 2)),
              box(0.12, 6, (FLOOR + 3.2) - wz1, (WALL_LEFT - 0.06, 0, (wz1 + FLOOR + 3.2) / 2)),
              box(0.12, wx0 + 3, wz1 - wz0, (WALL_LEFT - 0.06, (wx0 - 3) / 2, (wz0 + wz1) / 2)),
              box(0.12, 3 - wx1, wz1 - wz0, (WALL_LEFT - 0.06, (wx1 + 3) / 2, (wz0 + wz1) / 2))]
    left = mesh_object('wall_left', merge(*pieces), walls, ROOM)
    bake_later(left, 1024)
    # Window frame and glazing bars, painted off-white.
    frame_paint = principled('window_paint', (0.62, 0.6, 0.55), 0.45)
    bars = []
    cx = WALL_LEFT - 0.06
    for y in (wx0, wx1):
        bars.append(box(0.16, 0.06, wz1 - wz0, (cx, y, (wz0 + wz1) / 2)))
    for z in (wz0, wz1):
        bars.append(box(0.16, wx1 - wx0 + 0.06, 0.06, (cx, (wx0 + wx1) / 2, z)))
    bars.append(box(0.2, wx1 - wx0 + 0.2, 0.04, (cx + 0.06, (wx0 + wx1) / 2, wz0 - 0.03)))  # sill
    for k in (1, 2):
        bars.append(box(0.05, 0.022, wz1 - wz0, (cx, wx0 + (wx1 - wx0) * k / 3, (wz0 + wz1) / 2)))
    for k in (1, 2, 3):
        bars.append(box(0.05, wx1 - wx0, 0.022, (cx, (wx0 + wx1) / 2, wz0 + (wz1 - wz0) * k / 4)))
    mesh_object('window_frame', merge(*bars), frame_paint, ROOM)
    mesh_object('window_sky', box(0.02, 3.0, 3.0, (WALL_LEFT - 1.4, (wx0 + wx1) / 2, (wz0 + wz1) / 2)), SKY, ROOM, smooth=None)
    build_bookcase()
    build_lamp()
    build_desk_props()


def build_bookcase():
    case_wood = walnut('bookcase_wood', 1.2, coat=0.4)
    x0, x1 = -1.25, 1.35
    y0 = WALL_BACK - 0.36
    z0, z1 = FLOOR, FLOOR + 2.35
    shelves = [FLOOR + 0.1 + k * 0.4 for k in range(6)]
    parts = [box(0.03, 0.36, z1 - z0, (x, y0 + 0.18, (z0 + z1) / 2)) for x in (x0, (x0 + x1) / 2, x1)]
    parts += [box(x1 - x0, 0.36, 0.025, ((x0 + x1) / 2, y0 + 0.18, z)) for z in shelves + [z1]]
    parts.append(box(x1 - x0, 0.02, z1 - z0, ((x0 + x1) / 2, WALL_BACK - 0.01, (z0 + z1) / 2)))
    case = mesh_object('bookcase', merge(*parts), case_wood, ROOM)
    bake_later(case, 1024)
    palette = [(0.18, 0.02, 0.02), (0.03, 0.06, 0.16), (0.03, 0.1, 0.05), (0.32, 0.18, 0.08), (0.12, 0.08, 0.05),
               (0.42, 0.33, 0.2), (0.08, 0.03, 0.06), (0.24, 0.05, 0.03), (0.02, 0.02, 0.02)]
    bm = bmesh.new()
    color_layer = bm.loops.layers.color.new('Color')
    for z in shelves:
        for bay in ((x0 + 0.02, (x0 + x1) / 2 - 0.02), ((x0 + x1) / 2 + 0.02, x1 - 0.02)):
            x = bay[0]
            while x < bay[1] - 0.04:
                w = random.uniform(0.022, 0.055)
                h = random.uniform(0.2, 0.34)
                d = random.uniform(0.17, 0.26)
                if random.random() < 0.05:
                    x += random.uniform(0.04, 0.12)
                    continue
                lean = random.uniform(-0.02, 0.02) if random.random() < 0.12 else 0
                color = random.choice(palette)
                shade = random.uniform(0.7, 1.15)
                tmp = box(min(w, bay[1] - x), d, h, (x + w / 2, y0 + 0.36 - d / 2 - 0.01, z + 0.0125 + h / 2))
                if lean:
                    bmesh.ops.rotate(tmp, verts=tmp.verts, cent=(x + w / 2, 0, z + 0.0125), matrix=Matrix.Rotation(lean, 3, 'Y'))
                me = bpy.data.meshes.new('book')
                tmp.to_mesh(me)
                tmp.free()
                start = len(bm.faces)
                bm.from_mesh(me)
                bpy.data.meshes.remove(me)
                bm.faces.ensure_lookup_table()
                cl = bm.loops.layers.color['Color']
                for f in list(bm.faces)[start:]:
                    # A gilt band near the top and bottom of the spine (the face toward the room).
                    for loop in f.loops:
                        c = tuple(min(1.0, ch * shade) for ch in color)
                        zz = loop.vert.co.z - z
                        if f.normal.y < -0.9 and (abs(zz - h * 0.85) < 0.008 or abs(zz - h * 0.15) < 0.006):
                            c = (0.55, 0.38, 0.12)
                        loop[cl] = (*c, 1)
                x += w + random.uniform(0.0, 0.004)
    mesh_object('books', bm, BOOKS, ROOM, smooth=None)


def build_lamp():
    lamp = empty('lamp', (1.25, 0.82, 0), ROOM)
    parts = [lathe([(0, 0), (0.085, 0), (0.088, 0.006), (0.08, 0.012), (0.03, 0.022), (0.016, 0.03), (0.016, 0.036), (0, 0.036)], 64)]
    parts.append(cylinder(0.007, 0.03, 0.36, 24))
    parts.append(lathe([(0, 0.355), (0.012, 0.355), (0.014, 0.365), (0.012, 0.375), (0, 0.375)], 24))
    # The yoke that holds the shade along x.
    for s in (-1, 1):
        parts.append(box(0.006, 0.006, 0.07, (s * 0.12, 0, 0.395)))
    parts.append(box(0.25, 0.008, 0.006, (0, 0, 0.365)))
    mesh_object('lamp_brass', merge(*parts), BRASS, lamp, smooth=40)
    # A banker's lamp shade: a long half cylinder of green cased glass, opal white inside.
    shade_outline = [(math.cos(a) * 0.075, 0.42 + math.sin(a) * 0.065) for a in [math.pi * i / 24 for i in range(25)]]
    outer = bmesh.new()
    verts = []
    for x in (-0.15, 0.15):
        verts.append([outer.verts.new((x, y, z)) for y, z in shade_outline])
    for i in range(len(shade_outline) - 1):
        outer.faces.new((verts[0][i], verts[1][i], verts[1][i + 1], verts[0][i + 1]))
    for side in verts:
        outer.faces.new(side if side is verts[1] else list(reversed(side)))
    mesh_object('lamp_shade', outer, SHADE, lamp, smooth=50)
    inner = bmesh.new()
    vin = []
    for x in (-0.147, 0.147):
        vin.append([inner.verts.new((x, y * 0.96, 0.42 + (z - 0.42) * 0.94)) for y, z in shade_outline])
    for i in range(len(shade_outline) - 1):
        inner.faces.new((vin[0][i + 1], vin[1][i + 1], vin[1][i], vin[0][i]))
    mesh_object('lamp_shade_inner', inner, SHADE_INNER, lamp, smooth=50)
    bulb = transformed(cylinder(0.012, -0.11, 0.11, 24), Matrix.Translation((0, 0, 0.43)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    mesh_object('lamp_bulb', bulb, BULB, lamp)


def build_desk_props():
    # A small stack of old books and a brass magnifier on the left of the desk.
    stack = empty('book_stack', (-0.95, 0.15, 0), ROOM)
    cloth = [principled('book_red', (0.2, 0.025, 0.02), 0.6), principled('book_blue', (0.025, 0.04, 0.12), 0.6),
             principled('book_tan', (0.36, 0.22, 0.1), 0.65)]
    pages = principled('pages', (0.62, 0.56, 0.44), 0.85)
    z = 0.0
    for i, (w, d, h, a) in enumerate(((0.26, 0.19, 0.05, 0.05), (0.23, 0.17, 0.035, -0.12), (0.2, 0.15, 0.03, 0.2))):
        cover = box(w, d, h, (0, 0, z + h / 2))
        block = box(w - 0.012, d - 0.01, h - 0.008, (0.006, 0, z + h / 2))
        rot = Matrix.Rotation(a, 4, 'Z')
        mesh_object(f'book_cover_{i}', transformed(cover, rot), cloth[i], stack)
        mesh_object(f'book_pages_{i}', transformed(block, rot @ Matrix.Translation((0.0005, 0, 0))), pages, stack)
        z += h
    mag = empty('magnifier', (-0.72, -0.18, 0.004), ROOM)
    rim = lathe([(0.042, -0.003), (0.047, -0.003), (0.047, 0.003), (0.042, 0.003), (0.042, -0.003)], 64)
    mesh_object('magnifier_rim', rim, BRASS_POLISHED, mag, smooth=40)
    lens = lathe([(0, -0.0015), (0.0425, -0.0005), (0.0425, 0.0005), (0, 0.0015)], 64)
    mesh_object('magnifier_lens', lens, GLASS, mag, smooth=60)
    handle = transformed(cylinder(0.006, 0.047, 0.15, 24), Matrix.Rotation(-math.pi / 2, 4, 'Y'))
    mesh_object('magnifier_handle', transformed(handle, Matrix.Rotation(math.radians(-35), 4, 'Z')), walnut('handle_wood', 6.0), mag)


# ---------------------------------------------------------------------------------------------------------------------

build_plinth()
build_frame()
build_trains()
build_arms()
build_sun()
build_dome()
build_room()
bake_all()

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_yup=True,
    export_apply=True,
    export_image_format='JPEG',
    export_jpeg_quality=88,
    export_materials='EXPORT',
    export_vertex_color='MATERIAL',
    export_draco_mesh_compression_enable=True,
    export_draco_position_quantization=16,
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
print('wrote', OUT)
