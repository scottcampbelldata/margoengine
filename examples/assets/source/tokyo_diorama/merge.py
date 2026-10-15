"""Draw-call reduction: after baking, join each group's static meshes into one mesh (animated parts stay separate)."""
import bpy

import kit


def _animated(ob, stop):
    while ob is not None and ob is not stop:
        if ob.animation_data and ob.animation_data.action:
            return True
        ob = ob.parent
    return False


def static_children(group, direct_only=False, keep_prefixes=()):
    """Join `group`'s non-animated mesh descendants into `<group>_Static`, parented to `group`."""
    candidates = group.children if direct_only else group.children_recursive
    meshes = [o for o in candidates if o.type == 'MESH' and not _animated(o, group) and not o.name.startswith(keep_prefixes)]
    if len(meshes) < 2:
        return None
    view_layer = kit.SCENE.view_layers[0]
    view_layer.update()
    wm = bpy.context.window_manager
    window = bpy.context.window or (wm.windows[0] if wm.windows else None)
    override = {'scene': kit.SCENE, 'view_layer': view_layer, 'active_object': meshes[0], 'object': meshes[0],
                'selected_objects': meshes, 'selected_editable_objects': meshes}
    if window is not None:
        override['window'] = window
    with bpy.context.temp_override(**override):
        bpy.ops.object.join()
    joined = meshes[0]
    view_layer.update()
    world = joined.matrix_world.copy()
    joined.parent = group
    joined.matrix_world = world
    joined.name = group.name + '_Static'
    joined.data.name = joined.name
    return joined


def build(root):
    scene = kit.SCENE
    groups = [n for n in ('Building_1', 'Building_2', 'Building_3', 'Building_4', 'Building_5', 'Alley_1', 'Tram_Stop', 'Post_Box',
                          'Vending_Machine_1', 'Vending_Machine_2', 'Bicycle_1', 'Bicycle_2', 'Tanuki_Statue', 'Tram',
                          'Cat_1') if n in scene.objects]
    groups += [o.name for o in scene.objects if o.name.startswith('Bird_') and o.type == 'EMPTY']
    for name in groups:
        static_children(scene.objects[name])
    static_children(scene.objects['Street_Life'], direct_only=True, keep_prefixes=('Power_Line_', 'Traffic_Cone_'))
