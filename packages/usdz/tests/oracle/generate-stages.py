# python fuzz.py outdir count seed: random stages of every arc kind, in plain text, for the differential against OpenUSD.
import os, random, sys
out, count, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rnd = random.Random(seed)
os.makedirs(out, exist_ok=True)
names = ['a', 'b', 'c']
def attrs(tag, ind):
    lines = []
    for k in range(4):
        if rnd.random() < 0.6:
            r = rnd.random()
            if r < 0.2:
                lines.append(f'{ind}custom double v{k}.timeSamples = {{ {rnd.randint(0,3)}: {rnd.randint(1,99)}, {rnd.randint(4,9)}: {rnd.randint(1,99)} }}')
            elif r < 0.3:
                lines.append(f'{ind}custom double v{k} = None')
            else:
                lines.append(f'{ind}custom double v{k} = {rnd.randint(1,999)}')
    if rnd.random() < 0.3:
        edit = rnd.choice(['', 'prepend ', 'append ', 'delete ', 'add '])
        lines.append(f'{ind}{edit}custom rel r = [<{rnd.choice(["/Shared", "/M/a", "/C/b", "/Y"])}>]' if not edit.startswith(('add','delete','pre','app')) else f'{ind}{edit}rel r = [<{rnd.choice(["/Shared", "/M/a", "/C/b"])}>]')
    return lines
def prim(spec, name, depth, classes, files, layerPrims, ind):
    meta = []
    if rnd.random() < 0.35 and classes:
        meta.append(f'{rnd.choice(["", "prepend ", "append "])}inherits = <{rnd.choice(classes)}>')
    if rnd.random() < 0.2 and classes:
        meta.append(f'specializes = <{rnd.choice(classes)}>')
    if rnd.random() < 0.4 and files:
        f = rnd.choice(files)
        tgt = rnd.choice(['', '</M>', '</M/a>'])
        off = rnd.choice(['', ' (offset = 10)', ' (offset = 3; scale = 2)'])
        kind = rnd.choice(['references', 'payload', 'prepend references', 'append references'])
        meta.append(f'{kind} = @./{f}@{tgt}{off}')
    if rnd.random() < 0.15 and layerPrims:
        meta.append(f'references = <{rnd.choice(layerPrims)}>')
    vs = rnd.random() < 0.3
    if vs:
        meta.append('variantSets = "vs"')
        if rnd.random() < 0.7: meta.append(f'variants = {{ string vs = "{rnd.choice(["x", "y"])}" }}')
    head = f'{ind}{spec} "{name}"'
    lines = [head + (' (\n' + ''.join(f'{ind}    {m}\n' for m in meta) + f'{ind})' if meta else ''), f'{ind}{{']
    lines += attrs(name, ind + '    ')
    if depth < 2:
        for n in names:
            if rnd.random() < 0.45:
                lines += prim(rnd.choice(['def', 'def', 'over']), n, depth + 1, classes, files, layerPrims, ind + '    ')
    if vs:
        lines.append(f'{ind}    variantSet "vs" = {{')
        for sel in ['x', 'y']:
            lines.append(f'{ind}        "{sel}" {{')
            lines += attrs(sel, ind + '            ')
            if rnd.random() < 0.5:
                lines += prim('def', rnd.choice(names), 2, classes, files, [], ind + '            ')
            lines.append(f'{ind}        }}')
        lines.append(f'{ind}    }}')
    lines.append(f'{ind}}}')
    return lines
for i in range(count):
    d = os.path.join(out, str(i))
    os.makedirs(d, exist_ok=True)
    files = []
    for j, fname in enumerate(['l0.usda', 'l1.usda', 'l2.usda']):
        head = ['#usda 1.0', '(', '    defaultPrim = "M"']
        sub = []
        if j and rnd.random() < 0.3: sub.append(f'@./{rnd.choice(files)}@ (offset = {rnd.randint(0,5)})')
        if sub: head.append('    subLayers = [' + ', '.join(sub) + ']')
        head.append(')')
        body = []
        body += prim('class', 'C', 0, [], [], [], '')
        body += prim('def', 'Shared', 1, [], [], [], '')
        body += prim('def', 'M', 0, ['/C', '/C/a'], list(files), ['/Shared'], '')
        body += prim(rnd.choice(['def', 'over']), 'Y', 1, ['/C'], list(files), ['/Shared', '/M'], '')
        open(os.path.join(d, fname), 'w', newline='\n').write('\n'.join(head + body) + '\n')
        files.append(fname)
    root = ['#usda 1.0', '(', f'    subLayers = [@./l1.usda@ (offset = 7), @./l0.usda@]' if rnd.random() < 0.3 else '', ')']
    body = prim('class', 'C', 0, [], [], [], '') + prim('def', 'Shared', 1, [], [], [], '')
    for n in ['P', 'Q', 'R']:
        body += prim('def', n, 0, ['/C'], list(files), ['/Shared'], '')
    open(os.path.join(d, 'root.usda'), 'w', newline='\n').write('\n'.join(root + body) + '\n')
    print(os.path.abspath(os.path.join(d, 'root.usda')).replace('\\', '/'))
