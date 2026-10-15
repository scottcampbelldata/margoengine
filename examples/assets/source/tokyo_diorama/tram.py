"""Hero tram: a puffy subdivided body with recessed rounded windows, doors, handrails, roof equipment and a trolley pole.

Paint bands, soft painted shading, grime, edge wear and ambient occlusion are built from Poly Haven CC0 textures
and baked by bake.Atlas into one JPEG-exported atlas (`TD_tram_atlas`), so the engine only needs a base-colour map.
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import bake
import kit

L = 2.3
END = L / 2
BELT = 0.6                                 # cream above, green below
WIN_Z = (0.67, 0.98)
SIDE_WINDOWS = [(-0.56 + i * 0.297, -0.56 + i * 0.297 + 0.23) for i in range(4)]
DOORS = [(0.66, 0.9), (-0.9, -0.66)]       # door x-ranges (both sides)
DOOR_WINDOWS = [(a + 0.03, b - 0.03) for a, b in DOORS]
WINDSCREEN = [(-0.3, -0.11), (-0.09, 0.09), (0.11, 0.3)]
ATLAS_SIZE = 2048

# Cage cross-section (y, z): right side bottom-up, crown, left side top-down, keel. Subdivision rounds it.
_RIGHT = [(0.30, 0.14), (0.44, 0.20), (0.46, 0.42), (0.455, 0.66), (0.44, 0.92), (0.39, 1.10), (0.23, 1.22)]
PROFILE = _RIGHT + [(0.0, 1.25)] + [(-y, z) for y, z in reversed(_RIGHT)] + [(0.0, 0.12)]
STATIONS = [(-1.15, 0.70, 0.90), (-1.08, 0.86, 0.97), (-0.95, 0.97, 1.0), (-0.6, 1, 1), (-0.2, 1, 1),
            (0.2, 1, 1), (0.6, 1, 1), (0.95, 0.97, 1.0), (1.08, 0.86, 0.97), (1.15, 0.70, 0.90)]  # (x, plan scale, height scale)


# ---------------------------------------------------------------- mesh helpers

def _mesh_from_bmesh(name, bm, slots=0):
    me = bpy.data.meshes.new(name)
    for _ in range(slots):  # slots must exist before to_mesh, or Blender clamps face material indices to 0
        me.materials.append(None)
    bm.to_mesh(me)
    bm.free()
    return me


def _cage():
    bm = bmesh.new()
    loops = []
    for x, s, h in STATIONS:
        loops.append([bm.verts.new((x, y * s, 0.66 + (z - 0.66) * h)) for y, z in PROFILE])
    n = len(PROFILE)
    for a, b in zip(loops, loops[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(loops[0])
    bm.faces.new(list(reversed(loops[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    return _mesh_from_bmesh('Tram_Shell', bm, slots=4)


def _rounded(c0, c1, d0, d1, r, seg=5):
    """Rounded rectangle outline in a 2D (c, d) plane, counter-clockwise."""
    pts = []
    for cc, cd, start in ((c1 - r, d1 - r, 0), (c0 + r, d1 - r, 90), (c0 + r, d0 + r, 180), (c1 - r, d0 + r, 270)):
        for k in range(seg + 1):
            a = math.radians(start + 90 * k / seg)
            pts.append((cc + r * math.cos(a), cd + r * math.sin(a)))
    return pts


def _cutters():
    """Window/door/windscreen prisms for the boolean difference."""
    bm = bmesh.new()

    def prism(outline, to3d):
        a = [bm.verts.new(to3d(c, d, 0)) for c, d in outline]
        b = [bm.verts.new(to3d(c, d, 1)) for c, d in outline]
        n = len(outline)
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
        bm.faces.new(a)
        bm.faces.new(list(reversed(b)))

    for x0, x1 in SIDE_WINDOWS + DOOR_WINDOWS:
        prism(_rounded(x0, x1, WIN_Z[0], WIN_Z[1], 0.05), lambda c, d, t: (c, -0.8 + 1.6 * t, d))
    for sign in (1, -1):
        for y0, y1 in WINDSCREEN:
            prism(_rounded(y0, y1, 0.66, 0.99, 0.045), lambda c, d, t, sign=sign: (sign * (0.85 + 0.6 * t), c, d))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _mesh_from_bmesh('Tram_Cutters', bm)


def _apply(ob):
    """Bake the modifier stack into the mesh (works headless and in the live session)."""
    view_layer = kit.SCENE.view_layers[0]
    view_layer.update()
    depsgraph = view_layer.depsgraph
    depsgraph.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


def _bvh(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def _hit(tree, origin, direction):
    location, normal, _, _ = tree.ray_cast(Vector(origin), Vector(direction).normalized())
    return location, normal


def _side_point(tree, x, z, side, offset=0.0):
    loc, nor = _hit(tree, (x, side * 2.0, z), (0, -side, 0))
    return loc + nor * offset


def _front_point(tree, y, z, sign, offset=0.0):
    loc, nor = _hit(tree, (sign * 3.0, y, z), (-sign, 0, 0))
    return loc + nor * offset


def _assign_zones(ob):
    """Material slots by geometry after the booleans: 0 body, 1 roof, 2 inner wall, 3 underside."""
    for poly in ob.data.polygons:
        c, n = poly.center, poly.normal
        outward = Vector((math.copysign(max(0.0, abs(c.x) - 0.9) * 3, c.x), c.y, c.z - 0.66))
        if outward.length > 1e-6 and n.dot(outward.normalized()) < -0.3:
            poly.material_index = 2
        elif c.z > 1.0 and n.z > 0.55:
            poly.material_index = 1
        elif c.z < 0.2:
            poly.material_index = 3
        else:
            poly.material_index = 0


def _sharpen(ob, angle=0.7):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > angle:
            e.smooth = False
    bm.to_mesh(ob.data)
    bm.free()


# ---------------------------------------------------------------- build

def build(root):
    """Build the tram under an empty named 'Tram' (the animation target) and return that empty."""
    tram = kit.empty('Tram', (0, 0, -20), root)  # built and baked away from the slab; animation places it
    atlas = bake.Atlas('Tram_Atlas', roughness=0.42, metallic=0.05, register=False)  # baked now, in isolation
    names = {'body': 'tram_body', 'roof': 'roof_metal', 'inner': 'inner', 'under': 'rust', 'trim': 'metal_light', 'rubber': 'rubber', 'equip': 'metal_dark'}

    def part(ob, *kind):
        return atlas.add(ob, *(names[k] for k in kind))

    # Body: subdivided cage -> wall thickness -> boolean window openings.
    shell = kit._link('Tram_Shell', _cage(), parent=tram)
    sub = shell.modifiers.new('round', 'SUBSURF')
    sub.levels = sub.render_levels = 2
    wall = shell.modifiers.new('wall', 'SOLIDIFY')
    wall.thickness = 0.03
    wall.offset = -1.0
    wall.use_even_offset = True
    _apply(shell)
    surface = _bvh(shell)
    cutter = kit._link('Tram_Cutters', _cutters(), parent=tram)
    cut = shell.modifiers.new('openings', 'BOOLEAN')
    cut.operation = 'DIFFERENCE'
    cut.solver = 'EXACT'
    cut.object = cutter
    _apply(shell)
    cutter_mesh = cutter.data
    bpy.data.objects.remove(cutter, do_unlink=True)
    bpy.data.meshes.remove(cutter_mesh)
    _assign_zones(shell)
    _sharpen(shell)
    part(shell, 'body', 'roof', 'inner', 'under')

    glass = kit.material('tram_glass', '#2f4d45', 0.04)
    next(n for n in glass.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Alpha'].default_value = 0.72
    if hasattr(glass, 'surface_render_method'):
        glass.surface_render_method = 'BLENDED'
    seats = kit.material('tram_seats', '#7a3b2a', 0.85)
    lamp = kit.material('tram_lamp', '#fff6d8', 0.2, emission='#fff1c2', strength=5.0)
    cabin_light = kit.material('tram_cabin_light', '#fff1c2', 0.3, emission='#ffd89a', strength=2.0)
    sign = kit.material('tram_sign', '#ffb347', 0.4, emission='#ffb347', strength=2.5)
    marker = kit.material('tram_marker', '#ff4a3a', 0.4, emission='#ff4a3a', strength=2.0)

    # Rubber gaskets around every opening and dark tinted panes set just inside the wall.
    panes = []
    for side in (1, -1):
        for i, (x0, x1) in enumerate(SIDE_WINDOWS + DOOR_WINDOWS):
            outline = _rounded(x0, x1, WIN_Z[0], WIN_Z[1], 0.05)
            part(kit.tube('Tram_Gasket_%s%d' % ('L' if side > 0 else 'R', i), [_side_point(surface, c, d, side, 0.002) for c, d in outline + outline[:1]], 0.011, None, tram, sides=5), 'rubber')
            panes.append([_side_point(surface, c, d, side, -0.02) for c, d in _rounded(x0 + 0.01, x1 - 0.01, WIN_Z[0] + 0.01, WIN_Z[1] - 0.01, 0.045)])
    for sign_x in (1, -1):
        for i, (y0, y1) in enumerate(WINDSCREEN):
            outline = _rounded(y0, y1, 0.66, 0.99, 0.045)
            part(kit.tube('Tram_Screen_Gasket_%s%d' % ('F' if sign_x > 0 else 'B', i), [_front_point(surface, c, d, sign_x, 0.002) for c, d in outline + outline[:1]], 0.011, None, tram, sides=5), 'rubber')
            panes.append([_front_point(surface, c, d, sign_x, -0.02) for c, d in _rounded(y0 + 0.01, y1 - 0.01, 0.67, 0.98, 0.04)])
    bm = bmesh.new()
    for loop in panes:
        bm.faces.new([bm.verts.new(p) for p in loop])
    kit._link('Tram_Glass', _mesh_from_bmesh('Tram_Glass', bm), glass, parent=tram)

    # Cabin: seats facing the aisle and a warm ceiling light strip.
    kit.boxes('Tram_Seats', [((0.2, 0.12, 0.05), ((a + b) / 2, side * 0.3, 0.5)) for a, b in SIDE_WINDOWS for side in (1, -1)]
              + [((0.2, 0.04, 0.2), ((a + b) / 2, side * 0.37, 0.62)) for a, b in SIDE_WINDOWS for side in (1, -1)], seats, tram)
    kit.box('Tram_Ceiling_Light', (1.5, 0.08, 0.015), (0, 0, 1.15), cabin_light, tram)

    # Doors: recessed outline, handrails on standoffs, step plates.
    for side in (1, -1):
        tag = 'L' if side > 0 else 'R'
        for d, (x0, x1) in enumerate(DOORS):
            outline = _rounded(x0, x1, 0.24, 1.0, 0.04)
            part(kit.tube('Tram_Door_%s%d' % (tag, d), [_side_point(surface, c, z, side, 0.001) for c, z in outline + outline[:1]], 0.006, None, tram, sides=4), 'rubber')
            for x in (x0 - 0.03, x1 + 0.03):
                top, bottom = _side_point(surface, x, 0.92, side, 0.035), _side_point(surface, x, 0.36, side, 0.035)
                part(kit.tube('Tram_Handrail_%s%d_%+.2f' % (tag, d, x), [top, bottom], 0.01, None, tram, sides=6), 'trim')
                for z in (0.92, 0.36):
                    part(kit.tube('Tram_Standoff_%s%d_%+.2f_%.2f' % (tag, d, x, z), [_side_point(surface, x, z, side, 0.0), _side_point(surface, x, z, side, 0.035)], 0.007, None, tram, sides=4), 'trim')
            step = _side_point(surface, (x0 + x1) / 2, 0.2, side, 0.04)
            part(kit.box('Tram_Step_%s%d' % (tag, d), (x1 - x0, 0.08, 0.025), (step.x, step.y, 0.15), None, tram, bevel=0.006), 'under')

    # Ends: headlamp, route board, marker lamps, bumper and coupler.
    for sign_x in (1, -1):
        tag = 'F' if sign_x > 0 else 'B'
        head = _front_point(surface, 0.0, 0.44, sign_x, 0.0)
        part(kit.cylinder('Tram_Headlamp_Ring_%s' % tag, 0.075, 0.05, (head.x + sign_x * 0.015, 0, 0.44), None, tram, rot=(0, math.radians(90), 0), segments=24), 'trim')
        kit.cylinder('Tram_Headlamp_%s' % tag, 0.06, 0.012, (head.x + sign_x * 0.042, 0, 0.44), lamp if sign_x > 0 else marker, tram, rot=(0, math.radians(90), 0), segments=24)
        board = _front_point(surface, 0.0, 1.07, sign_x, 0.0)
        kit.box('Tram_Route_Board_%s' % tag, (0.03, 0.42, 0.09), (board.x + sign_x * 0.005, 0, 1.07), sign, tram, bevel=0.008)
        kit.boxes('Tram_Route_Marks_%s' % tag, [((0.01, s[0], s[2]), (board.x + sign_x * 0.022, l[0], 1.07 + l[2])) for s, l in kit.glyph_specs(0.34, 0.07, seed=60 + sign_x, depth=0.01)],
                  kit.material('tram_sign_marks', '#3a2210', 0.6), tram)
        for side in (1, -1):
            m = _front_point(surface, side * 0.27, 0.32, sign_x, 0.0)
            kit.cylinder('Tram_Marker_%s%d' % (tag, side), 0.025, 0.02, (m.x + sign_x * 0.008, m.y, 0.32), marker, tram, rot=(0, math.radians(90), 0), segments=12)
        part(kit.box('Tram_Bumper_%s' % tag, (0.07, 0.7, 0.07), (sign_x * (END + 0.01), 0, 0.2), None, tram, bevel=0.025), 'equip')
        part(kit.box('Tram_Coupler_%s' % tag, (0.14, 0.07, 0.05), (sign_x * (END + 0.08), 0, 0.18), None, tram, bevel=0.012), 'equip')

    # Roof: two rounded equipment boxes with grilles, trolley pole with retriever rope.
    for name, x in (('Front', 0.48), ('Rear', -0.48)):
        crown = _hit(surface, (x, 0, 3.0), (0, 0, -1))[0]
        part(kit.box('Tram_Roof_Box_%s' % name, (0.55, 0.44, 0.15), (x, 0, crown.z + 0.06), None, tram, bevel=0.05), 'equip')
        part(kit.boxes('Tram_Roof_Grille_%s' % name, [((0.4, 0.025, 0.012), (x, y, crown.z + 0.14)) for y in (-0.12, -0.06, 0.0, 0.06, 0.12)], None, tram), 'rubber')
    crown = _hit(surface, (0.05, 0, 3.0), (0, 0, -1))[0]
    base, tip = Vector((0.05, 0, crown.z + 0.05)), Vector((-0.78, 0, crown.z + 0.62))
    part(kit.cylinder('Tram_Pole_Base', 0.07, 0.06, (base.x, 0, crown.z + 0.03), None, tram, segments=16), 'equip')
    part(kit.tube('Tram_Pole', [base, tip], 0.013, None, tram, sides=6), 'equip')
    part(kit.box('Tram_Pole_Shoe', (0.1, 0.05, 0.04), (tip.x - 0.02, 0, tip.z + 0.02), None, tram, bevel=0.01), 'trim')
    rope_end = _front_point(surface, 0.0, 1.0, -1, 0.03)
    part(kit.tube('Tram_Pole_Rope', kit.sag(tip, rope_end, 0.12, n=10), 0.004, None, tram, sides=4), 'rubber')

    # Running gear peeking under the skirt.
    for name, bx in (('Front', 0.62), ('Rear', -0.62)):
        part(kit.box('Tram_Bogie_%s' % name, (0.5, 0.6, 0.06), (bx, 0, 0.12), None, tram, bevel=0.012), 'under')
        for wx in (-0.17, 0.17):
            for side in (1, -1):
                part(kit.cylinder('Tram_Wheel_%s_%+.2f_%d' % (name, wx, side), 0.085, 0.04, (bx + wx, side * 0.29, 0.085), None, tram, rot=(math.radians(90), 0, 0), segments=18), 'under')
            part(kit.tube('Tram_Axle_%s_%+.2f' % (name, wx), [(bx + wx, -0.3, 0.085), (bx + wx, 0.3, 0.085)], 0.018, None, tram, sides=8), 'under')

    atlas.bake()
    tram.location = (0, 0, 0.04)
    return tram
