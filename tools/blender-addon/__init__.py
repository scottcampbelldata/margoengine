bl_info = {
    "name": "Margo Engine Exporter",
    "author": "Margo Engine",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "File > Export > Margo (.margo)",
    "description": "Export evaluated static meshes to Margo WebGPU PBR",
    "category": "Import-Export",
}

if __package__.startswith("bl_ext."):
    del bl_info  # Extensions use their manifest; keep legacy discovery metadata above.

import os
import tempfile

import bpy
from bpy_extras.io_utils import ExportHelper
from .exporter import export_scene
from .live import LiveLink


class EXPORT_SCENE_OT_margo(bpy.types.Operator, ExportHelper):
    bl_idname = "export_scene.margo"
    bl_label = "Export Margo"
    filename_ext = ".margo"
    filter_glob: bpy.props.StringProperty(default="*.margo", options={"HIDDEN"})
    bake_size: bpy.props.IntProperty(
        name="Bake size",
        description="Pixels per side of the images baked for node materials outside the direct Principled subset; 0 turns baking off",
        default=1024,
        min=0,
        max=4096,
    )
    lights_cameras: bpy.props.BoolProperty(
        name="Lights and cameras",
        description="Export visible point, spot and sun lights and cameras, so the scene opens lit and framed as authored",
        default=True,
    )
    curves: bpy.props.BoolProperty(
        name="Curves, points and volumes",
        description="Export visible curves as splines, point clouds as points and volumes as OpenVDB grids; the file then needs @margoengine/blender/curves",
        default=False,
    )
    object_animation: bpy.props.BoolProperty(
        name="Object actions and hierarchy",
        description="Keep parent links and sample object actions, including empty pivots and constrained transforms; load with the anim or objects entry",
        default=False,
    )
    lightmap_size: bpy.props.IntProperty(
        name="Lightmap size",
        description="Cycles direct and indirect diffuse illumination on a second UV map; 0 disables baking",
        default=0, min=0, max=4096,
    )

    live_nodes: bpy.props.BoolProperty(
        name="Live node graphs",
        description="Keep common Mix, Color Ramp, Noise and Math graphs as animatable shaders; unsupported graphs fail by node name",
        default=False,
    )

    def execute(self, context):
        try:
            size = export_scene(context, self.filepath, bake_size=self.bake_size, lights_cameras=self.lights_cameras, curves=self.curves, object_animation=self.object_animation, lightmap_size=self.lightmap_size, live_nodes=self.live_nodes)
        except (ValueError, OSError, OverflowError, RuntimeError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Exported {size:,} bytes")
        return {"FINISHED"}


def live_export(bake_size=256):
    """export(context) -> the .margo bytes of the scene, through a temporary file (export_scene writes atomically)."""

    def export(context):
        handle, path = tempfile.mkstemp(suffix=".margo")
        os.close(handle)
        try:
            export_scene(context, path, bake_size=bake_size)
            with open(path, "rb") as file:
                return file.read()
        finally:
            os.remove(path)

    return export


links = {}  # the running live link, at most one per Blender session


class MARGO_OT_live_link(bpy.types.Operator):
    """Serve the scene to running pages and update them as it changes (@margoengine/blender/live)"""

    bl_idname = "margo.live_link"
    bl_label = "Margo Live Link"
    port: bpy.props.IntProperty(name="Port", description="Local port pages connect to; 0 picks a free one", default=8765, min=0, max=65535)
    bake_size: bpy.props.IntProperty(name="Bake size", description="Bake size for node materials while live; 0 turns baking off", default=256, min=0, max=4096)

    def execute(self, context):
        if "link" in links:
            links.pop("link").stop()
            self.report({"INFO"}, "Margo live link stopped")
            return {"FINISHED"}
        link = LiveLink(live_export(self.bake_size), port=self.port)
        try:
            url = link.start()
        except OSError as error:
            self.report({"ERROR"}, f"Margo live link could not listen on port {self.port}: {error}")
            return {"CANCELLED"}
        links["link"] = link
        self.report({"INFO"}, f"Margo live link at {url}")
        return {"FINISHED"}


class MARGO_PT_live_link(bpy.types.Panel):
    bl_label = "Margo Live Link"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Margo"

    def draw(self, context):
        link = links.get("link")
        self.layout.operator(MARGO_OT_live_link.bl_idname, text="Stop live link" if link else "Start live link")
        if link and link.server:
            self.layout.label(text=link.server.url)
            if link.error:
                self.layout.label(text=link.error, icon="ERROR")


def menu_export(self, context):
    self.layout.operator(EXPORT_SCENE_OT_margo.bl_idname, text="Margo (.margo)")


def register():
    bpy.utils.register_class(EXPORT_SCENE_OT_margo)
    bpy.utils.register_class(MARGO_OT_live_link)
    bpy.utils.register_class(MARGO_PT_live_link)
    bpy.types.TOPBAR_MT_file_export.append(menu_export)


def unregister():
    if "link" in links:
        links.pop("link").stop()
    bpy.utils.unregister_class(MARGO_PT_live_link)
    bpy.utils.unregister_class(MARGO_OT_live_link)
    bpy.types.TOPBAR_MT_file_export.remove(menu_export)
    bpy.utils.unregister_class(EXPORT_SCENE_OT_margo)
