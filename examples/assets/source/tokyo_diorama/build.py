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

import bake  # noqa: E402
import cats  # noqa: E402
import city  # noqa: E402
import facade  # noqa: E402
import kit  # noqa: E402
import merge  # noqa: E402
import polyhaven  # noqa: E402
import signs  # noqa: E402
import streetlife  # noqa: E402
import tanuki  # noqa: E402
import tram  # noqa: E402

HELPERS = [kit, polyhaven, bake, signs, tram, merge]
MODULES = [city, facade, tanuki, streetlife, cats]
for module in HELPERS + MODULES:  # pick up edits when re-run inside a live Blender session
    importlib.reload(module)


def build():
    kit.reset_scene()
    bake.ATLASES.clear()
    root = kit.empty('Diorama_Root', (0, 0, 0))
    signs.build_atlas()
    for module in MODULES:
        module.build(root)
    movers = [o for name in ('Tram', 'Cats') for o in [kit.SCENE.objects[name]] + list(kit.SCENE.objects[name].children_recursive)]
    bake.bake_all(hide=movers)  # after everything exists, so baked AO includes neighbours but not things that move away
    merge.build(root)  # one mesh per group after baking: thousands of draw calls down to a few hundred
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
            export_frame_range=True, export_image_format='JPEG', export_image_quality=88, export_anim_slide_to_zero=True, export_optimize_animation_size=True)


def main(out=None, blend=None):
    prefs = bpy.context.preferences
    saved = (prefs.edit.keyframe_new_interpolation_type, prefs.filepaths.save_version)
    try:  # build-time settings only; a live MCP build must leave the user's preferences as they were
        prefs.edit.keyframe_new_interpolation_type = 'LINEAR'
        build()
        if out:
            export(os.path.abspath(out))
        if blend:
            prefs.filepaths.save_version = 0  # no .blend1 backup next to the committed source
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(blend), copy=True)
    finally:
        prefs.edit.keyframe_new_interpolation_type, prefs.filepaths.save_version = saved


def _cli():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    pick = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None  # noqa: E731
    return pick('--out'), pick('--blend')


if __name__ == '__main__':
    main(*_cli())
