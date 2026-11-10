"""Parent-relative object transforms and actions, evaluated through Blender's public dependency graph API."""
from mathutils import Matrix


def hierarchy(context, node_of):
    """Keep exported object ancestors (including hidden empties) and return roots plus sampling owners."""
    objects = node_of.objects
    # An exported child still needs its hidden/non-mesh ancestors to keep its pivot and animation.
    for obj, _ in list(objects.values()):
        parent = obj.parent
        while parent:
            if parent.as_pointer() not in objects:
                node_of(parent, None, Matrix.Identity(4))
            parent = parent.parent
    for obj in context.view_layer.objects:
        if obj.type == "EMPTY" and obj.visible_get(view_layer=context.view_layer) and obj.as_pointer() not in objects:
            node_of(obj, None, Matrix.Identity(4))
    # Empty ancestors may themselves have parents.
    for obj, _ in list(objects.values()):
        parent = obj.parent
        while parent:
            if parent.as_pointer() not in objects:
                node_of(parent, None, Matrix.Identity(4))
            parent = parent.parent

    def world(obj):
        evaluated = obj.evaluated_get(context.evaluated_depsgraph_get())
        matrix = node_of.convert(evaluated.matrix_world)
        if obj.type in ("LIGHT", "CAMERA"):
            # Those objects retain Blender's local -Z forward/+Y up, unlike mesh geometry.
            matrix = matrix @ Matrix.Rotation(-1.5707963267948966, 4, "X")
        return matrix

    def local(obj):
        # Relative evaluated worlds include parent inverses, constraints and bone/vertex parenting without
        # relying on matrix_local, whose documented bone-parent behaviour is relative to the armature.
        matrix = world(obj)
        return world(obj.parent).inverted() @ matrix if obj.parent else matrix

    roots, owners = [], []
    for obj, node in objects.values():
        t, r, s = node_of.trs(obj, None, local(obj))
        node.update(translation=t, rotation=r, scale=s)
        if obj.parent:
            objects[obj.parent.as_pointer()][1].setdefault("children", []).append(node["id"])
        else:
            roots.append(node["id"])
        owners.append(("object", obj, node["id"], local))
    # Generated geometry instances retain their evaluated placement. They are distinct nodes, not object owners.
    children = {child for node in node_of.nodes for child in node.get("children", [])}
    roots += [node["id"] for node in node_of.nodes if node["id"] not in children and node["id"] not in roots]
    return roots, owners
