"""Deterministic, Blender-authored PBR surfaces for the Light Keeper.

Creates tileable colour/roughness/normal PNGs, packs them into the native file,
and connects standard glTF-compatible image nodes. Uses local CC0 scans for
wood/concrete and generated maps for the remaining surfaces; no network access.
"""
from pathlib import Path
import math
import bpy
import numpy as np

SIZE = 512


def noise(rng, cells_x, cells_y=None):
    """Periodic bilinear value noise; rectangular grids give wood/brushing grain."""
    cells_y = cells_x if cells_y is None else cells_y
    a = rng.random((cells_y, cells_x)).astype(np.float32)
    x = np.arange(SIZE, dtype=np.float32) * cells_x / SIZE
    y = np.arange(SIZE, dtype=np.float32) * cells_y / SIZE
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    row_a = a[iy[:, None] % cells_y, ix[None, :] % cells_x] * (1 - fx)[None, :] + a[iy[:, None] % cells_y, (ix[None, :] + 1) % cells_x] * fx[None, :]
    row_b = a[(iy[:, None] + 1) % cells_y, ix[None, :] % cells_x] * (1 - fx)[None, :] + a[(iy[:, None] + 1) % cells_y, (ix[None, :] + 1) % cells_x] * fx[None, :]
    return row_a * (1 - fy)[:, None] + row_b * fy[:, None]


def strokes(rng, count, max_length=45, width=1):
    layer = np.zeros((SIZE, SIZE), dtype=np.float32)
    for _ in range(count):
        x, y = rng.integers(0, SIZE, 2)
        angle = rng.uniform(0, math.pi * 2)
        length = rng.uniform(3, max_length)
        value = rng.uniform(0.3, 1)
        for t in np.linspace(0, length, max(2, int(length * 2))):
            xx, yy = int(x + math.cos(angle) * t) % SIZE, int(y + math.sin(angle) * t) % SIZE
            for w in range(width):
                layer[(yy + w) % SIZE, xx] = max(layer[(yy + w) % SIZE, xx], value)
    return layer


def srgb(linear):
    return np.where(linear < 0.0031308, linear * 12.92, 1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055)


def image(name, rgb, folder, noncolor=False):
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    height, width = rgb.shape[:2]
    im = bpy.data.images.new(name, width, height, alpha=True)
    im.colorspace_settings.name = "Non-Color" if noncolor else "sRGB"
    rgba = np.ones((height, width, 4), dtype=np.float32)
    if rgb.ndim == 2:
        rgb = np.repeat(rgb[..., None], 3, axis=2)
    rgba[..., :3] = np.clip(rgb, 0, 1)
    im.pixels.foreach_set(rgba.reshape(-1))
    im.update()
    im.filepath_raw = str(folder / (name + ".png"))
    im.file_format = "PNG"
    im.save()
    im.pack()
    return im


def surface(kind, base, seed):
    rng = np.random.default_rng(seed)
    macro = noise(rng, 5)
    mid = noise(rng, 35)
    fine = noise(rng, 180)
    pixels = rng.random((SIZE, SIZE)).astype(np.float32)
    base = np.array(base, dtype=np.float32)[None, None, :]
    height = fine * 0.1
    rough = np.ones((SIZE, SIZE), dtype=np.float32) * 0.5
    if kind == "wood":
        grain = noise(rng, 3, 100)
        swirl = np.sin(np.arange(SIZE)[None, :] / SIZE * math.pi * 8 + mid * 1.1)
        pattern = (grain - 0.5) * 0.45 + (macro - 0.5) * 0.18 + (fine - 0.5) * 0.08
        rgb = base * (1 + pattern[..., None])
        darkgrain = np.clip((0.22 - grain) * 3, 0, 0.5)
        rgb *= 1 - darkgrain[..., None] * 0.35
        rough = 0.43 + fine * 0.18 + macro * 0.08
        height = grain * 0.32 + fine * 0.09 + swirl * 0.025
    elif kind == "stone":
        cloud = (macro - 0.5) * 0.24 + (mid - 0.5) * 0.13
        rgb = base * (1 + cloud[..., None])
        # Aggregate and pores remain small enough to read as stone, not camouflage.
        pores = np.clip((pixels - 0.975) * 40, 0, 1)
        flecks = np.clip((0.025 - pixels) * 32, 0, 1)
        rgb *= (1 - pores * 0.27)[..., None]
        rgb += flecks[..., None] * 0.035
        hairline = strokes(rng, 30, 110) * (macro > 0.48)
        rgb *= (1 - hairline * 0.09)[..., None]
        rough = 0.77 + fine * 0.18
        height = mid * 0.22 + fine * 0.36 - pores * 0.22 - hairline * 0.08
    elif kind in ("paint", "teal"):
        scratches = strokes(rng, 95 if kind == "paint" else 130, 35)
        chips = np.clip((noise(rng, 65) - 0.81) * 8, 0, 1) * np.clip((macro - 0.5) * 3, 0, 1)
        variation = (macro - 0.5) * 0.09 + (fine - 0.5) * 0.018
        rgb = base * (1 + variation[..., None])
        undercoat = np.array([0.16, 0.12, 0.075] if kind == "paint" else [0.10, 0.085, 0.055])
        wear = np.clip(chips * 0.55 + scratches * 0.24, 0, 0.6)[..., None]
        rgb = rgb * (1 - wear) + undercoat * wear
        rough = (0.32 if kind == "paint" else 0.38) + macro * 0.12 + scratches * 0.20 + chips * 0.25
        height = fine * 0.05 - scratches * 0.07 - chips * 0.08
    elif kind == "copper":
        brushed = noise(rng, 2, 220)
        scratches = strokes(rng, 80, 50)
        rgb = base * (0.91 + brushed[..., None] * 0.18 + (macro[..., None] - 0.5) * 0.15)
        patina = np.clip((macro - 0.65) * 2, 0, 0.22)[..., None]
        rgb = rgb * (1 - patina) + np.array([0.055, 0.13, 0.10]) * patina
        rough = 0.25 + brushed * 0.15 + scratches * 0.15
        height = brushed * 0.1 - scratches * 0.035
    elif kind == "rubber":
        rgb = base * (0.90 + fine[..., None] * 0.2)
        rough = 0.64 + mid * 0.18
        height = fine * 0.07
    elif kind == "clay":
        rings = np.sin(np.arange(SIZE)[:, None] * math.pi * 2 / 12) * 0.035
        rgb = base * (0.94 + macro[..., None] * 0.12 + (fine[..., None] - 0.5) * 0.1)
        rough = 0.7 + fine * 0.18
        height = fine * 0.2 + rings
    elif kind == "linen":
        u, v = np.meshgrid(np.arange(SIZE), np.arange(SIZE))
        weave = np.sin(u * math.pi / 3) * np.sin(v * math.pi / 3)
        rgb = base * (0.95 + (fine[..., None] - 0.5) * 0.15 + weave[..., None] * 0.035)
        rough = 0.8 + fine * 0.16
        height = weave * 0.13 + fine * 0.06
    else:
        rgb = base * (0.96 + macro[..., None] * 0.08)
        height = fine * 0.05
    dx = (np.roll(height, 1, axis=1) - np.roll(height, -1, axis=1)) * 0.8
    dy = (np.roll(height, 1, axis=0) - np.roll(height, -1, axis=0)) * 0.8
    normals = np.stack([dx, dy, np.ones_like(dx)], axis=2)
    normals /= np.linalg.norm(normals, axis=2)[..., None]
    return srgb(np.clip(rgb, 0, 1)), np.clip(rough, 0.05, 1), normals * 0.5 + 0.5


def assign_uv(mesh, tile_size):
    uv = mesh.uv_layers.get("SurfaceUV") or mesh.uv_layers.new(name="SurfaceUV")
    mesh.uv_layers.active = uv
    uv.active_render = True
    # Box projection in metric local coordinates. Discontinuous face islands are
    # deliberate; paint/granite are isotropic and the wood uses long plank axes.
    for poly in mesh.polygons:
        n = poly.normal
        dominant = max(range(3), key=lambda i: abs(n[i]))
        axes = (1, 2) if dominant == 0 else (0, 2) if dominant == 1 else (0, 1)
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv = (co[axes[0]] / tile_size, co[axes[1]] / tile_size)


def dry_concrete_maps(scan_folder, folder):
    """Retain CC0 scan detail with pale limestone color and dry roughness.

    Inputs stay unchanged. The derived ORM has R=1, G=high roughness, B=0.
    All numeric texture channels remain Non-Color; only albedo is sRGB.
    """
    scan = "concrete_floor_worn_001"
    source = []
    for suffix, noncolor in (("diff", False), ("rough", True), ("nor_gl", True)):
        im = bpy.data.images.load(str(scan_folder / (scan + "_" + suffix + "_1k.jpg")), check_existing=True)
        im.colorspace_settings.name = "Non-Color" if noncolor else "sRGB"
        im.pack()
        source.append(im)
    h, w = source[0].size[1], source[0].size[0]
    values = []
    for im in source[:2]:
        pixels = np.empty(w*h*4, dtype=np.float32)
        im.pixels.foreach_get(pixels)
        values.append(pixels.reshape(h, w, 4)[..., :3])
    luminance = values[0] @ np.array([.2126, .7152, .0722], dtype=np.float32)
    detail = np.clip((luminance-np.median(luminance))*.28, -.025, .025)
    # #c9bda9 is a pale warm limestone target, not the original olive-gray scan.
    color = np.array([201, 189, 169], dtype=np.float32)/255 + detail[..., None]
    roughness = .80 + .15*np.clip(values[1].mean(axis=2), 0, 1)
    orm = np.zeros((h, w, 3), dtype=np.float32)
    orm[..., 0] = 1
    orm[..., 1] = roughness
    base = image("lk_polyhaven_dry_limestone_base", color, folder)
    packed = image("lk_polyhaven_dry_limestone_orm", orm, folder, True)
    return [base, packed, source[2]]


def connect_dry_concrete(mat, maps):
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    for old in list(nodes):
        if old.type in ("TEX_IMAGE", "NORMAL_MAP") or old.name.startswith("Dry concrete /"):
            nodes.remove(old)
    for socket in ("Base Color", "Roughness", "Metallic", "Normal"):
        for link in list(bsdf.inputs[socket].links):
            links.remove(link)
    bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
    bsdf.inputs["Roughness"].default_value = 1
    bsdf.inputs["Metallic"].default_value = 0
    bsdf.inputs["Coat Weight"].default_value = 0
    base = nodes.new("ShaderNodeTexImage")
    base.name = "Dry concrete / albedo"
    base.image, base.extension = maps[0], "REPEAT"
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    orm = nodes.new("ShaderNodeTexImage")
    orm.name = "Dry concrete / packed ORM"
    orm.image, orm.extension = maps[1], "REPEAT"
    channels = nodes.new("ShaderNodeSeparateColor")
    channels.name = "Dry concrete / ORM channels"
    channels.mode = "RGB"
    links.new(orm.outputs["Color"], channels.inputs["Color"])
    links.new(channels.outputs["Green"], bsdf.inputs["Roughness"])
    metal = nodes.new("ShaderNodeMath")
    metal.name = "Dry concrete / metal factor 0"
    metal.operation = "MULTIPLY"
    metal.inputs[1].default_value = 0
    links.new(channels.outputs["Blue"], metal.inputs[0])
    links.new(metal.outputs[0], bsdf.inputs["Metallic"])
    normal = nodes.new("ShaderNodeTexImage")
    normal.name = "Dry concrete / scan normal"
    normal.image, normal.extension = maps[2], "REPEAT"
    bump = nodes.new("ShaderNodeNormalMap")
    bump.name = "Dry concrete / restrained aggregate normal"
    bump.inputs["Strength"].default_value = .25
    links.new(normal.outputs["Color"], bump.inputs["Color"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    mat["surface_finish"] = "Dry pale limestone; roughness=.80+.15*scan; metalness=0; normal=.25"
    mat["texture_provider"] = "Poly Haven"
    mat["texture_source"] = "https://polyhaven.com/a/concrete_floor_worn_001"
    mat["texture_license"] = "CC0"


def apply_dry_concrete(scene=None, root=None):
    """Material-only repair entry point: never changes geometry or UVs."""
    scene = scene or bpy.context.scene
    root = Path(root) if root else Path(bpy.data.filepath).resolve().parents[3]
    folder = root / "examples/assets/source/skinning_ik/textures"
    maps = dry_concrete_maps(folder / "polyhaven/concrete_floor_worn_001", folder)
    changed = []
    for mat in bpy.data.materials:
        if mat.users and mat.use_nodes and any(word in mat.name.lower() for word in ("stone", "concrete")):
            connect_dry_concrete(mat, maps)
            changed.append(mat.name)
    return {"materials": changed, "maps": [im.name for im in maps]}


def apply(scene=None, root=None):
    scene = scene or bpy.context.scene
    root = Path(root) if root else Path(bpy.data.filepath).resolve().parent
    folder = root / "examples/assets/source/skinning_ik/textures" if (root / "examples").exists() else root / "skinning_ik/textures"
    folder.mkdir(parents=True, exist_ok=True)
    textured = {}
    for mat in bpy.data.materials:
        if not mat.use_nodes or not mat.users:
            continue
        name = mat.name.lower()
        if any(word in name for word in ["glow", "optical", "glass", "mirror", "foliage", "soil", "paper"]):
            continue
        kind = next((kind for word, kind in [
            ("porcelain", "paint"), ("enamel", "paint"), ("teal", "teal"), ("walnut", "wood"),
            ("wood", "wood"), ("plank", "wood"), ("stone", "stone"), ("concrete", "stone"),
            ("copper", "copper"), ("brass", "copper"), ("charcoal", "rubber"), ("rubber", "rubber"),
            ("clay", "clay"), ("ceramic", "clay"), ("jute", "linen"), ("linen", "linen"), ("flax", "linen"), ("fabric", "linen")
        ] if word in name), None)
        if not kind:
            continue
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        base = list(bsdf.inputs["Base Color"].default_value[:3])
        seed = sum((i + 1) * ord(c) for i, c in enumerate(mat.name)) % (2 ** 32)
        scan = "wood_table_worn" if kind == "wood" else "concrete_floor_worn_001" if kind == "stone" else None
        scan_folder = folder / "polyhaven" / (scan or "")
        if kind == "stone" and (scan_folder / (scan + "_diff_1k.jpg")).exists():
            maps = dry_concrete_maps(scan_folder, folder)
            connect_dry_concrete(mat, maps)
            textured[mat.name] = kind
            continue
        if scan and (scan_folder / (scan + "_diff_1k.jpg")).exists():
            maps = []
            for suffix, noncolor in [("diff", False), ("rough", True), ("nor_gl", True)]:
                im = bpy.data.images.load(str(scan_folder / (scan + "_" + suffix + "_1k.jpg")), check_existing=True)
                im.colorspace_settings.name = "Non-Color" if noncolor else "sRGB"
                im.pack()
                maps.append(im)
            mat["texture_provider"] = "Poly Haven"
            mat["texture_source"] = "https://polyhaven.com/a/" + scan
            mat["texture_license"] = "CC0"
        else:
            color, rough, normal = surface(kind, base, seed)
            stem = "lk_" + "".join(c if c.isalnum() else "_" for c in mat.name.lower()).strip("_")
            maps = [image(stem + "_base", color, folder), image(stem + "_rough", rough, folder, True), image(stem + "_normal", normal, folder, True)]
        for old in list(nodes):
            if old.type in ("TEX_IMAGE", "NORMAL_MAP"):
                nodes.remove(old)
        for im, socket in zip(maps[:2], ["Base Color", "Roughness"]):
            tex = nodes.new("ShaderNodeTexImage")
            tex.image, tex.extension = im, "REPEAT"
            links.new(tex.outputs["Color"], bsdf.inputs[socket])
        tex = nodes.new("ShaderNodeTexImage")
        tex.image, tex.extension = maps[2], "REPEAT"
        bump = nodes.new("ShaderNodeNormalMap")
        bump.inputs["Strength"].default_value = 0.42 if kind in ("paint", "teal", "copper") else 0.65
        links.new(tex.outputs["Color"], bump.inputs["Color"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        textured[mat.name] = kind
    for obj in scene.objects:
        if obj.type != "MESH" or not obj.data.polygons:
            continue
        kinds = [textured.get(m.name) for m in obj.data.materials if m]
        if any(kinds):
            assign_uv(obj.data, 0.55 if "wood" in kinds else 3.0 if "stone" in kinds else 0.4)
    return {"materials": textured, "directory": str(folder), "images": len(textured) * 3}
