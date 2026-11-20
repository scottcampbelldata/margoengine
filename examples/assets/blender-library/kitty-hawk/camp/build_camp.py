# The Wright camp at Kill Devil Hills, December 1903, as film assets: the 1903 hangar, the 1901 shed (living quarters
# from 1903), the 60 ft launching rail with its truck, and the props seen in the 17 December photographs.
#   blender -b --factory-startup --python build_camp.py -- [--lod 0|1] [--part all|hangar|shed|rail|props] [--previews 0|1]
#
# Every board, timber, strip of tar paper, lath and nail head is its own piece at its real size: boards are 1 in stock
# (19 mm), framing 2 x 4 in (as sawn in 1903, full size), nails 8d common heads (6.4 mm). Wood takes Poly Haven scans,
# one plank of the scan per board, so no two neighbours repeat. Blender is Z up; each asset is built with its ground
# centre at the origin and its front (the side the film sees first) toward Blender -Y, glTF +Z.
# Asset files go to Assets/blender-library/kitty-hawk/<asset>/ beside the checkout; nothing here is committed but the
# scripts and LABEL.md.

import math
import os
import random
import shutil
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import kh_common as K  # noqa: E402

OPT = K.cli({"lod": 0, "previews": 1, "part": "all", "out": ""})
LOD = OPT["lod"]
ROOT = OPT["out"] or os.path.join(K.LIBRARY, "kitty-hawk")
TEX = os.path.join(ROOT, "camp-textures")
os.makedirs(TEX, exist_ok=True)
FT, IN = K.FT, K.IN
NAILS = LOD == 0
SFX = "" if LOD == 0 else "-lod1"

# Lumber (full sawn sizes of 1903) and fastenings
BOARD_T = 0.75 * IN          # 1 in boards dressed to about 3/4 in
BOARD_W = 7.5 * IN           # 8 in boards
BATTEN_W, BATTEN_T = 2.5 * IN, 0.75 * IN
STUD_W, STUD_D = 2 * IN, 4 * IN
NAIL_R = 0.0032


# ---------------------------------------------------------------- textures
class Wood:
    """A plank scan: its planks as stripes across the grain (0..1), the grain axis, metres per repeat along it."""

    def __init__(self, maps, stripes, grain, tile):
        self.maps, self.stripes, self.grain, self.tile = maps, stripes, grain, tile


def prepare_textures():
    import numpy as np
    ph = os.path.join(K.DOWNLOADS, "polyhaven")
    size = 4096 if LOD == 0 else 1024

    def keep(src, name, regrade=None, fmt="JPEG"):
        dst = os.path.join(TEX, name + ("-1k" if LOD else "") + (".jpg" if fmt == "JPEG" else ".png"))
        if os.path.exists(dst):
            return dst
        a = K.load_pixels(src)
        if a.shape[0] != size:
            a = K.resize(a, size, size)
        if regrade:
            a[..., :3] = regrade(a[..., :3])
        K.save_pixels(a, dst, fmt, 93)
        return dst

    def maps(pid, key, colour, contrast, rough_shift=0.0):
        d = os.path.join(ph, pid)
        return dict(
            color=keep(os.path.join(d, f"{pid}_diff_4k.jpg"), f"{key}_color",
                       lambda c: K.regrade(c, colour, keep_contrast=contrast)),
            rough=keep(os.path.join(d, f"{pid}_rough_4k.jpg"), f"{key}_rough",
                       lambda c: np.clip(c + rough_shift, 0, 1)),
            normal=keep(os.path.join(d, f"{pid}_nor_gl_4k.jpg"), f"{key}_normal"),
            ao=keep(os.path.join(d, f"{pid}_ao_4k.jpg"), f"{key}_ao"))

    # Hinoki planks: 13 planks a repeat, joints every 315.6 px from 318 (found from the scan's height map).
    cuts = [2] + [318 + 315.6 * k for k in range(12)] + [4094]
    pine_stripes = [(a / 4096, b / 4096) for a, b in zip(cuts[:-1], cuts[1:])]
    grey_cuts = [0, 822, 1647, 2462, 3278, 4096]
    grey_stripes = [(a / 4096, b / 4096) for a, b in zip(grey_cuts[:-1], grey_cuts[1:])]
    T = {
        # The 1903 hangar was new lumber in October 1903: pine two months in the sun and salt air, not yet silver.
        "pine": Wood(maps("hinoki_planks", "pine", (178, 152, 114), 0.9), pine_stripes, "u", 3.1),
        # The 1901 shed after two coastal summers and two winters: silver-grey, raised grain, darker end grain.
        "grey": Wood(maps("wood_planks_grey", "greywood", (151, 146, 136), 1.0, 0.05), grey_stripes, "v", 1.0),
        # Tar paper roofing, faded and dusted with sand on the old shed.
        "tar": maps("bitumen", "tarpaper", (52, 51, 50), 1.0, -0.05),
        "tar_old": maps("bitumen", "tarpaper_old", (74, 71, 66), 0.9, 0.08),
    }
    return T


def wood_material(name, wood, tint=(1, 1, 1, 1)):
    return K.material(name, color=tint, rough=0.8, tex=dict(wood.maps), normal_strength=1.0)


def materials(T):
    M = {
        "pine": wood_material("hangar pine", T["pine"]),
        "grey": wood_material("weathered grey boards", T["grey"]),
        "tar": K.material("tar paper", rough=0.8, tex=dict(T["tar"]), normal_strength=0.8),
        "tar_old": K.material("old tar paper", rough=0.85, tex=dict(T["tar_old"]), normal_strength=0.8),
        "nail": K.material("nail heads", color=(0.20, 0.16, 0.12, 1), metal=0.7, rough=0.65),
        "iron": K.material("strap iron", color=(0.17, 0.14, 0.12, 1), metal=0.85, rough=0.55),
        "glass": K.material("window glass", color=(0.05, 0.06, 0.065, 1), rough=0.04),
        "tin": K.material("tinned sheet steel", color=(0.62, 0.62, 0.60, 1), metal=1.0, rough=0.42),
        "rope": K.material("manila rope", color=(0.52, 0.42, 0.27, 1), rough=0.9),
        "steel": K.material("tool steel", color=(0.42, 0.42, 0.41, 1), metal=1.0, rough=0.45),
        "brass": K.material("brass", color=(0.80, 0.64, 0.34, 1), metal=1.0, rough=0.34),
        "aluminium": K.material("aluminium", color=(0.80, 0.80, 0.78, 1), metal=1.0, rough=0.35),
        "black": K.material("black leather and japanning", color=(0.025, 0.022, 0.02, 1), rough=0.45),
        "bellows": K.material("bellows leather", color=(0.03, 0.025, 0.022, 1), rough=0.6),
        "enamel": K.material("dial enamel", color=(0.86, 0.84, 0.78, 1), rough=0.25),
        "mahogany": K.material("varnished mahogany", color=(0.30, 0.12, 0.06, 1), rough=0.3),
        "ash": K.material("ash handle", color=(0.55, 0.42, 0.28, 1), rough=0.5),
        "glow": K.material("lamp-lit window", color=(0.0, 0.0, 0.0, 1), rough=1.0, emission=(1.0, 0.58, 0.26, 6.0)),
        "cloth": K.material("signal cloth (unbleached muslin)", color=(0.80, 0.76, 0.66, 1), rough=0.9, double=True,
                            sheen=(0.6, 0.58, 0.52, 0.5)),
        "oak": K.material("oak staves", color=(0.55, 0.45, 0.37, 1), rough=0.7, tex=dict(T["pine"].maps), normal_strength=1.2),
    }
    return M


# ---------------------------------------------------------------- pieces
def stripe_uv(part, f0, f1, wood, c, ldir, wdir, L, W, T, rng):
    """Maps faces f0..f1 of a board to one plank of the scan: along its length at the scan's scale from a random start,
    across to the plank's inner 76 %. Broad faces take the board's width across the plank, edges its thickness (so a
    timber on edge shows grain, not a smear), and the end grain a small patch of it."""
    a, b = rng.choice(wood.stripes)
    off = rng.random()
    flipw = rng.random() < 0.5
    ndir = ldir.cross(wdir)
    for fi in range(f0, f1):
        P = [Vector(part.V[vi]) - c for vi in part.F[fi]]
        nrm = (P[1] - P[0]).cross(P[2] - P[0])
        if nrm.length < 1e-12 and len(P) > 3:
            nrm = (P[2] - P[0]).cross(P[3] - P[0])
        dl, dw, dn = abs(nrm.dot(ldir)), abs(nrm.dot(wdir)), abs(nrm.dot(ndir))
        uvs = []
        for p in P:
            if dl >= max(dw, dn):                       # end grain: a patch, squeezed
                s = off + p.dot(ndir) / wood.tile * 0.3
                t = p.dot(wdir) / W + 0.5
            elif dw > dn:                               # an edge: across = the thickness
                s = p.dot(ldir) / wood.tile + off
                t = p.dot(ndir) / max(T, W) + 0.5
            else:                                       # a broad face
                s = p.dot(ldir) / wood.tile + off
                t = p.dot(wdir) / W + 0.5
            t = min(1.0, max(0.0, t))
            if flipw:
                t = 1 - t
            across = a + (b - a) * (0.12 + 0.76 * t)
            uvs.append((across, s) if wood.grain == "v" else (s, across))
        part.UV[fi] = uvs


def board(part, mat, wood, c, ldir, wdir, L, W, T, rng, jitter=True, edge=0.0025):
    """One sawn board or timber centred at c: L along ldir, W along wdir, T through. Eased edges; a hand-built set of
    a millimetre or two and a fraction of a degree, as boards nailed up by eye sit."""
    c, ldir = Vector(c), Vector(ldir).normalized()
    wdir = (Vector(wdir) - Vector(wdir).dot(ldir) * ldir).normalized()
    ndir = ldir.cross(wdir)
    if jitter:
        R = Matrix.Rotation(math.radians(rng.uniform(-0.25, 0.25)), 3, ndir)
        ldir, wdir = R @ ldir, R @ wdir
        c = c + ndir * rng.uniform(-0.0015, 0.0015)
    f0 = len(part.F)
    part.beam(c - ldir * L / 2, c + ldir * L / 2, W, T, mat, r=min(edge, T * 0.3), ref=wdir, segs=1, chamfer=False)
    stripe_uv(part, f0, len(part.F), wood, c, ldir, wdir, L, W, T, rng)
    return c, ldir, wdir, ndir


def nail(part, mat, p, n):
    """An 8d common nail head, set a hair proud of the face, with a little rust bloom."""
    if not NAILS:
        return
    part.lathe([(0.0, 0.0), (NAIL_R, 0.0), (NAIL_R * 0.92, 0.0012), (0.0, 0.0016)], p, n, mat, segs=7, caps=(False, False))


def plank_planar(part, f0, f1, origin, udir, vdir, scale):
    for fi in range(f0, f1):
        part.UV[fi] = [((Vector(part.V[vi]) - Vector(origin)).dot(udir) / scale,
                        (Vector(part.V[vi]) - Vector(origin)).dot(vdir) / scale) for vi in part.F[fi]]


# ---------------------------------------------------------------- buildings
def building(name, L, W, eave, pitch, mat, wood, roof_mat, rng, end_doors, front=(), chimney=None, overhang=(0.30, 0.25),
             battens=True, open_angle=70.0, glow=None, tower=None):
    """A Wright camp building: board-and-batten walls on a 2 x 4 frame, sills on the sand, a gable roof of boards
    covered with tar paper in 36 in courses held by laths. end_doors: the gable ends (+1 east, -1 west) with a door
    hinged at the top, raised as an awning on two props. front: openings in the -Y wall. glow: true for a lamp-lit
    card behind each window, all in one node `<name>_window_glow` the film shows at night and hides by day. tower: a
    lookout deck with a rail and a flagpole on the ridge, (x, deck height above the ridge)."""
    glow_part = K.Part(name + "_window_glow") if glow else None
    root = K.empty(name)
    frame, walls, roof, iron = K.Part(name + "_frame"), K.Part(name + "_walls"), K.Part(name + "_roof"), K.Part(name + "_ironwork")
    tanp = math.tan(math.radians(pitch))
    ridge = eave + W / 2 * tanp
    door_w = W - 2 * 0.32
    door_top = eave
    door_h = door_top - 0.05
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    so = W / 2                    # outer face of the studs
    sheath = so + BOARD_T / 2     # wall boards' centre plane

    def roof_z(y):
        return eave + (W / 2 - abs(y)) * tanp

    # --- frame: sills, posts, studs, girts, plates, ties, rafters, ridge board
    def timber(a, b, w, h, ref):
        a, b = Vector(a), Vector(b)
        d = b - a
        board(frame, mat, wood, (a + b) / 2, d, ref, d.length, w, h, rng, jitter=False)

    for s in (-1, 1):
        y = s * (so - STUD_D / 2)
        timber((-L / 2, y, 0.05), (L / 2, y, 0.05), STUD_D, STUD_D, Y)                     # 4 x 4 sills
        timber((-L / 2, y, eave - STUD_W / 2), (L / 2, y, eave - STUD_W / 2), STUD_D, STUD_W, Y)  # plates
        timber((-L / 2, y, eave - STUD_W * 1.5), (L / 2, y, eave - STUD_W * 1.5), STUD_D, STUD_W, Y)
        timber((-L / 2, y, eave * 0.5), (L / 2, y, eave * 0.5), STUD_D, STUD_W, Y)          # girt for the boards
        n = int(L / 0.61)
        for k in range(n + 1):
            x = -L / 2 + STUD_W / 2 + k * (L - STUD_W) / n
            skip = any(abs(x - o["at"]) < o["w"] / 2 + 0.02 for o in front) if s < 0 else False
            if not skip:
                timber((x, y, 0.1), (x, y, eave - STUD_W * 2), STUD_W, STUD_D, X)
    for e in (-1, 1):
        x = e * (L / 2 - STUD_D / 2)
        timber((x, -so, 0.05), (x, so, 0.05), STUD_D, STUD_D, X)
        for y in (-door_w / 2 - STUD_W / 2, door_w / 2 + STUD_W / 2) if e in end_doors else []:
            timber((x, y, 0.1), (x, y, roof_z(y) - 0.02), STUD_W * 2, STUD_D, Y)          # door jambs
        if e in end_doors:
            timber((x, -door_w / 2 - STUD_W, door_top + 0.07), (x, door_w / 2 + STUD_W, door_top + 0.07), STUD_D, 6 * IN, X)
        for y in [-so + 0.05, so - 0.05] + [k * 0.61 for k in range(-int(W / 1.22), int(W / 1.22) + 1)]:
            if e in end_doors and abs(y) < door_w / 2 + STUD_W * 2:
                if roof_z(y) - 0.04 > door_top + 0.15:
                    timber((x, y, door_top + 0.15), (x, y, roof_z(y) - 0.04), STUD_W, STUD_D, Y)
                continue
            timber((x, y, 0.1), (x, y, roof_z(y) - 0.04), STUD_W, STUD_D, Y)
    nt = int(L / 1.83)
    for k in range(nt + 1):
        x = -L / 2 + 0.1 + k * (L - 0.2) / nt
        timber((x, -so + 0.02, eave + 0.05), (x, so - 0.02, eave + 0.05), STUD_W, STUD_D, X)      # ceiling ties
    nr = int(L / 0.61)
    rl = (W / 2 + overhang[1]) / math.cos(math.radians(pitch))
    for k in range(nr + 1):
        x = -L / 2 + STUD_W / 2 + k * (L - STUD_W) / nr
        for s in (-1, 1):
            a = Vector((x, s * (W / 2 + overhang[1]), eave - overhang[1] * tanp + 0.05))
            b = Vector((x, 0, ridge + 0.05))
            d = (b - a).normalized()
            up = X.cross(d) * (-s)
            timber(a, b, STUD_W, STUD_D, X)
    timber((-L / 2 - overhang[0], 0, ridge + 0.03), (L / 2 + overhang[0], 0, ridge + 0.03), BOARD_T, 7.5 * IN, Y)

    # --- walls: vertical boards with battens over the joints
    def wall_boards(x0, x1, plane_pt, along, normal, z_bot, z_top_of, skip=lambda t, z0, z1: None):
        """Boards from x0 to x1 (positions along `along`), bottom z_bot, top from z_top_of(t)."""
        pitch_b = BOARD_W + 0.004
        n = int((x1 - x0) / pitch_b)
        t = x0
        joints = []
        while t + pitch_b * 0.5 < x1:
            w = min(BOARD_W, x1 - t - 0.004)
            tc = t + w / 2
            zt = min(z_top_of(t), z_top_of(t + w))
            segs = skip(tc, z_bot, zt) or [(z_bot, zt)]
            for za, zb in segs:
                if zb - za < 0.05:
                    continue
                c = Vector(plane_pt) + along * tc + Z * ((za + zb) / 2)
                board(walls, mat, wood, c, Z, along, zb - za, w, BOARD_T, rng)
                for zz in (0.08, eave * 0.5, min(zb, eave) - 0.06):
                    if za + 0.03 < zz < zb - 0.03:
                        for dt in (-w * 0.28, w * 0.28):
                            nail(iron, mat_n, c + along * dt + Z * (zz - (za + zb) / 2) + normal * BOARD_T / 2, normal)
            joints.append((t + w + 0.002, segs))
            t += w + 0.004
        if battens:
            for tj, segs in joints[:-1]:
                for za, zb in segs:
                    if zb - za < 0.05:
                        continue
                    zt = min(zb, z_top_of(tj - BATTEN_W / 2), z_top_of(tj + BATTEN_W / 2))
                    c = Vector(plane_pt) + along * tj + Z * ((za + zt) / 2) + normal * (BOARD_T / 2 + BATTEN_T / 2 + 0.0005)
                    board(walls, mat, wood, c, Z, along, zt - za - 0.01, BATTEN_W, BATTEN_T, rng)
                    for zz in (0.15, eave * 0.27, eave * 0.5, eave * 0.73, min(zt, eave) - 0.12):
                        if za + 0.05 < zz < zt - 0.05:
                            nail(iron, mat_n, c + Z * (zz - (za + zt) / 2) + normal * BATTEN_T / 2, normal)

    mat_n = M_["nail"]

    def front_skip(tc, za, zb):
        for o in front:
            if abs(tc - o["at"]) < o["w"] / 2:
                segs = []
                if o["bottom"] > za + 0.05:
                    segs.append((za, o["bottom"]))
                if o["bottom"] + o["h"] < zb - 0.05:
                    segs.append((o["bottom"] + o["h"], zb))
                return segs or [(0, 0)]
        return None

    for s in (-1, 1):
        n = Vector((0, s, 0))
        wall_boards(-L / 2 - BOARD_T, L / 2 + BOARD_T, (0, s * sheath, 0), X * 1.0, n, 0.0, lambda t: eave,
                    front_skip if s < 0 else (lambda tc, za, zb: None))
    for e in (-1, 1):
        n = Vector((e, 0, 0))

        def end_skip(tc, za, zb, e=e):
            if e in end_doors and abs(tc) < door_w / 2:
                return [(door_top + 0.02, zb)]
            return None
        wall_boards(-W / 2 - BOARD_T, W / 2 + BOARD_T, (e * (L / 2 + BOARD_T / 2), 0, 0), Y * 1.0, n, 0.0,
                    lambda t: roof_z(t) - 0.01, end_skip)
        # verge (barge) boards along the gable under the roof edge
        for s in (-1, 1):
            a = Vector((e * (L / 2 + BOARD_T * 1.5 + overhang[0] - 0.05), s * (W / 2 + overhang[1]), eave - overhang[1] * tanp - 0.06))
            b = Vector((e * (L / 2 + BOARD_T * 1.5 + overhang[0] - 0.05), 0, ridge - 0.06))
            board(roof, mat, wood, (a + b) / 2, b - a, X.cross((b - a).normalized()) * -s, (b - a).length, 5.5 * IN, BOARD_T, rng)

    # --- roof: boards along the length, tar paper in courses up the slope, laths over the laps
    for s in (-1, 1):
        up = Vector((0, -s, tanp)).normalized()        # up the slope
        nrm = Vector((0, s * tanp, 1)).normalized()     # roof normal
        lo = Vector((0, s * (W / 2 + overhang[1]), eave - overhang[1] * tanp + 0.05)) + nrm * (STUD_D / 2 + BOARD_T / 2)
        slope_len = (W / 2 + overhang[1]) / math.cos(math.radians(pitch))
        k = 0
        d = 0.0
        while d < slope_len - 0.02:
            w = min(BOARD_W, slope_len - d)
            c = lo + up * (d + w / 2)
            board(roof, mat, wood, c, X, up, L + 2 * overhang[0], w, BOARD_T, rng)
            d += w + 0.006
            k += 1
        course = 36 * IN
        lap = 2 * IN
        tar_base = lo + nrm * (BOARD_T / 2 + 0.001)
        d = 0.0
        i = 0
        while d < slope_len:
            w = min(course, slope_len - d + 0.04)
            c = tar_base + up * (d + w / 2) + nrm * (0.0010 * i)
            f0 = len(roof.F)
            roof.beam(c - X * (L / 2 + overhang[0] + 0.02), c + X * (L / 2 + overhang[0] + 0.02), w, 0.0016, roof_mat,
                      r=0.0006, ref=up, segs=1, chamfer=False)
            plank_planar(roof, f0, len(roof.F), tar_base, X, up, 1.6)
            # lath over the upper edge (the next course laps over it) and along the lower edge of this one
            lc = c - up * (w / 2 - 0.03) + nrm * (0.0016 + 0.25 * IN + 0.0005)
            board(roof, mat, wood, lc, X, up, L + 2 * overhang[0], 1.5 * IN, 0.5 * IN, rng)
            for xx in [-L / 2 - overhang[0] + 0.1 + j * 0.30 for j in range(int((L + 2 * overhang[0]) / 0.30))]:
                nail(iron, mat_n, lc + X * xx + nrm * 0.25 * IN, nrm)
            if d + w >= slope_len:
                break
            d += w - lap
            i += 1
    # ridge cap: two boards over the top
    for s in (-1, 1):
        nrm = Vector((0, s * tanp, 1)).normalized()
        up = Vector((0, -s, tanp)).normalized()
        c = Vector((0, 0, ridge + 0.05)) + nrm * (STUD_D / 2 + BOARD_T * 2 + 0.012) - up * 0.07
        board(roof, mat, wood, c, X, up, L + 2 * overhang[0] + 0.02, 5.5 * IN, BOARD_T, rng)

    # --- end doors, hinged at the top, raised as awnings on props
    doors = []
    for e in end_doors:
        hinge = K.empty(f"{name}_door_{'east' if e > 0 else 'west'}", (e * (L / 2 + BOARD_T * 1.5 + 0.004), 0, door_top), root)
        hinge.rotation_euler = (0, -math.radians(open_angle), 0 if e > 0 else math.pi)
        dp, di = K.Part(hinge.name + "_leaf"), K.Part(hinge.name + "_hinges")
        # leaf in hinge space: outward +X, hanging down -Z, across Y
        t = -door_w / 2
        while t < door_w / 2 - 0.05:
            w = min(BOARD_W, door_w / 2 - t)
            board(dp, mat, wood, (BOARD_T / 2, t + w / 2, -door_h / 2), Z, Y, door_h, w, BOARD_T, rng)
            t += w + 0.004
        for zz in (-0.15, -door_h / 2, -door_h + 0.15):                               # ledges inside
            board(dp, mat, wood, (-BATTEN_T, 0, zz), Y, Z, door_w - 0.1, 5.5 * IN, BOARD_T, rng)
        for s in (-1, 1):                                                            # braces
            a = Vector((-BATTEN_T, s * (door_w / 2 - 0.15), -door_h + 0.22))
            b = Vector((-BATTEN_T, s * 0.05, -door_h / 2 - 0.08))
            board(dp, mat, wood, (a + b) / 2, b - a, X.cross((b - a).normalized()), (b - a).length, 5.5 * IN, BOARD_T, rng)
        for yy in (-door_w / 2 + 0.35, door_w / 2 - 0.35):                            # strap hinges
            di.box((BOARD_T + 0.002, yy, -0.22), (0.003, 0.05, 0.44), M_["iron"], r=0.001)
            di.rod((BOARD_T + 0.006, yy - 0.04, 0.0), (BOARD_T + 0.006, yy + 0.04, 0.0), 0.009, M_["iron"], segs=10)
            for zz in (-0.06, -0.2, -0.36):
                nail(di, M_["iron"], (BOARD_T + 0.0035, yy, zz), (1, 0, 0))
        dp.to_object(hinge)
        if NAILS:
            di.to_object(hinge)
        # props: two 2 x 3 poles from the sand to the raised door's lower edge
        props = K.Part(f"{name}_door_{'east' if e > 0 else 'west'}_props")
        a_open = math.radians(open_angle)
        edge_x = e * (L / 2 + BOARD_T * 1.5 + door_h * math.sin(a_open) - 0.05)
        edge_z = door_top - door_h * math.cos(a_open) + 0.02
        for s in (-1, 1):
            top = Vector((edge_x, s * (door_w / 2 - 0.25), edge_z))
            foot = Vector((edge_x + e * 0.45, s * (door_w / 2 - 0.05), 0.0))
            board(props, mat, wood, (top + foot) / 2, top - foot, X, (top - foot).length, 3 * IN, 2 * IN, rng)
        props.to_object(root)
        doors.append(hinge.name)

    # --- front openings: a plank door and four-light sash windows
    for o in front:
        x0 = o["at"]
        if o["kind"] == "door":
            hinge = K.empty(f"{name}_side_door", (x0 - o["w"] / 2, -(sheath + BOARD_T), o["bottom"]), root)
            dp = K.Part(f"{name}_side_door_leaf")
            t = 0.0
            while t < o["w"] - 0.05:
                w = min(5.5 * IN, o["w"] - t)
                board(dp, mat, wood, (t + w / 2, -BOARD_T / 2, o["h"] / 2), Z, X, o["h"] - 0.01, w, BOARD_T, rng)
                t += w + 0.003
            for zz in (0.2, o["h"] / 2, o["h"] - 0.2):
                board(dp, mat, wood, (o["w"] / 2, BATTEN_T / 2 + 0.001, zz), X, Z, o["w"] - 0.08, 4.5 * IN, BOARD_T, rng)
            for zz in (0.25, o["h"] - 0.25):
                dp.box((0.16, -BOARD_T - 0.002, zz), (0.32, 0.003, 0.04), M_["iron"], r=0.001)
            dp.box((o["w"] - 0.1, -BOARD_T - 0.02, o["h"] * 0.5), (0.16, 0.025, 0.03), mat, r=0.004)  # wooden latch
            dp.to_object(hinge)
        else:
            c = Vector((x0, -(sheath + BOARD_T / 2), o["bottom"] + o["h"] / 2))
            fw = 3.5 * IN
            for zz in (o["bottom"] + 0.02, o["bottom"] + o["h"] - 0.02):                 # sill and head
                board(walls, mat, wood, (x0, c.y - 0.01, zz), X, Z, o["w"] + 2 * fw, fw, BOARD_T, rng)
            for xx in (x0 - o["w"] / 2 - fw / 2 + 0.02, x0 + o["w"] / 2 + fw / 2 - 0.02):  # casings
                board(walls, mat, wood, (xx, c.y - 0.01, c.z), Z, X, o["h"], fw, BOARD_T, rng)
            sash = K.Part(f"{name}_window_{int(x0 * 10)}")
            sw, sh = o["w"] - 0.04, o["h"] - 0.08
            for zz in (-sh / 2, 0, sh / 2):
                sash.box((x0, c.y + 0.02, c.z + zz), (sw, 0.03, 0.035), M_["grey" if mat is M_["grey"] else "pine"], r=0.003)
            for xx in (-sw / 2, 0, sw / 2):
                sash.box((x0 + xx, c.y + 0.02, c.z), (0.035, 0.03, sh), M_["grey" if mat is M_["grey"] else "pine"], r=0.003)
            sash.box((x0, c.y + 0.03, c.z), (sw - 0.02, 0.003, sh - 0.02), M_["glass"], r=0.0005)
            sash.to_object(root)
            if glow_part:
                glow_part.box((x0, c.y + 0.026, c.z), (sw - 0.03, 0.002, sh - 0.03), M_["glow"], r=0.0003)

    if chimney:
        cx, cy = chimney
        zr = roof_z(cy) + 0.08
        iron.tube([(cx, cy, zr - 0.6), (cx, cy, zr + 0.95)], 0.065, M_["tin"], segs=20)
        iron.lathe([(0.0, 0.0), (0.16, 0.0), (0.0, 0.11)], (cx, cy, zr + 1.02), (0, 0, 1), M_["tin"], segs=20, caps=(False, False))
        for k in range(3):
            a = 2 * math.pi * k / 3
            iron.rod((cx + 0.065 * math.cos(a), cy + 0.065 * math.sin(a), zr + 0.95), (cx + 0.1 * math.cos(a), cy + 0.1 * math.sin(a), zr + 1.03), 0.004, M_["tin"], segs=5)
        iron.lathe([(0.0, 0.0), (0.16, 0.0), (0.12, 0.02), (0.0, 0.025)], (cx, cy, zr - 0.02), (0, 0, 1), M_["tin"], segs=20)  # flashing

    if tower:
        tx, th = tower
        tw = 1.6
        zt = ridge + th
        for sx in (-1, 1):
            for sy in (-1, 1):
                frame.beam((tx + sx * tw / 2, sy * tw / 2, roof_z(sy * tw / 2) - 0.05), (tx + sx * tw / 2, sy * tw / 2, zt + 1.0),
                           0.09, 0.09, mat, r=0.006)
        nb = int(tw / (5.5 * IN))
        for i in range(nb):
            yy = -tw / 2 + (i + 0.5) * tw / nb
            board(roof, mat, wood, (tx, yy, zt), X, Y, tw + 0.1, 5.4 * IN, 0.03, rng)
        for zz in (zt + 0.5, zt + 1.0):
            for s in (-1, 1):
                frame.beam((tx - tw / 2, s * tw / 2, zz), (tx + tw / 2, s * tw / 2, zz), 0.05, 0.07, mat, r=0.005)
                frame.beam((tx + s * tw / 2, -tw / 2, zz), (tx + s * tw / 2, tw / 2, zz), 0.05, 0.07, mat, r=0.005)
        frame.beam((tx + tw / 2 - 0.1, tw / 2 - 0.1, zt), (tx + tw / 2 - 0.1, tw / 2 - 0.1, zt + 6.5), 0.08, 0.08, mat, r=0.03)
    for p in (frame, walls, roof):
        p.to_object(root, smooth_angle=30)
    if glow_part and glow_part.F:
        glow_part.to_object(root)
    if iron.F:
        iron.to_object(root, smooth_angle=60)
    return root, doors


# ---------------------------------------------------------------- the launching rail and its truck
def build_rail(rng):
    """Four 15 ft lengths of 2 x 4 set on edge, end to end, 60 ft in all, capped with a thin iron strip; a truck of a
    plank on two modified bicycle hubs carries the machine, its skids on a cross-beam. Runs along Blender +Y (glTF -Z)
    from the south end at the origin."""
    M = M_
    root = K.empty("launch_rail")
    wood, iron = K.Part("rail_wood"), K.Part("rail_iron")
    W = T_["pine"]
    for k in range(4):
        y0 = k * 15 * FT
        board(wood, M["pine"], W, (0, y0 + 7.5 * FT, STUD_D / 2), Y_, X_, 15 * FT - 0.004, STUD_W, STUD_D, rng)
        # cleats holding the joints, and blocks under the rail where the sand was levelled
        if k:
            for s in (-1, 1):
                board(wood, M["pine"], W, (s * (STUD_W / 2 + BOARD_T / 2), y0, STUD_D / 2), Y_, Z_, 0.45, STUD_D * 0.8, BOARD_T, rng)
        for yy in (y0 + 0.4, y0 + 7.5 * FT, y0 + 15 * FT - 0.4):
            board(wood, M["pine"], W, (0, yy, -0.03), X_, Y_, 0.38, 0.14, STUD_W, rng)
            nail(iron, M["nail"], (0.0, yy, STUD_D + 0.0016), (0, 0, 1))
    iron.box((0, 30 * FT, STUD_D + 0.0008), (1 * IN, 60 * FT, 0.0016), M["iron"], r=0.0004)
    for k in range(int(60 * FT / 0.4)):
        nail(iron, M["nail"], (0, 0.2 + k * 0.4, STUD_D + 0.0018), (0, 0, 1))
    # the anchor at the start: a stake and the wire that held the truck until the release
    wood.beam((0.0, -0.9, -0.3), (0.0, -0.9, 0.35), 0.06, 0.06, M["pine"], r=0.008)
    wood.to_object(root, smooth_angle=30)
    iron.to_object(root, smooth_angle=60)
    truck = K.empty("truck", (0, 0.9, STUD_D + 0.0016), root)
    tp = K.Part("truck_wood")
    ti = K.Part("truck_hubs")
    board(tp, M["pine"], W, (0, 0, 0.065), Y_, X_, 1.9, 5.5 * IN, 1.5 * IN, rng, jitter=False)
    board(tp, M["pine"], W, (0, 0.55, 0.065 + 0.019 + 0.045), X_, Y_, 1.85, 3.5 * IN, 3.5 * IN, rng, jitter=False)
    board(tp, M["pine"], W, (0, -0.55, 0.065 + 0.019 + 0.045), X_, Y_, 0.6, 3.5 * IN, 1.5 * IN, rng, jitter=False)
    for yy in (-0.7, 0.7):
        # a bicycle hub turned into a flanged wheel: the flanges straddle the rail's strip
        ti.lathe([(0.0, -0.032), (0.028, -0.032), (0.03, -0.026), (0.02, -0.024), (0.02, 0.024), (0.03, 0.026), (0.028, 0.032), (0.0, 0.032)],
                 (0, yy, 0.026), (1, 0, 0), M["steel"], segs=24, caps=(True, True))
        ti.rod((-0.05, yy, 0.026), (0.05, yy, 0.026), 0.006, M["steel"], segs=10)
        for s in (-1, 1):
            ti.box((s * 0.045, yy, 0.045), (0.006, 0.05, 0.05), M["iron"], r=0.001)
    tp.to_object(truck, smooth_angle=30)
    ti.to_object(truck, smooth_angle=50)
    rope = K.Part("restraining_wire")
    rope.tube([(0, -0.9, 0.3), (0, -0.4, 0.17), (0, 0.9 - 0.95, STUD_D + 0.07)], 0.004, M["rope"], segs=6)
    rope.to_object(root)
    return root


# ---------------------------------------------------------------- props
def sawhorse(rng):
    root = K.empty("sawhorse")
    p = K.Part("sawhorse_wood")
    W, m = T_["pine"], M_["pine"]
    H, L = 0.74, 1.05
    board(p, m, W, (0, 0, H - 0.045), X_, Y_, L, 5.5 * IN, 1.5 * IN, rng)
    for sx in (-1, 1):
        for sy in (-1, 1):
            top = Vector((sx * (L / 2 - 0.12), sy * 0.04, H - 0.09))
            foot = Vector((sx * (L / 2 - 0.02), sy * 0.30, 0.0))
            board(p, m, W, (top + foot) / 2, top - foot, X_, (top - foot).length, 3.5 * IN, 1.5 * IN, rng)
        board(p, m, W, (sx * (L / 2 - 0.09), 0, H * 0.45), Y_, Z_, 0.42, 3.5 * IN, BOARD_T, rng)
    p.to_object(root, smooth_angle=30)
    return root


def bench(rng):
    """The low bench the right wing tip rested on at the start of the rail."""
    root = K.empty("bench")
    p, n = K.Part("bench_wood"), K.Part("bench_nails")
    W, m = T_["grey"], M_["grey"]
    H, L = 0.44, 1.25
    board(p, m, W, (0, 0, H - 0.019), X_, Y_, L, 9.25 * IN, 1.5 * IN, rng)
    for sx in (-1, 1):
        board(p, m, W, (sx * (L / 2 - 0.12), 0, (H - 0.038) / 2), Z_, Y_, H - 0.038, 9.25 * IN, 1.5 * IN, rng)
        for sy in (-1, 1):
            nail(n, M_["nail"], (sx * (L / 2 - 0.12), sy * 0.06, H), (0, 0, 1))
    for sy in (-1, 1):
        board(p, m, W, (0, sy * (9.25 * IN / 2 - 0.01), H - 0.08), X_, Z_, L - 0.3, 3.5 * IN, BOARD_T, rng)
    p.to_object(root, smooth_angle=30)
    if n.F:
        n.to_object(root)
    return root


def shovel(rng):
    """A long-handled round-point shovel lying on the sand, as in the first-flight photograph."""
    root = K.empty("shovel")
    p = K.Part("shovel")
    p.lathe([(0.0, 0.0), (0.017, 0.0), (0.018, 0.4), (0.0175, 1.0), (0.016, 1.18), (0.0, 1.2)], (0, 0.24, 0.02), (0, 1, 0), M_["ash"], segs=14, caps=(True, True))
    p.lathe([(0.0, 0.0), (0.021, 0.0), (0.019, 0.17), (0.0, 0.18)], (0, 0.08, 0.02), (0, 1, 0), M_["steel"], segs=14, caps=(True, True))
    # blade: a dished round-point outline, 2 mm steel, swept up at the sides
    out = []
    for k in range(25):
        t = k / 24
        a = math.pi * t
        out.append((0.115 * math.cos(a), -0.02 - 0.29 * math.sin(a) ** 0.9 * (1 if t < 0.5 or True else 1)))
    pts = [(0.115, 0.06), (-0.115, 0.06)] + [(x, y) for x, y in out[::-1]]
    p.extrude([(x, y) for x, y in pts], (0, 0.0, 0.02), (0, 0, 1), 0.002, M_["steel"], ref=(1, 0, 0))
    p.to_object(root, smooth_angle=50)
    return root


def tin_can(rng):
    root = K.empty("tin_can")
    p = K.Part("tin_can")
    r, h = 0.085, 0.24
    p.lathe([(0.0, 0.0), (r - 0.003, 0.0), (r, 0.004), (r + 0.002, 0.008), (r, 0.012), (r, 0.08), (r + 0.002, 0.084), (r, 0.088),
             (r, h - 0.088), (r + 0.002, h - 0.084), (r, h - 0.08), (r, h - 0.012), (r + 0.002, h - 0.008), (r, h - 0.004),
             (r - 0.003, h), (0.0, h - 0.003)], (0, 0, 0), (0, 0, 1), M_["tin"], segs=40, caps=(True, True))
    p.rod((0.05, 0.0, h - 0.002), (0.05, 0.0, h + 0.03), 0.012, M_["tin"], segs=12)          # pour spout
    p.tube([(-r - 0.004, 0, h - 0.03)] + [(-r * math.cos(a) * 1.04, 0, h - 0.03 + 0.09 * math.sin(a)) for a in [i * math.pi / 10 for i in range(1, 10)]] + [(r + 0.004, 0, h - 0.03)],
           0.0015, M_["steel"], segs=6)                                                            # wire bail
    p.to_object(root, smooth_angle=50)
    return root


def anemometer(rng):
    """A Richard hand anemometer: brass ring guarding eight aluminium vanes, the counter dial behind, a turned
    handle."""
    root = K.empty("hand_anemometer")
    p = K.Part("hand_anemometer")
    p.torus((0, 0, 0.32), (0, 1, 0), 0.06, 0.004, M_["brass"], segs=40)
    p.torus((0, -0.03, 0.32), (0, 1, 0), 0.06, 0.003, M_["brass"], segs=40)
    for k in range(8):
        a = 2 * math.pi * k / 8
        R = Matrix.Rotation(a, 3, "Y")
        p.box((0.03 * math.cos(a), -0.015, 0.32 + 0.03 * math.sin(a)), (0.05, 0.002, 0.022), M_["aluminium"], r=0.0005,
              rot=R @ Matrix.Rotation(math.radians(40), 3, "X"))
    p.lathe([(0.0, 0.0), (0.012, 0.0), (0.012, 0.03), (0.0, 0.032)], (0, -0.015, 0.32), (0, 1, 0), M_["brass"], segs=16, caps=(True, True))
    p.lathe([(0.0, 0.0), (0.038, 0.0), (0.038, 0.03), (0.034, 0.034), (0.0, 0.035)], (0, 0.02, 0.32), (0, 1, 0), M_["brass"], segs=32, caps=(True, True))
    p.lathe([(0.0, 0.0), (0.033, 0.0), (0.0, 0.0005)], (0, 0.0565, 0.32), (0, 1, 0), M_["enamel"], segs=32)
    p.lathe([(0.0, 0.0), (0.012, 0.0), (0.014, 0.08), (0.016, 0.2), (0.012, 0.25), (0.0, 0.26)], (0, 0.03, 0.0), (0, 0, 1), M_["mahogany"], segs=16, caps=(True, True))
    p.rod((0, 0.03, 0.25), (0, 0.03, 0.28), 0.006, M_["brass"], segs=10)
    p.to_object(root, smooth_angle=50)
    return root


def camera_tripod(rng):
    """Orville's 5 x 7 in glass-plate view camera on its wooden tripod, set up by the rail for John T. Daniels of the
    Kill Devil Hills Life-Saving Station to press the bulb: a folding bed, black leather bellows, a brass-barrelled
    lens, a ground-glass back; a rubber bulb and tube."""
    root = K.empty("camera_tripod")
    p = K.Part("camera_tripod")
    H = 1.30
    for k in range(3):
        a = math.radians(90 + 120 * k)
        foot = Vector((0.52 * math.cos(a), 0.52 * math.sin(a), 0.0))
        top = Vector((0.06 * math.cos(a), 0.06 * math.sin(a), H - 0.03))
        side = Vector((-math.sin(a), math.cos(a), 0))
        for s in (-1, 1):
            p.beam(top + side * s * 0.022, foot + side * s * 0.008, 0.016, 0.024, M_["ash"], r=0.004)
        p.box(top * 0.5 + foot * 0.5, (0.06, 0.012, 0.03), M_["brass"], r=0.002,
              rot=Matrix.Rotation(a + math.pi / 2, 3, "Z"))
        p.lathe([(0.0, 0.0), (0.008, 0.0), (0.0, -0.03)], foot, (0, 0, 1), M_["brass"], segs=8)
    p.lathe([(0.0, 0.0), (0.085, 0.0), (0.085, 0.03), (0.0, 0.03)], (0, 0, H - 0.03), (0, 0, 1), M_["mahogany"], segs=32, caps=(True, True))
    # camera: bed, back standard with ground glass, bellows, front standard, lens
    z0 = H + 0.01
    p.box((0, 0.02, z0 + 0.01), (0.19, 0.30, 0.02), M_["mahogany"], r=0.003)
    p.box((0, 0.13, z0 + 0.13), (0.2, 0.05, 0.22), M_["mahogany"], r=0.004)
    p.box((0, 0.16, z0 + 0.13), (0.16, 0.012, 0.18), M_["black"], r=0.002)
    rings = []
    for i in range(9):
        t = i / 8
        y = 0.105 - t * 0.17
        w = 0.17 - 0.05 * t + (0.006 if i % 2 else 0)
        rings.append((y, w))
    for (y0, w0), (y1, w1) in zip(rings[:-1], rings[1:]):
        p.box((0, (y0 + y1) / 2, z0 + 0.13), ((w0 + w1) / 2, abs(y1 - y0) + 0.002, (w0 + w1) / 2), M_["bellows"], r=0.003)
    p.box((0, -0.075, z0 + 0.13), (0.16, 0.02, 0.16), M_["mahogany"], r=0.003)
    p.lathe([(0.0, 0.0), (0.035, 0.0), (0.035, 0.012), (0.03, 0.014), (0.03, 0.06), (0.034, 0.062), (0.034, 0.075), (0.0, 0.075)],
            (0, -0.085, z0 + 0.13), (0, -1, 0), M_["brass"], segs=32, caps=(True, True))
    p.lathe([(0.0, 0.0), (0.024, 0.0), (0.0, 0.001)], (0, -0.161, z0 + 0.13), (0, -1, 0), M_["glass"], segs=24)
    p.tube([(0.05, -0.08, z0 + 0.05), (0.15, -0.05, z0 - 0.2), (0.3, 0.1, 0.4), (0.45, 0.25, 0.03)], 0.004, M_["black"], segs=6)
    p.lathe([(0.0, 0.0), (0.02, 0.01), (0.025, 0.04), (0.018, 0.06), (0.0, 0.065)], (0.47, 0.27, 0.0), (0.4, 0.5, 0.1), M_["black"], segs=16, caps=(True, True))
    p.to_object(root, smooth_angle=45)
    return root


def crate(rng):
    """A pine shipping crate (the engine and parts came down from Dayton in crates), boards on cleats, nailed."""
    root = K.empty("crate")
    p, n = K.Part("crate_wood"), K.Part("crate_nails")
    W, m = T_["pine"], M_["pine"]
    Lx, Ly, Lz = 0.95, 0.62, 0.58
    for face, nrm in (("x", 1), ("x", -1), ("y", 1), ("y", -1), ("z", 1)):
        if face == "z":
            k = int(Ly / (5.5 * IN + 0.004))
            for i in range(k):
                y = -Ly / 2 + (i + 0.5) * Ly / k
                board(p, m, W, (0, y, Lz - BOARD_T / 2), X_, Y_, Lx, Ly / k - 0.005, BOARD_T, rng)
                for sx in (-1, 1):
                    nail(n, M_["nail"], (sx * (Lx / 2 - 0.03), y, Lz), (0, 0, 1))
            continue
        if face == "x":
            c0, ld, wd, span = Vector((nrm * (Lx / 2 - BOARD_T / 2), 0, 0)), Y_, Z_, Ly
        else:
            c0, ld, wd, span = Vector((0, nrm * (Ly / 2 - BOARD_T / 2), 0)), X_, Z_, Lx - 2 * BOARD_T
        k = int(Lz / (5.5 * IN + 0.004))
        for i in range(k):
            z = (i + 0.5) * Lz / k
            board(p, m, W, c0 + Z_ * z, ld, wd, span, Lz / k - 0.005, BOARD_T, rng)
        out = c0.normalized()
        for s in (-1, 1):
            board(p, m, W, c0 + out * BOARD_T + ld * s * (span / 2 - 0.05) + Z_ * (Lz / 2), Z_, ld, Lz - 0.04, 2.5 * IN, BOARD_T, rng)
            for i in range(k):
                nail(n, M_["nail"], c0 + out * BOARD_T * 1.5 + ld * s * (span / 2 - 0.05) + Z_ * ((i + 0.5) * Lz / k), out)
    p.to_object(root, smooth_angle=30)
    if n.F:
        n.to_object(root)
    return root


def signal_pole(rng):
    """The camp's signal: a cloth on a pole, put up to call the men of the Kill Devil Hills Life-Saving Station
    (Orville's diary, 17 December 1903). The cloth is its own node, `signal_cloth`, rippled as in a strong wind, so a
    film can sway it; its colour and size are not recorded, so a plain muslin sheet."""
    root = K.empty("signal_pole")
    pole = K.Part("signal_pole_wood")
    H = 4.2
    pole.beam((0, 0, -0.5), (0, 0, H), 2 * IN, 2 * IN, M_["grey"], r=0.004)
    for k in range(3):                                         # guy lines of cotton cord to stakes
        a = math.radians(30 + 120 * k)
        foot = (2.1 * math.cos(a), 2.1 * math.sin(a), 0.0)
        pole.rod((0, 0, H * 0.72), foot, 0.003, M_["rope"], segs=5)
        pole.beam((foot[0], foot[1], -0.25), (foot[0], foot[1], 0.12), 0.04, 0.04, M_["grey"], r=0.004)
    pole.to_object(root, smooth_angle=45)
    cloth = K.Part("signal_cloth")
    cw, ch, ni, nj = 1.2, 0.85, 16, 12
    P, UV = [], []
    for i in range(ni + 1):
        u = i / ni
        row, uvr = [], []
        for j in range(nj + 1):
            v = j / nj
            wave = 0.10 * u * math.sin(6.5 * u - 2.0 + 1.3 * v) + 0.03 * u * math.sin(17 * u + 5 * v)
            droop = 0.18 * u * u * (1 - 0.5 * v)
            row.append((0.04 + u * cw * (1 - 0.06 * u), wave, H - 0.08 - v * ch - droop))
            uvr.append((u, v))
        P.append(row)
        UV.append(uvr)
    cloth.grid(P, UV, M_["cloth"])
    for j in range(0, nj + 1, 3):                              # nails along the pole edge
        nail(cloth, M_["nail"], (0.05, -0.012, H - 0.08 - j / nj * ch), (0, -1, 0))
    cloth.to_object(root, smooth_angle=80)
    return root


def barrel(rng):
    """A 30 gallon oak barrel with iron hoops for the camp's water: 18 staves bulged to the bilge, two heads, six
    hoops, a bung."""
    root = K.empty("barrel")
    staves, iron = K.Part("barrel_staves"), K.Part("barrel_hoops")
    Hb, rh, rb, th, n = 0.74, 0.225, 0.28, 0.02, 18

    def rad(z):
        return rh + (rb - rh) * (1 - (2 * z / Hb - 1) ** 2)

    zs = [Hb * k / 16 for k in range(17)]
    for s in range(n):
        a0, a1 = 2 * math.pi * s / n + 0.003, 2 * math.pi * (s + 1) / n - 0.003
        jit = rng.uniform(-0.002, 0.002)
        band = (s * 7) % 12
        v0, u0 = band * 315.6 / 4096 + 0.006, rng.uniform(0.0, 2.0)
        P, UV = [], []
        for z in zs:
            r = rad(z) + jit
            P.append([(r * math.cos(a0), r * math.sin(a0), z), (r * math.cos(a1), r * math.sin(a1), z),
                      ((r - th) * math.cos(a1), (r - th) * math.sin(a1), z), ((r - th) * math.cos(a0), (r - th) * math.sin(a0), z)])
            UV.append([(u0 + z * 1.2, v0 + k) for k in (0.0, 0.05, 0.055, 0.06, 0.065)])
        staves.grid(P, UV, M_["oak"], closed_u=True)
    for zz in (0.03, 0.17, 0.27, Hb - 0.27, Hb - 0.17, Hb - 0.03):
        r = rad(zz) + 0.002
        iron.lathe([(r, -0.018), (r + 0.004, -0.017), (r + 0.004, 0.017), (r, 0.018)], (0, 0, zz), (0, 0, 1), M_["iron"],
                   segs=48)
    for zz in (0.045, Hb - 0.045):
        rr = rad(zz) - th + 0.002
        staves.lathe([(0.0, 0.0), (rr, 0.0), (rr, 0.025), (0.0, 0.025)], (0, 0, zz - 0.012), (0, 0, 1), M_["oak"], segs=36,
                     caps=(True, True))
    iron.lathe([(0.0, 0.0), (0.022, 0.0), (0.022, 0.012), (0.0, 0.012)], (rad(Hb / 2) - 0.004, 0, Hb / 2), (1, 0, 0),
               M_["black"], segs=16, caps=(True, True))
    staves.to_object(root, smooth_angle=35)
    iron.to_object(root, smooth_angle=60)
    return root


def lifesaving_station(rng):
    """The Kill Devil Hills Life-Saving Station (built 1878-79, an 1876-type station), about a mile north of the camp
    and seen only at a distance in the film: a frame house of a storey and a half on the sand, a steep gable roof, the
    boat room's wide door on the east gable end, a door and windows along the side, a lookout deck with a rail on the
    ridge and a flagpole. Siding, colour and proportions are the type's, not measured from this station."""
    root, _ = building("lifesaving_station", 44 * FT, 20 * FT, 11 * FT, 45, M_["grey"], T_["grey"], M_["tar_old"],
                       rng, end_doors=(1,), chimney=(-3.5, -0.8), tower=(-1.0, 0.25), glow=True,
                       front=({"kind": "door", "at": -5.0, "w": 0.9, "h": 2.05, "bottom": 0.25},
                              {"kind": "window", "at": -2.6, "w": 0.75, "h": 1.2, "bottom": 0.9},
                              {"kind": "window", "at": 0.6, "w": 0.75, "h": 1.2, "bottom": 0.9},
                              {"kind": "window", "at": 3.4, "w": 0.75, "h": 1.2, "bottom": 0.9}))
    return root


# ---------------------------------------------------------------- export
X_, Y_, Z_ = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
M_, T_ = None, None


def export(root, folder, name, previews=()):
    out = os.path.join(ROOT, folder)
    os.makedirs(out, exist_ok=True)
    obs = [root] + list(root.children_recursive)
    glb = os.path.join(out, name + SFX + ".glb")
    K.export_glb(glb, obs)
    summary = K.glb_summary(glb)
    summary["triangles"] = K.tri_count(obs)
    # The .blend of this asset alone: its objects with their meshes, materials and images (paths to the textures).
    bpy.data.libraries.write(os.path.join(out, name + SFX + ".blend"), set(obs), fake_user=True)
    K.log("glb", glb, summary)
    import json
    with open(os.path.join(out, name + SFX + ".summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    here = os.path.dirname(os.path.abspath(__file__))
    for src in (os.path.join(here, "build_camp.py"), os.path.join(here, "LABEL.md"), os.path.join(here, "..", "lib", "kh_common.py")):
        if os.path.exists(src):
            shutil.copy2(src, out)
    if OPT["previews"] and LOD == 0 and previews:
        pv = os.path.join(out, "previews")
        os.makedirs(pv, exist_ok=True)
        hidden = [o for o in bpy.data.objects if o not in obs and o.type == "MESH" and not o.name.startswith("preview")]
        for o in hidden:
            o.hide_render = True
        for fname, eye, tgt, lens in previews:
            K.preview_render(os.path.join(pv, fname), eye, tgt, lens)
        for o in hidden:
            o.hide_render = False
    return glb


def main():
    global M_, T_
    K.reset_scene()
    T_ = prepare_textures()
    M_ = materials(T_)
    if OPT["previews"] and LOD == 0:
        K.preview_setup(sun_dir=(0.5, -0.7, 0.45))
    part = OPT["part"]
    done = []
    if part in ("all", "hangar"):
        r, _ = building("hangar_1903", 44 * FT, 16 * FT, 2.9, 18, M_["pine"], T_["pine"], M_["tar"], random.Random(3),
                        end_doors=(1, -1))
        done.append(export(r, "hangar-1903", "hangar-1903", [
            ("front-three-quarter.png", (14, -14, 3.0), (0, 0, 1.6), 35),
            ("door-close.png", (10.5, -4.5, 1.7), (6.7, 0, 1.8), 35),
            ("wall-close.png", (-2.0, -4.6, 1.5), (-1.0, -2.45, 1.4), 50)]))
    if part in ("all", "shed"):
        r, _ = building("shed_1901", 35 * FT, 16 * FT, 7 * FT, 30, M_["grey"], T_["grey"], M_["tar_old"], random.Random(4),
                        end_doors=(1,), chimney=(-2.6, 0.6), glow=True,
                        front=({"kind": "door", "at": -2.2, "w": 0.84, "h": 1.95, "bottom": 0.12},
                               {"kind": "window", "at": -3.9, "w": 0.62, "h": 0.78, "bottom": 1.0},
                               {"kind": "window", "at": -0.6, "w": 0.62, "h": 0.78, "bottom": 1.0}))
        done.append(export(r, "shed-1901", "shed-1901", [
            ("front-three-quarter.png", (11, -12, 2.6), (0, 0, 1.3), 35),
            ("wall-close.png", (-3.2, -4.0, 1.4), (-3.4, -2.45, 1.3), 50)]))
    if part in ("all", "rail"):
        r = build_rail(random.Random(5))
        done.append(export(r, "launch-rail", "launch-rail", [
            ("along.png", (1.3, -2.2, 0.9), (0, 4, 0.0), 35),
            ("truck-close.png", (0.7, 0.2, 0.45), (0, 0.9, 0.1), 40)]))
    if part in ("all", "props"):
        for i, (fn, folder) in enumerate(((sawhorse, "sawhorse"), (bench, "bench"), (shovel, "shovel"), (tin_can, "tin-can"),
                                          (anemometer, "hand-anemometer"), (camera_tripod, "camera-tripod"), (crate, "crate"),
                                          (signal_pole, "signal-pole"), (barrel, "barrel"))):
            r = fn(random.Random(10 + i))
            done.append(export(r, os.path.join("camp-props", folder), folder, [
                ("view.png", (1.6, -2.0, 1.2), (0, 0, 0.35 if folder not in ("camera-tripod",) else 0.9), 40)]))
            for o in [r] + list(r.children_recursive):
                o.hide_render = True
    if part in ("all", "station"):
        r = lifesaving_station(random.Random(6))
        done.append(export(r, "lifesaving-station", "lifesaving-station", [
            ("front-three-quarter.png", (18, -18, 4.0), (0, 0, 3.0), 35)]))
    K.log("done", done)


if __name__ == "__main__":
    done_file = os.path.join(ROOT, "camp.done")
    try:
        main()
        open(done_file, "w").write("ok")
    except BaseException:
        import traceback
        os.makedirs(ROOT, exist_ok=True)
        open(done_file, "w").write("FAILED\n" + traceback.format_exc())
        raise
