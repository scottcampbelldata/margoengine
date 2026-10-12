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

import bpy
from bpy_extras.io_utils import ExportHelper
from .exporter import export_scene


class EXPORT_SCENE_OT_margo(bpy.types.Operator, ExportHelper):
    bl_idname = "export_scene.margo"
    bl_label = "Export Margo"
    filename_ext = ".margo"
    filter_glob: bpy.props.StringProperty(default="*.margo", options={"HIDDEN"})

    def execute(self, context):
        try:
            size = export_scene(context, self.filepath)
        except (ValueError, OSError, OverflowError, RuntimeError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Exported {size:,} bytes")
        return {"FINISHED"}


def menu_export(self, context):
    self.layout.operator(EXPORT_SCENE_OT_margo.bl_idname, text="Margo (.margo)")


def register():
    bpy.utils.register_class(EXPORT_SCENE_OT_margo)
    bpy.types.TOPBAR_MT_file_export.append(menu_export)


def unregister():
    bpy.types.TOPBAR_MT_file_export.remove(menu_export)
    bpy.utils.unregister_class(EXPORT_SCENE_OT_margo)
