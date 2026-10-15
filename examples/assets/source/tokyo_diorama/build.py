"""Build the Tokyo corner diorama and optionally export it.

Headless:  blender --background --factory-startup --python build.py -- --out tokyo-diorama.glb [--blend tokyo-diorama.blend]
Live (Blender MCP):  runpy.run_path(r'<repo>/examples/assets/source/tokyo_diorama/build.py', run_name='tokyo_build')['main']()
"""
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

import buildings  # noqa: E402
import kit  # noqa: E402
import street  # noqa: E402

MODULES = [kit, street, buildings]
for module in MODULES:  # pick up edits when re-run inside a live Blender session
    importlib.reload(module)


def build():
    kit.reset_scene()
    root = kit.empty('Diorama_Root', (0, 0, 0))
    for module in MODULES[1:]:
        module.build(root)
    kit.SCENE.frame_set(kit.FRAME_START)
    return root


def export(path):
    window = bpy.context.window or (bpy.context.window_manager.windows[0] if bpy.context.window_manager.windows else None)
    override = {'window': window} if window else {}
    with bpy.context.temp_override(**override):
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_active_scene=True,
            export_apply=True, export_yup=True, export_cameras=False, export_lights=False,
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_animations=True, export_animation_mode='SCENE', export_anim_scene_split_object=False, export_force_sampling=True,
            export_frame_range=True, export_anim_slide_to_zero=True, export_optimize_animation_size=True)


def main(out=None, blend=None):
    build()
    if out:
        export(os.path.abspath(out))
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(blend), copy=True)


def _cli():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    pick = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None  # noqa: E731
    return pick('--out'), pick('--blend')


if __name__ == '__main__':
    main(*_cli())
