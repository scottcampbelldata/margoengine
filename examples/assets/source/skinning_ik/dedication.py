"""Bake the original two-line dedication into the instrument case's rear face.

Typography is rasterized with Blender in an isolated temporary scene. Only the
existing case-back polygons receive a material/UV change; no lettering geometry
is kept in the workshop or exported GLB. Copyright 2026 Scott Campbell. MIT.
"""
from pathlib import Path
import bpy
import hashlib
import json
import math
import numpy as np
import runpy

TEXT = "Margo Engine \u2661\nMade for Margie"
MATERIAL = "Workshop / instrument case baked dedication"
IMAGE = "lk_instrument_case_back_dedication"
OBJECT = "Workshop / fitted tool cases"
X_MIN, X_MAX = .668, 1.172
Y_MIN, Y_MAX = .248, .452
BACK_Z = .225


def _mask(folder):
    scene = bpy.data.scenes.new("Dedication / temporary type bake")
    objects, curves, cameras, materials = [], [], [], []
    font = None
    try:
        width, height = X_MAX-X_MIN, Y_MAX-Y_MIN
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x, scene.render.resolution_y = 1024, 512
        scene.render.resolution_percentage = 100
        scene.render.pixel_aspect_y = height / width * 2
        scene.render.film_transparent = True
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.view_settings.view_transform = "Standard"
        scene.render.filepath = str(folder / "dedication-ink-mask.png")
        material = bpy.data.materials.new("Dedication / temporary ink")
        materials.append(material)
        material.use_nodes = True
        nodes, links = material.node_tree.nodes, material.node_tree.links
        nodes.clear()
        ink, output = nodes.new("ShaderNodeEmission"), nodes.new("ShaderNodeOutputMaterial")
        ink.inputs["Color"].default_value = (1, 1, 1, 1)
        links.new(ink.outputs[0], output.inputs["Surface"])
        font_path = Path(r"C:/Windows/Fonts/segoeprb.ttf")
        if font_path.exists():
            font = bpy.data.fonts.load(str(font_path), check_existing=True)

        def text(body, center, maximum_width, maximum_height):
            curve = bpy.data.curves.new("Dedication / temporary type", "FONT")
            curves.append(curve)
            curve.body, curve.align_x, curve.align_y = body, "CENTER", "CENTER"
            curve.resolution_u = 12
            if font:
                curve.font = font
            curve.materials.append(material)
            obj = bpy.data.objects.new("Dedication / temporary type", curve)
            objects.append(obj)
            scene.collection.objects.link(obj)
            scene.view_layers[0].update()
            corners = [tuple(point) for point in obj.bound_box]
            lo = np.min(corners, axis=0)
            hi = np.max(corners, axis=0)
            scale = min(maximum_width/max(hi[0]-lo[0], 1e-8), maximum_height/max(hi[1]-lo[1], 1e-8))
            obj.scale = (scale, scale, scale)
            obj.location = (center[0]-(lo[0]+hi[0])*.5*scale, center[1]-(lo[1]+hi[1])*.5*scale, 0)
            return (hi[0]-lo[0])*scale

        # The outline heart is drawn explicitly so the exact dedication is
        # independent of font fallback support for the U+2661 glyph.
        first_width = text("Margo Engine", (-.018, -.044), .245, .027)
        text("Made for Margie", (0, -.080), .232, .0195)
        heart = bpy.data.curves.new("Dedication / outline heart", "CURVE")
        curves.append(heart)
        heart.dimensions, heart.resolution_u = "3D", 12
        heart.bevel_depth, heart.bevel_resolution = .0008, 3
        heart.materials.append(material)
        spline = heart.splines.new("BEZIER")
        points = [(0,-.012),(-.010,-.003),(-.012,.006),(-.006,.011),(0,.006),(.006,.011),(.012,.006),(.010,-.003)]
        spline.bezier_points.add(len(points)-1)
        for vertex, (x,y) in zip(spline.bezier_points, points):
            vertex.co = (-.018+first_width*.5+.021+x, -.044+y, 0)
            vertex.handle_left_type = vertex.handle_right_type = "AUTO"
        spline.bezier_points[0].handle_left_type = spline.bezier_points[0].handle_right_type = "VECTOR"
        spline.bezier_points[4].handle_left_type = spline.bezier_points[4].handle_right_type = "VECTOR"
        spline.use_cyclic_u = True
        obj = bpy.data.objects.new("Dedication / outline heart", heart)
        objects.append(obj)
        scene.collection.objects.link(obj)
        camera_data = bpy.data.cameras.new("Dedication / bake camera")
        cameras.append(camera_data)
        camera = bpy.data.objects.new("Dedication / bake camera", camera_data)
        objects.append(camera)
        scene.collection.objects.link(camera)
        camera.location = (0, 0, 1)
        camera_data.type, camera_data.ortho_scale = "ORTHO", width
        scene.camera = camera
        bpy.ops.render.render(scene=scene.name, write_still=True)
        mask = bpy.data.images.load(scene.render.filepath, check_existing=False)
        try:
            rgba = np.empty(mask.size[0]*mask.size[1]*4, dtype=np.float32)
            mask.pixels.foreach_get(rgba)
            return rgba.reshape(mask.size[1],mask.size[0],4)[...,3].copy(), str(font_path) if font else "Blender Bfont"
        finally:
            bpy.data.images.remove(mask)
    finally:
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for curve in curves:
            bpy.data.curves.remove(curve)
        for camera in cameras:
            bpy.data.cameras.remove(camera)
        for material in materials:
            bpy.data.materials.remove(material)
        bpy.data.scenes.remove(scene)
        if font and not font.users:
            bpy.data.fonts.remove(font)


def apply(scene=None, root=None):
    scene = scene or bpy.context.scene
    root = Path(root) if root else Path(__file__).resolve().parents[4]
    folder = root / "examples/assets/source/skinning_ik/dedication"
    folder.mkdir(parents=True, exist_ok=True)
    obj = scene.objects[OBJECT]
    matrix = obj.matrix_world
    normal_matrix = matrix.inverted().transposed().to_3x3()
    selected = []
    for face in obj.data.polygons:
        normal = normal_matrix @ face.normal
        points = [matrix @ obj.data.vertices[i].co for i in face.vertices]
        if normal.y < -.999 and all(abs(-p.y-BACK_Z)<1e-5 and X_MIN-1e-5<=p.x<=X_MAX+1e-5 and Y_MIN-1e-5<=p.z<=Y_MAX+1e-5 for p in points):
            selected.append(face)
    if not selected:
        raise RuntimeError("Instrument case's flat rear face was not found")
    alpha, font = _mask(folder)
    original = bpy.data.materials["Workshop / olive leather toolkit"]
    bsdf = original.node_tree.nodes.get("Principled BSDF")
    base = np.array(bsdf.inputs["Base Color"].default_value[:3], dtype=np.float32)
    grain = np.random.default_rng(240614).random(alpha.shape).astype(np.float32)
    color = base[None,None,:] * (.985 + grain[...,None]*.03)
    gold = np.array([.66,.44,.16], dtype=np.float32)
    color = color*(1-alpha[...,None]) + gold*alpha[...,None]
    surface = runpy.run_path(str(root/"examples/assets/source/skinning_ik/surface_textures.py"))
    image = surface["image"](IMAGE, surface["srgb"](color), folder)
    material = bpy.data.materials.get(MATERIAL)
    if material is None:
        material = original.copy()
        material.name = MATERIAL
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    for node in list(nodes):
        if node.type == "TEX_IMAGE":
            nodes.remove(node)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image, texture.extension = image, "EXTEND"
    shader.inputs["Base Color"].default_value = (1,1,1,1)
    links.new(texture.outputs["Color"],shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value = .82
    shader.inputs["Metallic"].default_value = 0
    material["dedication"] = TEXT
    material["authored_by"] = "Original Blender-rasterized gold ink; no lettering geometry exported"
    slot = next((i for i,item in enumerate(obj.data.materials) if item==material), None)
    if slot is None:
        slot = len(obj.data.materials)
        obj.data.materials.append(material)
    uv = obj.data.uv_layers.get("SurfaceUV") or obj.data.uv_layers.new(name="SurfaceUV")
    uv.active_render = True
    for face in selected:
        face.material_index = slot
        for index in face.loop_indices:
            point = matrix @ obj.data.vertices[obj.data.loops[index].vertex_index].co
            # A rear observer at +Z looking toward -Z sees world +X to the right.
            uv.data[index].uv = ((point.x-X_MIN)/(X_MAX-X_MIN),(point.z-Y_MIN)/(Y_MAX-Y_MIN))
    obj["dedication"] = TEXT
    report = {"text":TEXT,"object":OBJECT,"faceCount":len(selected),"backPlaneGltfZ":BACK_Z,
              "backFaceGltfBounds":{"min":[X_MIN,Y_MIN,BACK_Z],"max":[X_MAX,Y_MAX,BACK_Z]},
              "font":font,"heart":"Original outline Bezier stroke, U+2661 appearance", "image":image.name,
              "imageSize":list(image.size),"imageSha256":hashlib.sha256(Path(image.filepath_raw).read_bytes()).hexdigest(),
              "geometry":"Existing case rear polygons only; material and UV changes; no added lettering geometry",
              "copyright":"Copyright 2026 Scott Campbell. Original Margo Engine asset. MIT."}
    (folder/"provenance.json").write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding="utf-8")
    return report
