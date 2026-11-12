# Rebuilds packages/loaders/tests/fixtures/materialx-reference: our own small MaterialX documents on two generated 16 x 16
# images, and the MaterialX GLSL texture bake of each one (MaterialX 1.39.5 from pip, used as a black box through its
# shipped baketextures.py command; none of its source is read). Run with a Python that has `pip install MaterialX==1.39.5`
# and a working OpenGL driver:
#   python -I packages/loaders/tests/oracle/materialx-bake.py packages/loaders/tests/fixtures/materialx-reference
# Each case folder gets source.mtlx (images named ../ramp.png, ../checker.png), baked.mtlx and the baked PNG, with the
# baked image path rewritten from the absolute path the baker writes to the bare file name.
import os, re, struct, subprocess, sys, zlib
import MaterialX

out = os.path.abspath(sys.argv[1])
os.makedirs(out, exist_ok=True)

def png(path, w, h, px):
    raw = b''.join(b'\x00' + bytes(sum((px(x, y) for x in range(w)), ())) for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
                chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

png(os.path.join(out, 'ramp.png'), 16, 16, lambda x, y: (x * 17, y * 17, 255 - x * 8))
png(os.path.join(out, 'checker.png'), 16, 16, lambda x, y: ((220, 40, 40) if (x // 4 + y // 4) % 2 else (30, 200, 90)))

HEAD = '<?xml version="1.0"?>\n<materialx version="1.39" colorspace="lin_rec709">\n'
MATERIAL = ('  <surfacematerial name="M" type="material">\n'
            '    <input name="surfaceshader" type="surfaceshader" nodename="SR" />\n  </surfacematerial>\n</materialx>\n')

def img(name, file, kind, space):
    cs = f' colorspace="{space}"' if space else ''
    return (f'  <image name="{name}" type="{kind}">\n    <input name="file" type="filename" value="../{file}"{cs} />\n'
            '  </image>\n')

def doc(name, graph, inputs, category='standard_surface'):
    """One material: `graph` is the node graph body, `inputs` the shader inputs; nodename of the graph output moves to
    the nodegraph's `out`."""
    node = re.search(r'nodename="(\w+)"', inputs).group(1)
    body = ''.join('  ' + line + '\n' for line in graph.rstrip('\n').split('\n'))
    text = HEAD + '  <nodegraph name="NG">\n' + body
    text += f'    <output name="out" type="color3" nodename="{node}" />\n  </nodegraph>\n'
    text += f'  <{category} name="SR" type="surfaceshader">\n'
    text += inputs.replace(f'nodename="{node}"', 'nodegraph="NG" output="out"') + f'  </{category}>\n' + MATERIAL
    folder = os.path.join(out, name)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'source.mtlx'), 'w', newline='\n') as f:
        f.write(text)
    return folder

base = '    <input name="base" type="float" value="1" />\n'
color = lambda node: f'    <input name="base_color" type="color3" nodename="{node}" />\n'
cases = [
    doc('image-srgb', img('tex', 'ramp.png', 'color3', 'srgb_texture'), base + color('tex')),
    doc('image-linear', img('tex', 'ramp.png', 'color3', ''), base + color('tex')),
    doc('multiply', img('tex', 'ramp.png', 'color3', 'srgb_texture') +
        '  <multiply name="mul" type="color3">\n    <input name="in1" type="color3" nodename="tex" />\n'
        '    <input name="in2" type="color3" value="0.5, 0.8, 0.3" />\n  </multiply>\n', base + color('mul')),
    doc('add-subtract', img('a', 'ramp.png', 'color3', 'srgb_texture') + img('b', 'checker.png', 'color3', 'srgb_texture') +
        # Scaled so every texel stays within 0 to 1: an 8-bit bake cannot hold a colour outside that range.
        '  <multiply name="dim" type="color3">\n    <input name="in1" type="color3" nodename="a" />\n'
        '    <input name="in2" type="float" value="0.8" />\n  </multiply>\n'
        '  <add name="sum" type="color3">\n    <input name="in1" type="color3" nodename="dim" />\n'
        '    <input name="in2" type="color3" value="0.1, 0.1, 0.1" />\n  </add>\n'
        '  <multiply name="faint" type="color3">\n    <input name="in1" type="color3" nodename="b" />\n'
        '    <input name="in2" type="float" value="0.1" />\n  </multiply>\n'
        '  <subtract name="diff" type="color3">\n    <input name="in1" type="color3" nodename="sum" />\n'
        '    <input name="in2" type="color3" nodename="faint" />\n  </subtract>\n', base + color('diff')),
    doc('mix', img('a', 'ramp.png', 'color3', 'srgb_texture') + img('b', 'checker.png', 'color3', 'srgb_texture') +
        img('m', 'ramp.png', 'float', '') +
        '  <mix name="blend" type="color3">\n    <input name="fg" type="color3" nodename="a" />\n'
        '    <input name="bg" type="color3" nodename="b" />\n    <input name="mix" type="float" nodename="m" />\n'
        '  </mix>\n', base + color('blend')),
    doc('weight', img('tex', 'checker.png', 'color3', 'srgb_texture'),
        '    <input name="base" type="float" value="0.6" />\n' + color('tex')),
    doc('gltf-image', '  <gltf_image name="tex" type="color3">\n'
        '    <input name="file" type="filename" value="../checker.png" colorspace="srgb_texture" />\n  </gltf_image>\n',
        color('tex'), 'gltf_pbr'),
    doc('preview-image', img('tex', 'ramp.png', 'color3', 'srgb_texture'),
        '    <input name="diffuseColor" type="color3" nodename="tex" />\n', 'UsdPreviewSurface'),
]

baker = os.path.join(os.path.dirname(MaterialX.__file__), '_scripts', 'baketextures.py')
for folder in cases:
    baked = os.path.join(folder, 'baked.mtlx')
    # Positionals first: --path takes several values. The baker resolves ../ramp.png against the case folder.
    subprocess.run([sys.executable, '-I', baker, os.path.join(folder, 'source.mtlx'), baked, '--width', '16',
                    '--height', '16', '--path', folder], check=True)
    with open(baked) as f:
        text = f.read()
    text = re.sub(r'value="[^"]*[\\/]([^\\/"]+\.png)"', r'value="\1"', text)
    with open(baked, 'w', newline='\n') as f:
        f.write(text)
    print(os.path.basename(folder), 'baked')
