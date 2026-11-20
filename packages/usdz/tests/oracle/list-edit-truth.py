"""Relationship target list edits composed by OpenUSD public APIs, over random edits written here.

Each case puts an explicit target list on /Rel/C<n>.r in a weaker sublayer and a list edit (add, prepend, append,
delete, reorder; a file may not repeat an item) on the same relationship in the root layer. OpenUSD composes the stage and
reports the targets. Writes the two layers and the targets to fixtures/list-edit.json. usd-core 26.11.
"""
import json, pathlib, random, sys
from pxr import Usd, Sdf
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent.parent / 'fixtures' / 'list-edit.json')
random.seed(1942)
names = 'abcdefg'
tmp = out.parent / 'list-edit-tmp'
tmp.mkdir(exist_ok=True)
paths = lambda items: '[' + ', '.join(f'</{x}>' for x in items) + ']'
weak, strong, cases = ['#usda 1.0', 'over "Rel" {'], ['#usda 1.0', '(subLayers = [@weak.usda@])', 'def "Rel" {'], []
for n in range(300):
    pick = random.sample
    base = random.sample(names, random.randint(0, 6))
    weak.extend([f'    over "C{n}" {{', f'        rel r = {paths(base)}', '    }'])
    lines = []
    for edit in ['add', 'prepend', 'append', 'delete', 'reorder']:
        if random.random() < 0.45:
            items = pick(names, k=random.randint(1, 4)) if pick is random.choices else pick(names, random.randint(1, 4))
            lines.append(f'{edit} rel r = {paths(items)}')
    strong.append(f'    def "C{n}" {{')
    strong.extend('        ' + line for line in lines)
    strong.append('    }')
    cases.append(n)
weak.append('}')
strong.append('}')
(tmp / 'weak.usda').write_text('\n'.join(weak) + '\n')
(tmp / 'root.usda').write_text('\n'.join(strong) + '\n')
stage = Usd.Stage.Open(str(tmp / 'root.usda'))
expected = [[str(p)[1:] for p in stage.GetPrimAtPath(f'/Rel/C{n}').GetRelationship('r').GetTargets()] for n in cases]
json.dump({'weak': (tmp / 'weak.usda').read_text(), 'root': (tmp / 'root.usda').read_text(), 'targets': expected}, out.open('w'))
for f in tmp.iterdir(): f.unlink()
tmp.rmdir()
