"""Test installation in a disposable background Blender profile."""
import importlib
from pathlib import Path
import tempfile
import sys
import warnings
import bpy

archive = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
with tempfile.TemporaryDirectory() as directory:
    repo = bpy.context.preferences.extensions.repos.new(
        name="Margo Install Test", module="margo_test", custom_directory=directory)
    try:
        result = bpy.ops.extensions.package_install_files(
            filepath=str(archive), repo=repo.module, enable_on_install=True)
        assert result == {"FINISHED"}, result
        name = "bl_ext.margo_test.margo_export"
        assert name in bpy.context.preferences.addons
        module = importlib.import_module(name)
        assert "bl_info" not in vars(module), "Legacy metadata leaked into extension registration"
        output = Path(directory) / "installed.margo"
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            assert bpy.ops.export_scene.margo(filepath=str(output)) == {"FINISHED"}
        assert output.read_bytes()[:4] == b"MRGO"
        bpy.ops.preferences.addon_disable(module=name)
        assert not hasattr(bpy.types, "EXPORT_SCENE_OT_margo")
    finally:
        bpy.context.preferences.extensions.repos.remove(repo)
print("Extension ZIP install, enable, export and disable passed")
