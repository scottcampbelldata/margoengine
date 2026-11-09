"""Regression: every Cycles bake sees the complete Cornell scene, not one face."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types

sys.modules['bpy'] = types.SimpleNamespace(app=types.SimpleNamespace(version_string='stub'))
source = Path(__file__).parent.parent / 'scripts' / 'cornell-cycles.py'
module_spec = importlib.util.spec_from_file_location('cornell', source)
runner = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(runner)
objects = []
runner.bpy.data = types.SimpleNamespace(objects=types.SimpleNamespace(remove=lambda obj, **kw: objects.remove(obj)))
runner.clear_scene = lambda: None
runner.add_light = lambda spec: spec
runner.remove_light = lambda: None

def add_quad(name, corners, albedo):
    objects.append(name)
    return name, None

visits = []
def bake(scene, obj, node, width, height, samples, bounces):
    expected = ['calibration'] if obj == 'calibration' else ['floor', 'block', 'wall']
    assert objects == expected, (obj, objects)
    visits.append(obj)
    return [[1, 1, 1]], 3

runner.add_quad = add_quad
runner.bake_quad = bake
chart = {'width': 1, 'height': 1}
quad = lambda name: {'name': name, 'corners': [], 'albedo': [1, 1, 1], 'chart': chart}
payload = {'samples': 1, 'bounces': 1, 'light': {}, 'calibration': {'light': {}, 'corners': [], 'chart': chart},
           'quads': [quad(name) for name in ['floor', 'block', 'wall']]}
with tempfile.TemporaryDirectory() as folder:
    scene, result = Path(folder) / 'scene.json', Path(folder) / 'result.json'
    scene.write_text(json.dumps(payload))
    runner.args_after_dash = lambda: (scene, result)
    runner.main()
    assert len(json.loads(result.read_text())['quads']) == 3
assert visits == ['calibration', 'floor', 'block', 'wall']
