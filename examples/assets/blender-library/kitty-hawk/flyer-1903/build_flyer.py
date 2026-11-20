# The 1903 Wright Flyer as a film asset, built from measurements by script (Blender 5.3, headless):
#   blender -b --factory-startup --python build_flyer.py -- [--lod 0] [--previews 1]
# Writes <library>\kitty-hawk\flyer-1903\: flyer-1903.blend, flyer-1903.glb (or flyer-1903-lod1.glb), textures\,
# previews\. LABEL.md beside this script lists the sources, the licences and what each node is.
#
# Space (Blender): forward is -Y, up +Z, the pilot's right (starboard, the engine side) is -X; the skids' lowest
# point is z = 0 and the wing centre is x = 0, y = 0. In the exported glTF: forward +Z, up +Y, starboard -X.
#
# Built clean room from published measurements and photographs (LABEL.md cites each); no other model, drawing file
# or code was used.

import math
import os
import shutil
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import kh_common as K  # noqa: E402

OPT = K.cli({"lod": 0, "previews": 1, "out": ""})
LOD = OPT["lod"]
OUT = OPT["out"] or os.path.join(K.LIBRARY, "kitty-hawk", "flyer-1903")
TEX = os.path.join(OUT, "textures")
os.makedirs(TEX, exist_ok=True)
FT, IN = K.FT, K.IN

# ---------------------------------------------------------------- measurements (metres)
HALF = (40 * FT + 4 * IN) / 2          # 40 ft 4 in span (NASM A19610048000)
CHORD = 6 * FT + 6 * IN                # 6 ft 6 in chord
GAP = 6 * FT + 2 * IN                  # 6 ft 2 in gap
CAMBER = 1 / 20                        # 1 in 20
DROOP = 10 * IN                        # the 1903 wing's 10 in droop at the tips
Z_LOW = 0.62                           # lower wing chord line above the skid bottom
Z_UP = Z_LOW + GAP
Y_LE, Y_TE = -CHORD / 2, CHORD / 2
Y_FS = Y_LE + 0.024                    # front spar centre (the spar forms the leading edge)
Y_RS = Y_LE + 0.78 * CHORD             # rear spar centre
RIB = HALF / 19                        # 19 rib bays a side, ribs about 13 in apart
STATIONS = [0.95 + k * 0.93 for k in range(6)]   # strut stations out from the centre, each side
PROP_X = 5 * FT                        # shafts about 10 ft apart (NPS Historical Handbook 34)
PROP_R = 8.5 * FT / 2                  # 8 ft 6 in propellers
PROP_Y, PROP_Z = 1.20, 1.56
CHAIN_Y = {"right": 0.60, "left": 0.66}
ENG_X, CRANK_Z = -0.53, 0.86          # crankcase centre line and crank height; the engine is right of centre
PILOT_X = 0.40                         # the pilot lies left of centre to balance the engine
ELEV_Y, ELEV_Z, ELEV_GAP = -3.0, 1.25, 0.72
ELEV_SPAN, ELEV_CHORD = 12 * FT, 2.5 * FT
RUD_Y, RUD_X, RUD_Z0, RUD_H, RUD_CHORD = 2.50, 0.29, 0.66, 1.74, 0.56
WARP = math.tan(math.radians(4.5))     # outer bays' rear edge travel per metre aft of the front spar at warp 1
DETAIL = 1.0 if LOD == 0 else 0.35


def camber_z(u):
    """Height of the Wright rib's camber line at chord share u (0 leading edge), peak at 0.3, metres."""
    u = np.clip(u, 0, 1)
    p = 0.3
    return np.where(u < p, 1 - ((p - u) / p) ** 2, 1 - ((u - p) / (1 - p)) ** 2) * CAMBER * CHORD


def droop_z(x):
    return -DROOP * min(1.0, abs(x) / HALF)


def wing_surface_z(x, y, z0, side=+1):
    """Top (side +1) or bottom (side -1) skin height of a main wing at (x, y), ignoring sag."""
    u = (y - Y_LE) / CHORD
    return z0 + droop_z(x) + float(camber_z(u)) + side * 0.5 * thickness(u)


def thickness(u):
    u = float(np.clip(u, 0, 1))
    t = 0.032 * (1 - u) ** 1.3 + 0.0
    return t * math.sqrt(min(1.0, u / 0.02))


def warp_dz(p):
    """Vertical travel of a point at warp weight 1: the outer bays shear so their rear edge drops on the right
    (starboard, -X) and rises on the left, twisting the truss about the front spar line as the Wrights' cables did."""
    x, y = p[0], p[1]
    ramp = min(1.0, max(0.0, (abs(x) - 0.95) / (HALF - 0.95)))
    ramp = ramp * ramp * (3 - 2 * ramp)
    return math.copysign(1.0, x) * WARP * ramp * max(0.0, y - Y_FS) if abs(x) > 0.95 else 0.0


# ---------------------------------------------------------------- textures
def tex_path(name):
    return os.path.join(TEX, name)


def prepare_textures():
    """Regrades the CC0 scans to the 1903 materials and writes the unique planform maps of each fabric surface."""
    ph = os.path.join(K.DOWNLOADS, "polyhaven")
    acg = os.path.join(K.DOWNLOADS, "ambientcg")
    size = 4096 if LOD == 0 else 1024
    out = {}

    def keep(src, name, regrade=None):
        dst = tex_path(name)
        if os.path.exists(dst):
            return dst
        a = K.load_pixels(src)
        if a.shape[0] != size:
            a = K.resize(a, size, size)
        if regrade:
            a[..., :3] = regrade(a[..., :3])
        K.save_pixels(a, dst, "JPEG", 93)
        return dst

    sfx = "" if LOD == 0 else "-1k"
    # Spruce (the frame) and ash (skids, ribs): Poly Haven veneers, regraded to aged, varnished North American spruce
    # and white ash as the Smithsonian Flyer's wood reads in daylight.
    out["spruce"] = dict(
        color=keep(os.path.join(ph, "white_maple_veneer", "white_maple_veneer_diff_4k.jpg"), f"spruce_color{sfx}.jpg",
                   lambda c: K.regrade(c, (196, 160, 112), keep_contrast=1.6)),
        rough=keep(os.path.join(ph, "white_maple_veneer", "white_maple_veneer_rough_4k.jpg"), f"spruce_rough{sfx}.jpg",
                   lambda c: np.clip(c * 0.85 + 0.05, 0, 1)),
        normal=keep(os.path.join(ph, "white_maple_veneer", "white_maple_veneer_nor_gl_4k.png"), f"spruce_normal{sfx}.jpg"),
        ao=keep(os.path.join(ph, "white_maple_veneer", "white_maple_veneer_ao_4k.jpg"), f"spruce_ao{sfx}.jpg"))
    out["ash"] = dict(
        color=keep(os.path.join(ph, "ash_veneer", "ash_veneer_diff_4k.jpg"), f"ash_color{sfx}.jpg",
                   lambda c: K.regrade(c, (172, 138, 98), keep_contrast=1.3)),
        rough=keep(os.path.join(ph, "ash_veneer", "ash_veneer_rough_4k.jpg"), f"ash_rough{sfx}.jpg"),
        normal=keep(os.path.join(ph, "ash_veneer", "ash_veneer_nor_gl_4k.png"), f"ash_normal{sfx}.jpg"),
        ao=keep(os.path.join(ph, "ash_veneer", "ash_veneer_ao_4k.jpg"), f"ash_ao{sfx}.jpg"))
    # Muslin weave: Poly Haven Terlenka's normal and roughness (a fine plain weave), tiled on the bias.
    out["weave"] = dict(
        rough=keep(os.path.join(ph, "terlenka", "terlenka_rough_4k.jpg"), f"weave_rough{sfx}.jpg",
                   lambda c: np.clip(0.55 + (c - c.mean()) * 0.8 + 0.3, 0, 1)),
        normal=keep(os.path.join(ph, "terlenka", "terlenka_nor_gl_4k.png"), f"weave_normal{sfx}.jpg"))
    # Cast aluminium crankcase and jackets, cast iron, steel: ambientCG scans.
    out["aluminium"] = dict(
        color=keep(os.path.join(acg, "Metal050C", "Metal050C_4K-JPG_Color.jpg"), f"aluminium_color{sfx}.jpg",
                   lambda c: K.regrade(c, (176, 172, 164), keep_contrast=1.4)),
        rough=keep(os.path.join(acg, "Metal050C", "Metal050C_4K-JPG_Roughness.jpg"), f"aluminium_rough{sfx}.jpg",
                   lambda c: np.clip(c * 0.7 + 0.25, 0, 1)),
        normal=keep(os.path.join(acg, "Metal050C", "Metal050C_4K-JPG_NormalGL.jpg"), f"aluminium_normal{sfx}.jpg"),
        metal=keep(os.path.join(acg, "Metal050C", "Metal050C_4K-JPG_Metalness.jpg"), f"aluminium_metal{sfx}.jpg"))
    out["iron"] = dict(
        color=keep(os.path.join(acg, "Metal052C", "Metal052C_4K-JPG_Color.jpg"), f"iron_color{sfx}.jpg",
                   lambda c: K.regrade(c, (70, 68, 66), keep_contrast=1.2)),
        rough=keep(os.path.join(acg, "Metal052C", "Metal052C_4K-JPG_Roughness.jpg"), f"iron_rough{sfx}.jpg"),
        normal=keep(os.path.join(acg, "Metal052C", "Metal052C_4K-JPG_NormalGL.jpg"), f"iron_normal{sfx}.jpg"),
        metal=keep(os.path.join(acg, "Metal052C", "Metal052C_4K-JPG_Metalness.jpg"), f"iron_metal{sfx}.jpg"))
    out["steel"] = dict(
        normal=keep(os.path.join(acg, "Metal038", "Metal038_4K-JPG_NormalGL.jpg"), f"steel_normal{sfx}.jpg"),
        rough=keep(os.path.join(acg, "Metal038", "Metal038_4K-JPG_Roughness.jpg"), f"steel_rough{sfx}.jpg",
                   lambda c: np.clip(c * 0.8 + 0.2, 0, 1)))
    return out


def fabric_maps(name, x0, x1, y0, y1, ribs, spars, seam_angle, engine_box=None, width=8192, height=4096, seed=1):
    """The unique planform maps of one fabric surface pair (top half of the image: top skin; bottom half: bottom
    skin), in Blender's bottom-up pixel order. Base colour: unbleached muslin with weathering, sewn rib pockets and
    bias seams. Transmission (RGBA, A = share transmitted): low over spars, ribs and seams."""
    if LOD:
        width, height = width // 4, height // 4
    col_path = tex_path(f"{name}_color{'' if LOD == 0 else '-lod1'}.jpg")
    dt_path = tex_path(f"{name}_transmission{'' if LOD == 0 else '-lod1'}.png")
    if os.path.exists(col_path) and os.path.exists(dt_path):
        return col_path, dt_path
    n = K.Noise(seed)
    hh = height // 2
    xs = x0 + (np.arange(width) + 0.5) / width * (x1 - x0)
    # Row r of a half maps to chord share (1 - v): the leading edge is the top row of each half.
    vs = (np.arange(hh) + 0.5) / hh
    X, V = np.meshgrid(xs.astype(np.float32), vs.astype(np.float32))
    Y = y0 + (1 - V) * (y1 - y0)
    halves_c, halves_t = [], []
    base = K.srgb_to_lin(np.array([214, 198, 166], np.float32) / 255.0)  # Pride of the West, unbleached
    for side in (0, 1):  # 0 = bottom skin (lower half), 1 = top skin
        f1 = n.fbm(X * 1.7 + side * 31, Y * 1.7, 5)
        f2 = n.fbm(X * 9.0 - side * 7, Y * 9.0, 4)
        tone = 0.93 + 0.12 * (f1 - 0.5) + 0.05 * (f2 - 0.5)
        col = base[None, None, :] * tone[..., None]
        # yellowing and grey weathering in broad drifts; the leading edge and tips carry more grime
        drift = K.smoothstep(0.45, 0.85, n.fbm(X * 0.6 + 5, Y * 0.9, 4))
        col = col * (1 - 0.10 * drift[..., None]) + np.array([0.020, 0.016, 0.008]) * drift[..., None]
        u = (Y - y0) / (y1 - y0)
        le = np.exp(-u / 0.035) * (0.55 if side else 0.35)
        col = col * (1 - 0.22 * le[..., None])
        tip = K.smoothstep(abs(x1) - 0.9, abs(x1), np.abs(X)) * 0.12
        col = col * (1 - tip[..., None])
        if side == 0:  # sand and spray on the underside: speckle and a low haze
            sp = (n.value(X * 160, Y * 160) > 0.86) * (n.fbm(X * 3, Y * 3, 3) > 0.5) * 0.18
            col = col * (1 - sp[..., None]) + np.array([0.30, 0.25, 0.18]) * sp[..., None]
        # sewn rib pockets: two lines of stitching 7 mm either side of each rib, and the pocket's faint shadow
        trans = np.full(X.shape, 0.42, np.float32)
        for rx in ribs:
            d = np.abs(X - rx)
            stitch = np.exp(-((d - 0.007) / 0.0012) ** 2)
            col = col * (1 - 0.18 * stitch[..., None])
            pocket = np.exp(-(d / 0.012) ** 2)
            col = col * (1 - 0.10 * pocket[..., None])
            trans = trans * (1 - 0.88 * np.exp(-(d / 0.007) ** 2))
        # spars block the light where the fabric wraps them
        for sy, w in spars:
            d = np.abs(Y - sy)
            trans = trans * (1 - 0.95 * K.smoothstep(w * 1.1, w * 0.6, d))
        # bias seams of the 36 in cloth, double thickness: darker line, less light through
        a = math.radians(seam_angle)
        s = (X * math.cos(a) + Y * math.sin(a)) / (36 * IN)
        frac = s - np.floor(s)
        seam = np.exp(-((frac - 0.5) * 36 * IN / 0.009) ** 2)
        col = col * (1 - 0.07 * seam[..., None])
        trans = trans * (1 - 0.45 * seam)
        if engine_box is not None:  # oil spray and soot by the engine, more on the top skin of the lower wing
            ex0, ex1, ey0, ey1 = engine_box
            near = K.smoothstep(0.6, 0.0, np.maximum(np.maximum(ex0 - X, X - ex1), np.maximum(ey0 - Y, Y - ey1)).clip(0))
            near = near * near
            dots = (n.value(X * 140 + 3, Y * 140) > 0.93) * near * (0.35 if side else 0.12)
            col = col * (1 - (0.25 * near * (1 if side else 0.4))[..., None]) * (1 - dots[..., None] * 0.5)
        trans = trans * (0.9 + 0.2 * (f2 - 0.5))
        halves_c.append(col)
        tcol = np.stack([np.full(X.shape, 1.0), np.full(X.shape, 0.86), np.full(X.shape, 0.62), trans], axis=-1)
        halves_t.append(tcol)
    colour = K.lin_to_srgb(np.concatenate(halves_c, axis=0))
    t = np.concatenate(halves_t, axis=0).astype(np.float32)
    K.save_pixels(colour.astype(np.float32), col_path, "JPEG", 93)
    tw, th = max(256, width // 2), max(128, height // 2)
    K.save_pixels(K.resize(t, tw, th), dt_path, "PNG")
    return col_path, dt_path


# ---------------------------------------------------------------- materials
def build_materials(T, maps):
    M = {}
    for key, tile in (("spruce", None), ("ash", None)):
        M[key] = K.material(key, tex=T[key], rough=0.6)
    M["prop"] = K.material("propeller spruce", tex=dict(T["spruce"]), rough=0.45)
    M["prop_tip"] = K.material("propeller tip muslin", color=(0.66, 0.62, 0.53, 1), rough=0.62,
                               tex=dict(normal=T["weave"]["normal"]), normal_strength=0.6)
    for surf, (col, dt) in maps.items():
        M[surf] = K.material(f"muslin {surf}", double=True, rough=0.85, sheen=(0.55, 0.50, 0.42, 0.45),
                             tex=dict(color=col, color_uv="UV1", rough=T["weave"]["rough"], normal=T["weave"]["normal"]),
                             normal_strength=0.55)
    M["aluminium"] = K.material("cast aluminium", metal=1.0, tex=T["aluminium"])
    M["iron"] = K.material("cast iron", metal=1.0, tex=T["iron"])
    # brass: a measured brass reflectance (linear F0 about 0.91, 0.78, 0.42) worn to a soft polish; the scanned brass
    # texture read as lumps at fitting size, so only the steel scan's fine normal is kept
    M["brass"] = K.material("brass", color=(0.80, 0.64, 0.34, 1), metal=1.0, rough=0.34,
                            tex=dict(normal=T["steel"]["normal"]), normal_strength=0.4)
    M["steel"] = K.material("steel wire", color=(0.50, 0.50, 0.50, 1), metal=1.0, rough=0.38)
    M["tube"] = K.material("steel tube", color=(0.33, 0.33, 0.32, 1), metal=1.0, tex=dict(T["steel"]))
    M["tin"] = K.material("tinned sheet steel", color=(0.62, 0.62, 0.60, 1), metal=1.0, tex=dict(T["steel"]))
    M["chain"] = K.material("oiled chain", color=(0.16, 0.15, 0.14, 1), metal=1.0, rough=0.3)
    M["rubber"] = K.material("rubber hose", color=(0.035, 0.03, 0.028, 1), rough=0.7)
    M["enamel"] = K.material("dial enamel", color=(0.86, 0.84, 0.78, 1), rough=0.25)
    M["black"] = K.material("black paint", color=(0.03, 0.03, 0.03, 1), rough=0.4)
    M["leather"] = K.material("leather pad", color=(0.20, 0.11, 0.06, 1), rough=0.55)
    return M


# ---------------------------------------------------------------- fabric surfaces
def surface(part, mat, half, chord, z0, y_le, r_front, r_back, camber, droop, depth, ribs, uv1_rect, seed,
            per_bay=10, around=64, sag=(0.006, 0.004), scallop=0.018, x_of=None, vertical=False, mirror_uv=False):
    """A double-covered Wright surface: both skins and the nose as one sheet. Rounded plan corners, camber, droop,
    rib-to-rib sag and the scalloped trailing edge between rib tips. vertical: build in the YZ plane (rudders)."""
    y_te = y_le + chord
    per_bay = max(3, int(per_bay * DETAIL))
    around = max(12, int(around * DETAIL))
    # stations: per_bay samples between ribs, more near the tips
    xs = []
    xs_ribs = sorted(set([-half] + [r for r in ribs if -half < r < half] + [half]))
    for a, b in zip(xs_ribs[:-1], xs_ribs[1:]):
        for k in range(per_bay):
            xs.append(a + (b - a) * k / per_bay)
    xs.append(half)
    # extra stations in the last 6 cm so the skins close smoothly at the tip
    xs = sorted(set(xs + [s * (half - d) for s in (-1, 1) for d in (0.004, 0.012, 0.025, 0.045)]))
    ribs_arr = np.array(sorted(ribs))

    def plan(x):
        ax = abs(x)
        le = y_le
        te = y_te
        if ax > half - r_front:
            d = ax - (half - r_front)
            le = y_le + (r_front - math.sqrt(max(0.0, r_front ** 2 - d * d)))
        if ax > half - r_back:
            d = ax - (half - r_back)
            te = y_te - (r_back - math.sqrt(max(0.0, r_back ** 2 - d * d)))
        return le, te

    def bay(x):
        if len(ribs_arr) == 0:
            return 0.0
        i = np.searchsorted(ribs_arr, x)
        a = ribs_arr[i - 1] if i > 0 else -half
        b = ribs_arr[i] if i < len(ribs_arr) else half
        if b - a < 1e-6:
            return 0.0
        return math.sin(math.pi * (x - a) / (b - a)) ** 2

    P, UV, UV1 = [], [], []
    qs = [(1 - math.cos(math.pi * k / around)) / 2 for k in range(around + 1)]
    loop = [(1.0 - q, -1) for q in qs] + [(q, +1) for q in qs[1:]]  # TE bottom -> LE -> TE top
    ux0, ux1, uy0, uy1 = uv1_rect
    for x in xs:
        le, te = plan(x)
        s = bay(x)
        tipf = min(1.0, (half - abs(x)) / 0.045) if half - abs(x) < 0.045 else 1.0
        tipf = math.sqrt(max(tipf, 0.0))
        dz = -droop * min(1.0, abs(x) / half)
        row, uvr, uv1r = [], [], []
        for (u, side) in loop:
            te_s = te - scallop * s
            y = le + u * (te_s - le)
            uf = (y - y_le) / chord
            cz = float(camber_z_generic(uf, camber, chord))
            t = depth * (1 - uf) ** 1.3 * math.sqrt(min(1.0, uf / 0.02)) * tipf
            env = math.sin(math.pi * min(1.0, max(0.0, uf))) ** 0.6
            sg = (sag[0] if side > 0 else sag[1]) * s * env * tipf
            z = z0 + dz + cz + side * 0.5 * t - sg
            z += 0.0011 * noise.noise(Vector((x * 2.7 + seed, y * 2.7, side * 3.1))) * tipf
            p = (x, y, z) if not vertical else (z, y, x)
            row.append(p)
            bx, by = (x, y)
            uvr.append(((bx + by) * 0.7071 / 0.31 + (0.37 if side < 0 else 0.0), (bx - by) * 0.7071 / 0.31))
            vv = (1 - (y - y_le) / chord)
            uv1r.append(((x + half) / (2 * half) * (ux1 - ux0) + ux0,
                         (0.5 + 0.5 * vv if side > 0 else 0.5 * vv) * (uy1 - uy0) + uy0))
        P.append(row)
        UV.append(uvr)
        UV1.append(uv1r)
    part.grid(P, UV, mat, UV1=UV1, flip=vertical)


def camber_z_generic(u, camber, chord):
    u = min(1.0, max(0.0, u))
    p = 0.3
    v = 1 - ((p - u) / p) ** 2 if u < p else 1 - ((u - p) / (1 - p)) ** 2
    return v * camber * chord


# ---------------------------------------------------------------- the build
def build():
    K.reset_scene()
    T = prepare_textures()
    wing_ribs = [k * RIB for k in range(-18, 19)]
    elev_ribs = [k * 0.305 for k in range(-5, 6)]
    rud_ribs = [RUD_Z0 + 0.06 + k * 0.33 for k in range(6)]
    maps = {
        "upper wing": fabric_maps("muslin_upper", -HALF, HALF, Y_LE, Y_TE, wing_ribs, [(Y_FS, 0.022), (Y_RS, 0.018)], 45, seed=3),
        "lower wing": fabric_maps("muslin_lower", -HALF, HALF, Y_LE, Y_TE, wing_ribs, [(Y_FS, 0.022), (Y_RS, 0.018)], 45,
                                  engine_box=(-0.75, -0.05, -0.45, 0.70), seed=5),
        "elevator": fabric_maps("muslin_elevator", -ELEV_SPAN / 2, ELEV_SPAN / 2, -ELEV_CHORD / 2, ELEV_CHORD / 2, elev_ribs,
                                [(-ELEV_CHORD / 2 + 0.02, 0.016), (0.0, 0.014)], 45, width=4096, height=2048, seed=7),
        "rudder": fabric_maps("muslin_rudder", 0.0, RUD_H, 0.0, RUD_CHORD, [r - RUD_Z0 for r in rud_ribs],
                              [(0.02, 0.014)], 45, width=2048, height=2048, seed=9),
    }
    M = build_materials(T, maps)

    root = K.empty("flyer_1903")
    wood = K.Part("airframe_wood")
    wires = K.Part("airframe_wires")
    fit = K.Part("airframe_fittings")
    eng = K.Part("engine")
    rad = K.Part("radiator_and_tank")
    guides = K.Part("chain_guides")
    inst = K.Part("instruments")
    rnd = np.random.RandomState(1903)

    def wseed():
        return float(rnd.rand() * 10)

    # ------------------------------------------------ main wings
    up = K.Part("wing_upper")
    lo = K.Part("wing_lower")
    surface(up, M["upper wing"], HALF, CHORD, Z_UP, Y_LE, 0.45, 0.75, CAMBER, DROOP, 0.032, wing_ribs, (0, 1, 0, 1), 1.0)
    surface(lo, M["lower wing"], HALF, CHORD, Z_LOW, Y_LE, 0.45, 0.75, CAMBER, DROOP, 0.032, wing_ribs, (0, 1, 0, 1), 2.0)
    # trailing edge wire through the rib tips, and the rib-tip ties
    for z0 in (Z_LOW, Z_UP):
        pts = []
        for x in np.linspace(-HALF + 0.75, HALF - 0.75, int(240 * DETAIL) + 2):
            i = np.argmin(np.abs(np.array(wing_ribs) - x))
            s = math.sin(math.pi * (x - wing_ribs[i]) / RIB) ** 2 if abs(x - wing_ribs[i]) < RIB else 0
            pts.append((x, Y_TE - 0.018 * s - 0.001, z0 + droop_z(x) + 0.0006))
        wires.tube(pts, 0.0011, M["steel"], segs=6)

    # ------------------------------------------------ uprights (struts) with their hook-and-eye fittings
    strut_tops, strut_bots = {}, {}
    xs_all = [s * x for x in STATIONS for s in (1, -1)]
    for x in xs_all:
        for which, y in (("f", Y_FS), ("r", Y_RS)):
            zb = wing_surface_z(x, y, Z_LOW, +1)
            zt = wing_surface_z(x, y, Z_UP, -1)
            a = (x, y, zb + 0.004)
            b = (x, y, zt - 0.004)
            # spruce upright, 1 in by 1 1/4 in, edges well rounded; slightly fatter at mid-length for buckling
            wood.beam(a, b, 0.024, 0.031, M["spruce"], r=0.009, seed=wseed(), ref=(1, 0, 0))
            # wire wrapping at mid height (the Wrights bound the uprights so they could flex without splitting)
            zm = (a[2] + b[2]) / 2
            for k in range(int(10 * DETAIL)):
                fit.torus((x, y, zm - 0.03 + k * 0.006), (0, 0, 1), 0.0175, 0.0007, M["steel"], segs=14, rsegs=4)
            for (pt, s) in ((a, -1), (b, +1)):
                # strap plate on the spar, the eye and the hook through it
                fit.box((x, y, pt[2] - s * 0.002), (0.034, 0.05, 0.0018), M["tube"], r=0.0008)
                fit.torus((x, y, pt[2] + s * 0.016), (0, 1, 0), 0.006, 0.0012, M["steel"], segs=12, rsegs=6)
                for bx in (-0.012, 0.012):
                    fit.lathe([(0.0028, 0), (0.0028, 0.0015), (0.0015, 0.0022), (0.0, 0.0024)],
                              (x + bx, y + 0.016, pt[2] - s * 0.003), (0, 0, s), M["steel"], segs=8, caps=(True, False))
            strut_bots[(x, which)] = (x, y, a[2] + 0.016)
            strut_tops[(x, which)] = (x, y, b[2] - 0.016)
    # central forward upright that carries the radiator
    zb = wing_surface_z(-0.02, Y_FS, Z_LOW, +1)
    zt = wing_surface_z(-0.02, Y_FS, Z_UP, -1)
    wood.beam((-0.02, Y_FS, zb), (-0.02, Y_FS, zt), 0.024, 0.031, M["spruce"], r=0.009, seed=wseed())

    # ------------------------------------------------ truss wires: an X in every bay of the front and rear trusses
    xs_sorted = sorted(xs_all)
    for which in ("f", "r"):
        for xa, xb in zip(xs_sorted[:-1], xs_sorted[1:]):
            for p, q in ((strut_tops[(xa, which)], strut_bots[(xb, which)]), (strut_bots[(xa, which)], strut_tops[(xb, which)])):
                wires.rod(p, q, 0.0009, M["steel"], segs=6)
        # outer bay to the tip
    # tip wires from the outer struts to the tip bows
    for s in (1, -1):
        for which, y in (("f", Y_FS + 0.25), ("r", Y_RS - 0.1)):
            xo = s * STATIONS[-1]
            xt = s * (HALF - 0.12)
            wires.rod(strut_tops[(xo, "f" if which == "f" else "r")], (xt, y, wing_surface_z(xt, y, Z_LOW, +1)), 0.0009, M["steel"], segs=6)

    # ------------------------------------------------ skids, their uprights and the elevator outriggers
    for sx in (0.38, -0.38):
        path = [(sx, Y_RS + 0.25, 0.06), (sx, Y_LE + 0.2, 0.035), (sx, -1.9, 0.04), (sx, -2.45, 0.12), (sx, -2.85, 0.32),
                (sx, -3.05, 0.55)]
        # ash runner 1 1/4 in by 2 1/2 in, steamed into its upturn
        sm = []
        for i in range(len(path) - 1):
            for k in range(8):
                t = k / 8
                a, b = Vector(path[i]), Vector(path[i + 1])
                sm.append(a.lerp(b, t))
        sm.append(Vector(path[-1]))
        # smooth the polyline (Chaikin) so the bend is a curve
        for _ in range(3):
            nsm = [sm[0]]
            for a, b in zip(sm[:-1], sm[1:]):
                nsm += [a.lerp(b, 0.25), a.lerp(b, 0.75)]
            nsm.append(sm[-1])
            sm = nsm
        wood.sweep(K.rounded_rect(0.032, 0.062, 0.008), [(p.x, p.y, p.z + 0.031) for p in sm], M["ash"], seed=wseed(), ref=(1, 0, 0))
        # skid uprights to both spars of the lower wing, and a diagonal brace
        for y in (Y_FS, Y_RS):
            wood.beam((sx, y, 0.09), (sx, y, wing_surface_z(sx, y, Z_LOW, -1) - 0.003), 0.03, 0.03, M["spruce"], seed=wseed())
        wood.beam((sx, Y_FS + 0.05, 0.10), (sx, Y_RS - 0.08, wing_surface_z(sx, Y_RS, Z_LOW, -1) - 0.01), 0.022, 0.022, M["spruce"], seed=wseed())
        # elevator outriggers: from the upper and lower front spars and from the skid nose to the elevator pivot
        piv = (sx * 1.04, ELEV_Y, ELEV_Z)
        wood.beam((sx, Y_FS, wing_surface_z(sx, Y_FS, Z_UP, -1) - 0.01), piv, 0.028, 0.028, M["spruce"], seed=wseed())
        wood.beam((sx, Y_FS, wing_surface_z(sx, Y_FS, Z_LOW, +1) + 0.01), piv, 0.028, 0.028, M["spruce"], seed=wseed())
        wood.beam((sx, -3.02, 0.55), piv, 0.028, 0.028, M["spruce"], seed=wseed())
        fit.lathe([(0.0, -0.025), (0.016, -0.025), (0.016, 0.025), (0.0, 0.025)], piv, (1, 0, 0), M["tube"], segs=16)
        wires.rod((sx, Y_FS, wing_surface_z(sx, Y_FS, Z_UP, -1) - 0.01), (sx, -3.02, 0.56), 0.0009, M["steel"])
        wires.rod((sx, Y_FS, wing_surface_z(sx, Y_FS, Z_LOW, +1) + 0.01), (sx, -2.2, 0.08), 0.0009, M["steel"])
    # cross pieces between the skids
    for y in (Y_FS - 0.05, -2.2):
        wood.beam((0.40, y, 0.10 if y > -2 else 0.12), (-0.40, y, 0.10 if y > -2 else 0.12), 0.025, 0.04, M["spruce"], seed=wseed())

    # ------------------------------------------------ rudder outriggers
    for sx in (0.95, -0.95):
        for z0 in (Z_LOW, Z_UP):
            za = wing_surface_z(sx, Y_RS, z0, -1 if z0 == Z_UP else +1)
            zb = RUD_Z0 if z0 == Z_LOW else RUD_Z0 + RUD_H
            wood.beam((sx, Y_RS, za), (math.copysign(RUD_X + 0.05, sx), RUD_Y - 0.03, zb), 0.026, 0.026, M["spruce"], seed=wseed())
        wires.rod((sx, Y_RS, wing_surface_z(sx, Y_RS, Z_UP, -1)), (math.copysign(RUD_X + 0.05, sx), RUD_Y - 0.03, RUD_Z0), 0.0009, M["steel"])
    for z in (RUD_Z0, RUD_Z0 + RUD_H):
        wood.beam((RUD_X + 0.06, RUD_Y - 0.03, z), (-RUD_X - 0.06, RUD_Y - 0.03, z), 0.026, 0.026, M["spruce"], seed=wseed())
        for sx in (RUD_X, -RUD_X):
            fit.lathe([(0.0, -0.02), (0.012, -0.02), (0.012, 0.02), (0.0, 0.02)], (sx, RUD_Y, z), (0, 0, 1), M["tube"], segs=12)

    # ------------------------------------------------ propeller supports and shafts' bearings
    for side, sx in (("right", -PROP_X), ("left", PROP_X)):
        bearing_a = (sx, CHAIN_Y[side] + 0.03, PROP_Z)
        bearing_b = (sx, PROP_Y - 0.12, PROP_Z)
        for z0, sgn in ((Z_LOW, +1), (Z_UP, -1)):
            wood.beam((sx, Y_RS, wing_surface_z(sx, Y_RS, z0, sgn)), bearing_b, 0.026, 0.026, M["spruce"], seed=wseed())
            wood.beam((sx, Y_RS, wing_surface_z(sx, Y_RS, z0, sgn)), bearing_a, 0.024, 0.024, M["spruce"], seed=wseed())
        for p in (bearing_a, bearing_b):
            fit.lathe([(0.0, -0.035), (0.026, -0.035), (0.03, -0.02), (0.03, 0.02), (0.026, 0.035), (0.0, 0.035)], p, (0, 1, 0), M["iron"], segs=18)
            fit.box((p[0], p[1], p[2] - 0.035), (0.09, 0.05, 0.012), M["iron"], r=0.003)

    # ------------------------------------------------ engine bed, engine, radiator, tank, chain guides
    for bx in (ENG_X - 0.08, ENG_X + 0.08):
        y0, y1 = Y_FS + 0.02, Y_RS + 0.02
        wood.beam((bx, y0, wing_surface_z(bx, y0, Z_LOW, 1) + 0.025), (bx, y1, wing_surface_z(bx, y1, Z_LOW, 1) + 0.025),
                  0.035, 0.05, M["ash"], seed=wseed(), ref=(1, 0, 0))
    build_engine(eng, M)
    build_radiator_tank(rad, M)
    build_chain_guides(guides, M)
    build_instruments(inst, M)
    # pilot's elevator lever (left hand) and foot rest; the hip cradle's slide rails
    lx = PILOT_X + 0.32
    wood.beam((lx, -0.55, wing_surface_z(lx, -0.55, Z_LOW, 1)), (lx, -0.62, 1.10), 0.022, 0.03, M["ash"], seed=wseed())
    fit.lathe([(0.0, 0.0), (0.016, 0.0), (0.016, 0.09), (0.0, 0.1)], (lx, -0.62, 1.08), (0, 0, 1), M["leather"], segs=12)
    wires.rod((lx, -0.60, 1.0), (0.40, ELEV_Y + 0.25, ELEV_Z), 0.0012, M["steel"])
    for ry in (0.05, 0.30):
        zr = wing_surface_z(PILOT_X, ry, Z_LOW, 1) + 0.012
        wood.beam((PILOT_X - 0.30, ry, zr), (PILOT_X + 0.30, ry, zr), 0.02, 0.022, M["ash"], seed=wseed(), ref=(0, 1, 0))
    wood.beam((PILOT_X - 0.18, 0.78, wing_surface_z(PILOT_X, 0.78, Z_LOW, 1) + 0.03),
              (PILOT_X + 0.18, 0.78, wing_surface_z(PILOT_X, 0.78, Z_LOW, 1) + 0.03), 0.03, 0.03, M["spruce"], seed=wseed())

    # warp cables from the cradle out along the rear truss, over pulleys
    for s in (1, -1):
        xp = s * 0.95
        pul = (xp, Y_RS + 0.06, wing_surface_z(xp, Y_RS, Z_LOW, 1) + 0.04)
        fit.lathe([(0.0, -0.006), (0.022, -0.006), (0.016, 0.0), (0.022, 0.006), (0.0, 0.006)], pul, (0, 1, 0), M["brass"], segs=20)
        wires.rod((PILOT_X + s * 0.24, 0.18, wing_surface_z(PILOT_X, 0.18, Z_LOW, 1) + 0.05), pul, 0.0011, M["steel"])
        wires.rod(pul, strut_tops[(s * STATIONS[-1], "r")], 0.0011, M["steel"])
        wires.rod(pul, (math.copysign(RUD_X, s), RUD_Y, RUD_Z0 + 0.4), 0.0011, M["steel"])

    # ------------------------------------------------ objects and moving parts
    obs = {}
    for p in (up, lo, wood, wires, fit):
        obs[p.name] = p.to_object(parent=root, uv1=p.name.startswith("wing"))
    for p in (eng, rad, guides, inst):
        obs[p.name] = p.to_object(parent=root)
    for nm in ("wing_upper", "wing_lower", "airframe_wood", "airframe_wires", "airframe_fittings"):
        add_warp_key(obs[nm])

    crank = K.empty("engine_crank", (ENG_X, 0, CRANK_Z), parent=root)
    fw = K.Part("flywheel_and_sprockets")
    build_flywheel(fw, M)
    o = fw.to_object(parent=crank)
    o.location = (-ENG_X, 0, -CRANK_Z)

    cradle = K.empty("hip_cradle", (PILOT_X, 0.18, wing_surface_z(PILOT_X, 0.18, Z_LOW, 1)), parent=root)
    cr = K.Part("cradle")
    build_cradle(cr, M)
    o = cr.to_object(parent=cradle)
    o.location = (-cradle.location.x, -cradle.location.y, -cradle.location.z)

    elev = K.empty("elevator", (0, ELEV_Y, ELEV_Z), parent=root)
    ef, ew, ewi = K.Part("elevator_fabric"), K.Part("elevator_frame"), K.Part("elevator_wires")
    build_elevator(ef, ew, ewi, M, elev_ribs, wseed)
    for p in (ef, ew, ewi):
        o = p.to_object(parent=elev, uv1=p is ef)
        o.location = (0, -ELEV_Y, -ELEV_Z)

    rud = K.empty("rudder", (0, RUD_Y, RUD_Z0 + RUD_H / 2), parent=root)
    rf, rw, rwi = K.Part("rudder_fabric"), K.Part("rudder_frame"), K.Part("rudder_wires")
    build_rudder(rf, rw, rwi, M, rud_ribs, wseed)
    for p in (rf, rw, rwi):
        o = p.to_object(parent=rud, uv1=p is rf)
        o.location = (0, -RUD_Y, -(RUD_Z0 + RUD_H / 2))

    for side, sx, spin in (("right", -PROP_X, +1), ("left", PROP_X, -1)):
        hub = K.empty(f"propeller_{side}", (sx, PROP_Y, PROP_Z), parent=root)
        hub["spin"] = spin
        pp = K.Part(f"propeller_{side}_blades")
        build_propeller(pp, M, spin, sx, side)
        o = pp.to_object(parent=hub)
        o.location = (-sx, -PROP_Y, -PROP_Z)

    mark = K.empty("pilot_hips", (PILOT_X, 0.20, wing_surface_z(PILOT_X, 0.2, Z_LOW, 1) + 0.11), parent=root)
    mark["about"] = "Prone pilot's hips; head toward -Y (forward)."
    root["about"] = ("1903 Wright Flyer. Moving nodes: propeller_right and propeller_left turn about their local glTF Z "
                     "(the propeller shafts, spin +1 / -1 at 351 rpm with the engine at 1,020 rpm through 8:23 sprockets); "
                     "elevator turns about its local X; rudder about its local Y (glTF); hip_cradle slides along X "
                     "(+-0.10 m); engine_crank turns about local glTF Z; morph target 'warp' on the wing and truss "
                     "meshes twists the outer bays (weight -1..1, +1 drops the starboard trailing edge).")
    return root, M, maps


def add_warp_key(ob):
    me = ob.data
    ob.shape_key_add(name="Basis", from_mix=False)
    k = ob.shape_key_add(name="warp", from_mix=False)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    x, y = co[:, 0], co[:, 1]
    ramp = np.clip((np.abs(x) - 0.95) / (HALF - 0.95), 0, 1)
    ramp = ramp * ramp * (3 - 2 * ramp)
    dz = np.sign(x) * WARP * ramp * np.maximum(0, y - Y_FS)
    co2 = co.copy()
    co2[:, 2] += dz
    k.data.foreach_set("co", co2.ravel())
    k.slider_min = -1.0
    k.value = 0.0


# ---------------------------------------------------------------- engine (Hobbs 1971; NPS Historical Handbook 34)
def build_engine(p, M):
    al, fe, br, st = M["aluminium"], M["iron"], M["brass"], M["steel"]
    cx, cz = ENG_X, CRANK_Z
    # crankcase: one aluminium casting, 0.62 m long, with a sump and stiffening ribs on the outboard face
    p.box((cx, 0.02, cz), (0.19, 0.64, 0.23), al, r=0.03)
    p.box((cx, 0.02, cz - 0.15), (0.15, 0.52, 0.09), al, r=0.025)
    for k in range(6):
        y = -0.24 + k * 0.105
        p.box((cx - 0.10, y, cz - 0.01), (0.014, 0.012, 0.21), al, r=0.004)
    for k in range(4):  # mounting feet bolted to the ash bearers
        fx = cx + (-0.08 if k % 2 else 0.08)
        fy = -0.22 + (k // 2) * 0.48
        p.box((fx, fy, cz - 0.17), (0.07, 0.06, 0.016), al, r=0.004)
        p.lathe([(0.0055, 0), (0.0055, 0.006), (0.0, 0.007)], (fx, fy, cz - 0.162), (0, 0, 1), fe, segs=6, caps=(True, False))
    for y in (-0.31, 0.35):  # main bearing bosses
        p.lathe([(0.0, -0.035), (0.052, -0.035), (0.058, -0.02), (0.058, 0.02), (0.052, 0.035), (0.0, 0.035)], (cx, y, cz), (0, 1, 0), al, segs=28)
    # timing gear case at the front (valve and spark timing)
    p.lathe([(0.0, -0.02), (0.07, -0.02), (0.075, 0.0), (0.07, 0.025), (0.0, 0.03)], (cx + 0.05, -0.36, cz - 0.03), (0, 1, 0), al, segs=32)
    # four cylinders lying flat, pointing at the pilot (+X): aluminium water jackets, iron firing chambers
    cyl_y = [-0.20, -0.075, 0.05, 0.175]
    for i, y in enumerate(cyl_y):
        base = cx + 0.095
        prof = [(0.0, 0.0), (0.072, 0.0), (0.072, 0.012), (0.064, 0.02)]
        for k in range(5):
            prof += [(0.064, 0.03 + k * 0.042), (0.067, 0.036 + k * 0.042), (0.064, 0.042 + k * 0.042)]
        prof += [(0.064, 0.24), (0.07, 0.245), (0.07, 0.255), (0.0, 0.255)]
        p.lathe(prof, (base, y, cz), (1, 0, 0), al, segs=36)
        # firing chamber (cast iron) on the cylinder end, nearest the pilot
        hx = base + 0.255
        p.box((hx + 0.032, y, cz + 0.01), (0.064, 0.105, 0.115), fe, r=0.012)
        # automatic intake valve cage on top, exhaust valve cage below with the open exhaust port
        p.lathe([(0.0, 0.0), (0.022, 0.0), (0.022, 0.035), (0.026, 0.038), (0.026, 0.046), (0.0, 0.048)], (hx + 0.03, y, cz + 0.068), (0, 0, 1), fe, segs=20)
        p.lathe([(0.0, 0.0), (0.02, 0.0), (0.02, 0.03), (0.017, 0.032), (0.017, 0.07)], (hx + 0.03, y, cz - 0.048), (0, 0, -1), fe, segs=20)
        # make-and-break igniter: the plug body and the trip arm on the chamber's face
        p.lathe([(0.0, 0.0), (0.012, 0.0), (0.012, 0.014), (0.009, 0.016), (0.009, 0.04), (0.0, 0.042)], (hx + 0.064, y + 0.02, cz + 0.01), (1, 0, 0), br, segs=14)
        p.beam((hx + 0.10, y + 0.02, cz + 0.01), (hx + 0.10, y + 0.02, cz - 0.05), 0.006, 0.01, st, r=0.002)
        # pushrod from the camshaft to the exhaust valve
        p.rod((cx + 0.11, y, cz - 0.09), (hx + 0.03, y, cz - 0.11), 0.004, st, segs=8)
        # water outlet on top of each jacket into the return pipe
        p.rod((base + 0.12, y, cz + 0.064), (base + 0.12, y, cz + 0.10), 0.009, al, segs=12)
    # intake manifold (aluminium) over the valve cages, from the carburettor at the front
    hx = cx + 0.095 + 0.255 + 0.03
    p.tube([(hx, -0.36, cz + 0.125), (hx, -0.23, cz + 0.125), (hx, 0.23, cz + 0.125)], 0.016, al, segs=16)
    for y in cyl_y:
        p.rod((hx, y, cz + 0.112), (hx, y, cz + 0.122), 0.014, al, segs=14)
    # surface carburettor: the fuel chamber at the front end of the manifold
    # (a soldered tinned-steel box tight under the manifold's front end, with a brass fuel union on top)
    p.box((hx, -0.39, cz + 0.085), (0.06, 0.06, 0.06), M["tin"], r=0.004)
    p.lathe([(0.0, 0), (0.006, 0), (0.006, 0.02), (0.0, 0.02)], (hx, -0.39, cz + 0.115), (0, 0, 1), br, segs=10)
    # water return pipe along the jackets' tops
    p.tube([(cx + 0.215, -0.30, cz + 0.11), (cx + 0.215, 0.22, cz + 0.11)], 0.014, al, segs=14)
    # camshaft housing under the cylinders, trip-rod shaft for the igniters
    p.tube([(cx + 0.11, -0.34, cz - 0.09), (cx + 0.11, 0.26, cz - 0.09)], 0.016, al, segs=14)
    p.tube([(hx + 0.10, -0.30, cz - 0.055), (hx + 0.10, 0.24, cz - 0.055)], 0.005, st, segs=8)
    # two drip oilers (brass and glass) on the crankcase
    for y in (-0.15, 0.17):
        p.lathe([(0.0, 0.0), (0.012, 0.0), (0.012, 0.01), (0.02, 0.014), (0.02, 0.05), (0.014, 0.055), (0.004, 0.06), (0.0, 0.065)],
                (cx - 0.03, y, cz + 0.115), (0, 0, 1), br, segs=18, caps=(True, True))
    # magneto (low tension, Dayton Electric) under the flywheel: field box, three horseshoe magnets, friction wheel
    mx, my, mz = cx - 0.13, 0.43, cz - 0.17
    p.box((mx, my, mz), (0.07, 0.11, 0.06), fe, r=0.006)
    for k in range(3):
        y = my - 0.035 + k * 0.035
        pts = [(mx + 0.045 * math.cos(a), y, mz + 0.035 + 0.045 * math.sin(a)) for a in np.linspace(-0.25 * math.pi, 1.25 * math.pi, 20)]
        p.sweep(K.rounded_rect(0.008, 0.016, 0.003), pts, M["black"], ref=(0, 1, 0))
    p.lathe([(0.0, -0.01), (0.03, -0.01), (0.03, 0.01), (0.0, 0.01)], (mx + 0.04, my, mz + 0.06), (0, 1, 0), M["leather"], segs=24)
    # ignition wires from the magneto to the igniters
    for y in cyl_y:
        p.tube([(mx, my - 0.05, mz + 0.02), (cx + 0.05, y + 0.06, cz - 0.13), (hx + 0.07, y + 0.03, cz - 0.03), (hx + 0.064, y + 0.02, cz + 0.0)],
               0.0028, M["black"], segs=6)
    # crankshaft out of the rear bearing to the sprockets
    p.rod((cx, 0.35, cz), (cx, CHAIN_Y["left"] + 0.03, cz), 0.017, st, segs=16)


def sprocket(p, center, axis_y_sign, teeth, pitch, thick, m):
    """A chain sprocket in the XZ plane at center (axis along Y)."""
    r = pitch / (2 * math.sin(math.pi / teeth))
    out = []
    for k in range(teeth * 4):
        a = 2 * math.pi * k / (teeth * 4)
        phase = (k % 4)
        rr = r + (0.0045 if phase in (1, 2) else -0.0035)
        out.append((rr * math.cos(a), rr * math.sin(a)))
    p.extrude(out, center, (0, 1, 0), thick, m, ref=(1, 0, 0))
    p.lathe([(0.0, -thick), (r * 0.35, -thick), (r * 0.35, thick), (0.0, thick)], center, (0, 1, 0), m, segs=20)
    return r


def build_flywheel(p, M):
    fe, st = M["iron"], M["steel"]
    cx, cz = ENG_X, CRANK_Z
    # cast iron flywheel, 13 in across, rim and dished web
    prof = [(0.03, -0.012), (0.06, -0.008), (0.14, -0.006), (0.148, -0.022), (0.165, -0.022), (0.168, -0.018),
            (0.168, 0.018), (0.165, 0.022), (0.148, 0.022), (0.14, 0.006), (0.06, 0.008), (0.03, 0.03), (0.022, 0.03),
            (0.022, -0.03), (0.03, -0.012)]
    p.lathe(prof, (cx, 0.44, cz), (0, 1, 0), fe, segs=int(64 * max(DETAIL, 0.5)))
    for y in CHAIN_Y.values():
        sprocket(p, (cx, y, cz), 1, 8, 0.5 * IN, 0.006, st)
    p.lathe([(0.0, 0.0), (0.02, 0.0), (0.02, 0.012), (0.0, 0.014)], (cx, CHAIN_Y["left"] + 0.03, cz), (0, 1, 0), st, segs=6, caps=(True, True))


def chain_path(c1, r1, c2, r2, crossed):
    """Tangent points of an open (or crossed) chain between two sprockets in a plane of constant Y: returns the two
    straight runs as ((p, q), (p, q))."""
    (x1, z1), (x2, z2) = c1, c2
    dx, dz = x2 - x1, z2 - z1
    d = math.hypot(dx, dz)
    base = math.atan2(dz, dx)
    runs = []
    for s in (+1, -1):
        if not crossed:
            a = math.acos((r1 - r2) / d)
            ang1 = base + s * a
            ang2 = ang1
        else:
            a = math.acos((r1 + r2) / d)
            ang1 = base + s * a
            ang2 = ang1 + math.pi
        p = (x1 + r1 * math.cos(ang1), z1 + r1 * math.sin(ang1))
        q = (x2 + r2 * math.cos(ang2), z2 + r2 * math.sin(ang2))
        runs.append((p, q, ang1, ang2))
    return runs


def chain_links(p, M, pts_xz, y):
    """Roller chain (1/2 in pitch) along a polyline in the plane y."""
    pitch = 0.5 * IN
    path = [Vector((a, y, b)) for a, b in pts_xz]
    L = sum((b - a).length for a, b in zip(path[:-1], path[1:]))
    n = int(L / pitch)
    seglen = [(b - a).length for a, b in zip(path[:-1], path[1:])]

    def at(s):
        for (a, b), l in zip(zip(path[:-1], path[1:]), seglen):
            if s <= l:
                return a.lerp(b, s / max(l, 1e-9)), (b - a).normalized()
            s -= l
        return path[-1], (path[-1] - path[-2]).normalized()

    for k in range(n):
        c, d = at(k * pitch)
        c2, _ = at(min(L, (k + 1) * pitch))
        for dy in (-0.0045, 0.0045):
            w = 0.0016 if k % 2 else 0.0013
            a = Vector((c.x, y + dy * (1.25 if k % 2 else 1.0), c.z))
            b = Vector((c2.x, y + dy * (1.25 if k % 2 else 1.0), c2.z))
            p.beam(a - (b - a) * 0.18, b + (b - a) * 0.18, w, 0.0085, M["chain"], r=0.0035, segs=2, ref=(0, 1, 0), chamfer=False)
        p.rod((c.x, y - 0.006, c.z), (c.x, y + 0.006, c.z), 0.0035, M["chain"], segs=8)


def arc(c, r, a0, a1, n):
    return [(c[0] + r * math.cos(a0 + (a1 - a0) * k / n), c[1] + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]


def build_chain_guides(p, M):
    """Bicycle chains in steel guide tubes from the engine's sprockets to the propeller shafts' sprockets; the left
    chain is crossed in a figure eight so the propellers turn opposite ways (NPS Historical Handbook 34)."""
    pitch = 0.5 * IN
    r_e = pitch / (2 * math.sin(math.pi / 8))
    r_p = pitch / (2 * math.sin(math.pi / 23))
    for side, sx in (("right", -PROP_X), ("left", PROP_X)):
        y = CHAIN_Y[side]
        crossed = side == "left"
        runs = chain_path((ENG_X, CRANK_Z), r_e, (sx, PROP_Z), r_p, crossed)
        for i, (a, b, ang1, ang2) in enumerate(runs):
            A, B = Vector((a[0], y, a[1])), Vector((b[0], y, b[1]))
            d = (B - A).normalized()
            yo = (0.012 if i == 0 else -0.012) if crossed else 0.0
            t0, t1 = A + d * 0.10, B - d * 0.14
            # guide tube: 1 in steel tube with a flared mouth at each end, clamped to the struts
            p.tube([(t0.x, y + yo, t0.z), (t1.x, y + yo, t1.z)], 0.0125, M["tube"], segs=14, caps=False)
            for e, dd in ((t0, d), (t1, -d)):
                p.lathe([(0.0125, 0.0), (0.0175, -0.02)], (e.x, y + yo, e.z), tuple(dd), M["tube"], segs=14)
            if DETAIL >= 1.0:
                chain_links(p, M, [(A.x, A.z), (t0.x, t0.z)], y + yo)
                chain_links(p, M, [(t1.x, t1.z), (B.x, B.z)], y + yo)
        if DETAIL >= 1.0:
            # chain wrapped on the engine sprocket and on the shaft sprocket
            a1 = [r[2] for r in runs]
            a2 = [r[3] for r in runs]
            chain_links(p, M, arc((ENG_X, CRANK_Z), r_e, a1[0], a1[1] + (2 * math.pi if a1[1] < a1[0] else 0), 12), y)
            chain_links(p, M, arc((sx, PROP_Z), r_p, a2[1], a2[0] + (2 * math.pi if a2[0] < a2[1] else 0), 24), y)
        # tube clamp to the nearest rear upright
        p.box((sx * 0.55 + ENG_X * 0.45, y, (PROP_Z + CRANK_Z) / 2), (0.05, 0.02, 0.03), M["tube"], r=0.004)


def build_radiator_tank(p, M):
    tin, rub, br = M["tin"], M["rubber"], M["brass"]
    # vertical sheet-steel radiator on the central forward upright: flat tubes between top and bottom headers
    x0, y0 = -0.075, Y_FS + 0.06
    zb = wing_surface_z(x0, y0, Z_LOW, 1) + 0.12
    zt = zb + 0.95
    n = 9
    for k in range(n):
        x = x0 - 0.06 + k * 0.015
        p.box((x, y0, (zb + zt) / 2), (0.005, zt - zb - 0.06, 0.03), tin, r=0.002, rot=Matrix.Rotation(math.pi / 2, 3, "X"))
    for z in (zb, zt):
        p.box((x0, y0, z), (0.15, 0.045, 0.045), tin, r=0.01)
        p.lathe([(0.0, 0.0), (0.008, 0.0), (0.008, 0.03), (0.0, 0.03)], (x0 + 0.06, y0, z), (0, 1, 0), tin, segs=10)
    for z in (zb + 0.2, zt - 0.2):  # clamps to the upright
        p.box((-0.03, y0 - 0.03, z), (0.06, 0.012, 0.02), tin, r=0.003)
    # hoses from the radiator to the jackets (bottom: cold to the pump-less inlet; top: hot return)
    p.tube([(x0 + 0.06, y0 + 0.03, zb), (x0 + 0.02, -0.4, zb - 0.06), (ENG_X + 0.2, -0.28, CRANK_Z - 0.06)], 0.011, rub, segs=10)
    p.tube([(x0 + 0.06, y0 + 0.03, zt), (x0 + 0.04, -0.5, CRANK_Z + 0.35), (ENG_X + 0.215, -0.31, CRANK_Z + 0.11)], 0.011, rub, segs=10)
    # fuel tank (0.4 gallon) hung from the inner right front upright; copper line down to the carburettor
    tx, ty, tz = -STATIONS[0] + 0.05, Y_FS + 0.03, Z_UP - 0.40
    p.lathe([(0.0, -0.13), (0.045, -0.13), (0.05, -0.12), (0.05, 0.12), (0.045, 0.13), (0.0, 0.13)], (tx, ty, tz), (0, 0, 1), tin, segs=24)
    for z in (tz - 0.09, tz + 0.09):
        p.torus((tx, ty, z), (0, 0, 1), 0.052, 0.003, tin)
    p.lathe([(0.0, 0.0), (0.012, 0.0), (0.012, 0.02), (0.0, 0.022)], (tx, ty, tz + 0.13), (0, 0, 1), br, segs=12, caps=(True, True))
    hx = ENG_X + 0.095 + 0.255 + 0.03
    p.tube([(tx, ty, tz - 0.13), (tx, ty + 0.02, tz - 0.4), (hx - 0.02, -0.44, CRANK_Z + 0.25), (hx, -0.40, CRANK_Z + 0.16)], 0.003, M["brass"], segs=6)


def build_instruments(p, M):
    """Richard anemometer, stopwatch and engine revolution counter on a bar across the central forward upright."""
    y, z = Y_FS + 0.04, 1.02
    p.beam((-0.02, y, z), (0.30, y, z), 0.02, 0.02, M["ash"])
    # anemometer: brass ring with eight aluminium vanes and the counter dial behind
    ax = 0.10
    p.torus((ax, y - 0.03, z + 0.07), (0, 1, 0), 0.05, 0.004, M["brass"], segs=32)
    for k in range(8):
        a = 2 * math.pi * k / 8
        c = (ax + 0.028 * math.cos(a), y - 0.03, z + 0.07 + 0.028 * math.sin(a))
        p.box(c, (0.004, 0.04, 0.022), M["aluminium"], r=0.0008,
              rot=Matrix.Rotation(a, 3, "Y") @ Matrix.Rotation(0.6, 3, "Z"))
    p.lathe([(0.0, 0.0), (0.03, 0.0), (0.03, 0.03), (0.0, 0.032)], (ax, y - 0.0, z + 0.07), (0, 1, 0), M["brass"], segs=24, caps=(True, True))
    p.lathe([(0.0, 0.0), (0.026, 0.0), (0.0, 0.0005)], (ax, y + 0.033, z + 0.07), (0, 1, 0), M["enamel"], segs=24, caps=(True, False))
    # stopwatch
    sx = 0.19
    p.lathe([(0.0, 0.0), (0.024, 0.0), (0.026, 0.006), (0.024, 0.012), (0.0, 0.013)], (sx, y - 0.01, z + 0.04), (0, -1, 0), M["brass"], segs=24)
    p.lathe([(0.0, 0.0), (0.021, 0.0), (0.0, 0.0005)], (sx, y - 0.0235, z + 0.04), (0, -1, 0), M["enamel"], segs=24, caps=(True, False))
    p.rod((sx, y - 0.01, z + 0.065), (sx, y - 0.01, z + 0.075), 0.003, M["brass"])
    # revolution counter
    p.box((0.255, y - 0.012, z + 0.035), (0.05, 0.03, 0.04), M["black"], r=0.004)
    p.lathe([(0.0, 0.0), (0.012, 0.0), (0.0, 0.0005)], (0.255, y - 0.0275, z + 0.04), (0, -1, 0), M["enamel"], segs=18, caps=(True, False))


def build_cradle(p, M):
    """The hip cradle: an ash saddle on the slide rails; moving it twists the wings and turns the rudder."""
    zc = wing_surface_z(PILOT_X, 0.18, Z_LOW, 1)
    x, y = PILOT_X, 0.18
    p.box((x, y, zc + 0.04), (0.40, 0.16, 0.018), M["ash"], r=0.005)
    for s in (1, -1):
        pts = [(x + s * 0.20, y + yy, zc + 0.05 + 0.10 * (1 - (yy / 0.08) ** 2)) for yy in np.linspace(-0.08, 0.08, 9)]
        p.sweep(K.rounded_rect(0.02, 0.012, 0.004), [(x + s * 0.20, y - 0.08, zc + 0.05)] + [(x + s * 0.20, y, zc + 0.17)] + [(x + s * 0.20, y + 0.08, zc + 0.05)], M["ash"])
        p.box((x + s * 0.19, y, zc + 0.10), (0.016, 0.14, 0.09), M["leather"], r=0.006)
    for ry in (0.05 - 0.13, 0.30 - 0.13):
        p.box((x, y + ry + 0.0, zc + 0.026), (0.12, 0.03, 0.012), M["brass"], r=0.002, rot=Matrix.Rotation(math.pi / 2, 3, "Z"))


def build_elevator(fab, frame, wr, M, ribs, wseed):
    """The biplane elevator ahead: two cambered, double-covered surfaces with rounded ends, joined by uprights."""
    for z0 in (ELEV_Z - ELEV_GAP / 2, ELEV_Z + ELEV_GAP / 2):
        surface(fab, M["elevator"], ELEV_SPAN / 2, ELEV_CHORD, z0, ELEV_Y - ELEV_CHORD / 2, 0.36, 0.36, 1 / 18, 0.0, 0.022, ribs,
                (0, 1, 0, 1), 4.0 + z0, per_bay=10, around=40, sag=(0.004, 0.003), scallop=0.0)
    for sx in (0.42, -0.42, 1.25, -1.25):
        for yy in (ELEV_Y - 0.10, ELEV_Y + 0.12):
            u = (yy - (ELEV_Y - ELEV_CHORD / 2)) / ELEV_CHORD
            zl = ELEV_Z - ELEV_GAP / 2 + camber_z_generic(u, 1 / 18, ELEV_CHORD) + 0.008
            zu = ELEV_Z + ELEV_GAP / 2 + camber_z_generic(u, 1 / 18, ELEV_CHORD) - 0.008
            frame.beam((sx, yy, zl), (sx, yy, zu), 0.022, 0.026, M["spruce"], seed=wseed())
        wr.rod((sx, ELEV_Y - 0.10, ELEV_Z - ELEV_GAP / 2 + 0.06), (sx, ELEV_Y + 0.12, ELEV_Z + ELEV_GAP / 2 + 0.05), 0.0009, M["steel"])
    for a, b in ((0.42, 1.25), (-0.42, -1.25), (0.42, -0.42)):
        for zz in (ELEV_Z - ELEV_GAP / 2 + 0.06, ELEV_Z + ELEV_GAP / 2 + 0.05):
            wr.rod((a, ELEV_Y, zz), (b, ELEV_Y, ELEV_Z * 2 - zz + (0.01 if zz > ELEV_Z else -0.01)), 0.0009, M["steel"])
    # pivot posts at the outriggers' meeting point
    for sx in (0.40, -0.40):
        frame.beam((sx, ELEV_Y, ELEV_Z - ELEV_GAP / 2 + 0.02), (sx, ELEV_Y, ELEV_Z + ELEV_GAP / 2 - 0.02), 0.026, 0.03, M["ash"], seed=wseed())


def build_rudder(fab, frame, wr, M, ribs, wseed):
    """Twin movable rudders behind, each a double-covered vertical surface with rounded corners."""
    for sx in (RUD_X, -RUD_X):
        part = K.Part("tmp")
        surface(part, M["rudder"], RUD_H / 2, RUD_CHORD, 0.0, RUD_Y, 0.24, 0.24, 0.0, 0.0, 0.018, [r - (RUD_Z0 + RUD_H / 2) for r in ribs],
                (0, 1, 0, 1), 7.0 + sx, per_bay=8, around=28, sag=(0.003, 0.003), scallop=0.0, vertical=True)
        mtx = Matrix.Translation((sx, 0, RUD_Z0 + RUD_H / 2))
        fab.merge(part, mtx)
        frame.beam((sx, RUD_Y + 0.01, RUD_Z0 - 0.03), (sx, RUD_Y + 0.01, RUD_Z0 + RUD_H + 0.03), 0.02, 0.024, M["spruce"], seed=wseed())
    for z in (RUD_Z0 + 0.25, RUD_Z0 + RUD_H - 0.25):
        frame.beam((RUD_X, RUD_Y + 0.25, z), (-RUD_X, RUD_Y + 0.25, z), 0.018, 0.02, M["spruce"], seed=wseed())
        wr.rod((RUD_X, RUD_Y + 0.01, z), (-RUD_X, RUD_Y + 0.25, z + 0.2), 0.0009, M["steel"])
    # rudder horns for the control cables
    for sx in (RUD_X, -RUD_X):
        frame.box((sx + math.copysign(0.03, sx), RUD_Y + 0.02, RUD_Z0 + 0.4), (0.05, 0.012, 0.03), M["tube"], r=0.002)


def build_propeller(p, M, spin, sx, side):
    """One 8 ft 6 in pusher: three glued laminations of spruce, twisted airfoil blades, muslin-covered tips; the shaft
    and its 23-tooth sprocket turn with it."""
    hub = Vector((sx, PROP_Y, PROP_Z))
    n_st = max(10, int(26 * DETAIL))
    pitch = 1.75
    for blade in (0, 1):
        ang = math.pi * blade
        radial = Vector((math.cos(ang), 0, math.sin(ang)))
        tang = Vector((0, 1, 0)).cross(radial) * spin
        rows, uvs = [], []
        rows_tip, uvs_tip = [], []
        stations = [0.055 + (PROP_R - 0.055) * (1 - math.cos(math.pi * k / n_st)) / 2 for k in range(n_st + 1)]
        n_c = max(10, int(22 * DETAIL))
        for i, r in enumerate(stations):
            t = r / PROP_R
            chord = 0.07 + 0.15 * math.sin(min(1.0, t / 0.68) * math.pi / 2) ** 1.5
            if t > 0.86:
                chord *= math.sqrt(max(0.0, 1 - ((t - 0.86) / 0.14) ** 2)) * 0.98 + 0.02
            thick = 0.036 * (1 - t) ** 1.2 + 0.008
            phi = math.atan(pitch / (2 * math.pi * max(r, 0.12)))
            # chord direction: mostly tangential, tilted toward -Y (thrust forward) by the pitch angle
            cdir = (-tang * math.cos(phi) + Vector((0, 1, 0)) * math.sin(phi)).normalized()
            ndir = cdir.cross(radial).normalized()
            if ndir.y > 0:
                ndir = -ndir
            ring, uvr = [], []
            for k in range(2 * n_c):
                if k < n_c:  # flat pressure face from leading to trailing edge
                    s = k / n_c
                    h = -0.15 * thick * math.sin(math.pi * s)
                else:  # cambered suction face back to the leading edge
                    s = 1 - (k - n_c) / n_c
                    h = thick * (4 * s * (1 - s)) ** 0.8 * (1.1 - 0.3 * s)
                lead = -0.35 * chord + s * chord
                q = hub + radial * r + cdir * lead + ndir * h
                ring.append(q)
                uvr.append((k / (2 * n_c) * 0.5 + blade * 0.37, r / 1.0))
            uvr.append((0.5 + blade * 0.37, r / 1.0))
            rows.append(ring)
            uvs.append(uvr)
        cut = next(i for i, r in enumerate(stations) if r > PROP_R - 0.25)
        p.grid(rows[:cut + 1], uvs[:cut + 1], M["prop"], closed_u=True)
        p.grid(rows[cut:], uvs[cut:], M["prop_tip"], closed_u=True)
        # tip cap
        tipc = sum(rows[-1], Vector()) / len(rows[-1])
        ids = [p.vert(q) for q in rows[-1]]
        c = p.vert(tipc)
        for k in range(len(ids)):
            p.face([c, ids[k], ids[(k + 1) % len(ids)]], [(0.5, 1.3)] * 3, M["prop_tip"], flat=False)
    # hub boss with steel flange plates and bolts, the tubular shaft, its sprocket
    p.box((sx, PROP_Y, PROP_Z), (0.13, 0.07, 0.075), M["prop"], r=0.02, rot=Matrix.Rotation(math.pi / 2, 3, "X"))
    for yy in (PROP_Y - 0.04, PROP_Y + 0.04):
        p.lathe([(0.0, -0.003), (0.055, -0.003), (0.055, 0.003), (0.0, 0.003)], (sx, yy, PROP_Z), (0, 1, 0), M["iron"], segs=24)
        for k in range(4):
            a = math.pi / 4 + k * math.pi / 2
            c = (sx + 0.038 * math.cos(a), yy - (0.008 if yy < PROP_Y else -0.008), PROP_Z + 0.038 * math.sin(a))
            p.lathe([(0.0, 0.0), (0.006, 0.0), (0.006, 0.005), (0.0, 0.006)], c, (0, -1 if yy < PROP_Y else 1, 0), M["iron"], segs=6, caps=(True, True))
    p.rod((sx, CHAIN_Y[side] - 0.03, PROP_Z), (sx, PROP_Y + 0.07, PROP_Z), 0.016, M["steel"], segs=16)
    sprocket(p, (sx, CHAIN_Y[side], PROP_Z), 1, 23, 0.5 * IN, 0.006, M["steel"])
    p.lathe([(0.0, 0.0), (0.02, 0.0), (0.02, 0.016), (0.0, 0.018)], (sx, PROP_Y + 0.07, PROP_Z), (0, 1, 0), M["iron"], segs=6, caps=(True, True))


# ---------------------------------------------------------------- main
def main():
    root, M, maps = build()
    name = "flyer-1903" if LOD == 0 else f"flyer-1903-lod{LOD}"
    glb = os.path.join(OUT, name + ".glb")
    K.export_glb(glb)
    for surf, (col, dt) in maps.items():
        K.add_diffuse_transmission(glb, [f"muslin {surf}"], 0.45, (1.0, 0.86, 0.62), dt, texcoord=1)
    summary = K.glb_summary(glb)
    summary["triangles"] = K.tri_count([o for o in bpy.data.objects])
    K.log("glb", glb, summary)
    with open(os.path.join(OUT, name + ".summary.json"), "w") as f:
        import json
        json.dump(summary, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, name + ".blend"), compress=True)
    here = os.path.dirname(os.path.abspath(__file__))
    for src in (os.path.join(here, "build_flyer.py"), os.path.join(here, "LABEL.md"), os.path.join(here, "..", "lib", "kh_common.py")):
        if os.path.exists(src):
            shutil.copy2(src, OUT)
    if OPT["previews"] and LOD == 0:
        pv = os.path.join(OUT, "previews")
        os.makedirs(pv, exist_ok=True)
        K.preview_setup()
        K.preview_render(os.path.join(pv, "front-three-quarter.png"), (-9.5, -10.5, 3.2), (0, -0.5, 1.2), 40)
        K.preview_render(os.path.join(pv, "rear-three-quarter.png"), (8.5, 9.0, 2.6), (0, 0.3, 1.2), 40)
        K.preview_render(os.path.join(pv, "engine.png"), (-1.9, -1.4, 1.75), (ENG_X + 0.1, 0.05, CRANK_Z), 45)
        K.preview_render(os.path.join(pv, "propeller-chains.png"), (-2.6, 3.4, 1.9), (-1.0, 0.8, 1.2), 40)
        K.preview_render(os.path.join(pv, "side.png"), (-14, 0.2, 1.4), (0, 0.2, 1.3), 35)
    K.log("done", OUT)


if __name__ == "__main__":
    try:
        main()
        open(os.path.join(OUT, "build.done"), "w").write("ok")
    except BaseException as e:
        import traceback
        os.makedirs(OUT, exist_ok=True)
        open(os.path.join(OUT, "build.done"), "w").write("FAILED\n" + traceback.format_exc())
        raise
