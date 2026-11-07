# What OpenUSD's public API says about MaterialX in USD: blender --python materialx-truth.py -- out.json file...
# Per file, every Material with an mtlx surface: its shader's id and, per input, the value or the node that produces it.
# Also the published defaults of the surface shaders, through the shader registry.
import json, sys
from pxr import Gf, Sdf, Sdr, Usd, UsdShade, Vt
argv = sys.argv[sys.argv.index('--') + 1:]

def plain(value):
    if value is None:
        return None
    if isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Sdf.AssetPath):
        return value.path.replace('\\', '/').split('/')[-1]
    if hasattr(value, '__len__'):
        return [plain(v) for v in value]
    return str(value)

def source(attr):
    if UsdShade.Output.IsOutput(attr):
        prim = attr.GetPrim()
        shader = UsdShade.Shader(prim)
        return {'node': shader.GetShaderId(), 'output': attr.GetBaseName().split(':')[-1], 'prim': prim.GetName()}
    return {'value': plain(attr.Get())}

out = {'files': {}, 'defaults': {}}
for f in argv[1:]:
    entry = {}
    try:
        stage = Usd.Stage.Open(f, Usd.Stage.LoadAll)
        for prim in stage.Traverse():
            if not prim.IsA(UsdShade.Material):
                continue
            shader = UsdShade.Material(prim).ComputeSurfaceSource('mtlx')[0]
            if not shader or not (shader.GetShaderId() or '').startswith('ND_'):
                continue
            inputs = {}
            for item in shader.GetInputs():
                found = item.GetValueProducingAttributes()
                if found:
                    answer = source(found[0])
                    if answer.get('value') is not None or 'node' in answer:
                        inputs[item.GetBaseName()] = answer
            entry[str(prim.GetPath())] = {'shader': shader.GetPrim().GetName(), 'id': shader.GetShaderId(), 'inputs': inputs}
    except Exception as e:
        entry = {'error': str(e)[:200]}
    out['files'][f.replace('\\', '/').split('/dl/')[-1]] = entry

registry = Sdr.Registry()
for name in ['ND_standard_surface_surfaceshader', 'ND_open_pbr_surface_surfaceshader', 'ND_UsdPreviewSurface_surfaceshader', 'ND_gltf_pbr_surfaceshader', 'ND_surface_unlit']:
    node = registry.GetShaderNodeByIdentifier(name)
    if not node:
        continue
    out['defaults'][name] = {key: plain(node.GetShaderInput(key).GetDefaultValue()) for key in node.GetShaderInputNames()}
json.dump(out, open(argv[0], 'w'), indent=0, sort_keys=True)
print('MTLXTRUTH', len(out['files']), len(out['defaults']))
