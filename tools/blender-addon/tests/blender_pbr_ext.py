"""Run only in a separate factory-startup/background Blender process: five 1 m planes with Principled BSDFs that use
transmission, IOR, coat, sheen and subsurface, in front of a green backdrop, exported to pbr-ext.margo. The file is
packages/blender/tests/fixtures/pbr-ext.margo (Blender 5.2.3 LTS); tests/pbr-ext.test.js checks its glTF material
extensions against the values set here."""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)


def plane(name, location, size, inputs, uv=False):
    bpy.ops.mesh.primitive_plane_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    if not uv:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])  # compact 24-byte vertices keep the fixture small
    material = bpy.data.materials.new(name)
    if bpy.app.version < (5, 0, 0):
        material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    for key, value in inputs.items():
        shader.inputs[key].default_value = value
    obj.data.materials.append(material)
    return obj


# Planes face +Z (the engine's +Y); the backdrop lies 0.5 m below them.
plane("Backdrop", (0, 0, -0.5), 8, {"Base Color": (0.1, 0.8, 0.1, 1), "Roughness": 0.8})
plane("Glass", (-2, 0, 0), 1, {"Base Color": (1, 1, 1, 1), "Roughness": 0.0, "Transmission Weight": 1.0, "IOR": 1.45})
plane("Coat", (-1, 0, 0), 1, {"Base Color": (0.8, 0.1, 0.1, 1), "Coat Weight": 1.0, "Coat Roughness": 0.05})
plane("Velvet", (0, 0, 0), 1, {"Base Color": (0.2, 0.2, 0.2, 1), "Sheen Weight": 1.0, "Sheen Tint": (0.4, 0.1, 0.6, 1), "Sheen Roughness": 0.3})
plane("Skin", (1, 0, 0), 1, {"Base Color": (0.8, 0.5, 0.4, 1), "Subsurface Weight": 1.0, "Subsurface Radius": (1.0, 0.2, 0.1), "Subsurface Scale": 0.05})
plane("Gem", (2, 0, 0), 1, {"Base Color": (0.9, 0.9, 1, 1), "IOR": 2.4})
# Frosted glass: a procedural roughness needs baking, and the bake keeps the transmission extension.
frosted = plane("Frosted", (0, 2, 0), 1, {"Transmission Weight": 1.0}, uv=True)
tree = frosted.active_material.node_tree
rough = tree.nodes.new("ShaderNodeMath")
rough.operation = "MULTIPLY_ADD"
coordinates = tree.nodes.new("ShaderNodeTexCoord")
split = tree.nodes.new("ShaderNodeSeparateXYZ")
tree.links.new(coordinates.outputs["UV"], split.inputs["Vector"])
tree.links.new(split.outputs["X"], rough.inputs[0])
rough.inputs[1].default_value = 0.5
rough.inputs[2].default_value = 0.25
tree.links.new(rough.outputs["Value"], next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Roughness"])
bpy.context.view_layer.update()
size = export_scene(bpy.context, output / "pbr-ext.margo", bake_size=16)
print("Margo PBR extensions export:", size, "bytes;", bpy.app.version_string)
