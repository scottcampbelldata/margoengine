"""Fetch CC0 textures from Poly Haven (https://polyhaven.com) into a git-ignored cache next to the build script."""
import json
import os
import urllib.request

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'textures')
MAPS = {'diff': 'Diffuse'}  # the bake only samples base colour


def texture(asset, resolution='1k'):
    """Return {'diff': path} for a Poly Haven texture, downloading as needed."""
    os.makedirs(CACHE, exist_ok=True)
    paths = {short: os.path.join(CACHE, '%s_%s_%s.jpg' % (asset, short, resolution)) for short in MAPS}
    if all(os.path.exists(p) for p in paths.values()):
        return paths
    files = json.loads(_get('https://api.polyhaven.com/files/%s' % asset))
    for short, key in MAPS.items():
        if not os.path.exists(paths[short]):
            url = files[key][resolution]['jpg']['url']
            if not url.startswith('https://dl.polyhaven.org/'):
                raise ValueError('unexpected Poly Haven download host: ' + url)
            data = _get(url)  # fully in memory before anything touches the cache
            if not data:
                raise ValueError('empty download: ' + url)
            partial = paths[short] + '.part'
            with open(partial, 'wb') as out:
                out.write(data)
            os.replace(partial, paths[short])  # atomic: the cache never holds a truncated texture
    return paths


def _get(url):
    # Poly Haven asks API clients to identify themselves; the default urllib agent is refused.
    request = urllib.request.Request(url, headers={'User-Agent': 'margo-engine-tokyo-diorama/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


if __name__ == '__main__':
    for name in ('rusty_painted_metal', 'green_metal_rust', 'metal_plate', 'rust_coarse_01'):
        print(name, texture(name))
