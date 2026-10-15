"""Self-check for examples/assets/source/tokyo_diorama/polyhaven.py (run: python -I tests/tokyo_polyhaven_check.py).

A download that fails part-way must not leave a file in the cache: a cached empty or partial .jpg would be
treated as valid forever and bake as magenta.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'examples', 'assets', 'source', 'tokyo_diorama'))
import polyhaven  # noqa: E402

with tempfile.TemporaryDirectory() as cache:
    polyhaven.CACHE = cache
    api = json.dumps({'Diffuse': {'1k': {'jpg': {'url': 'https://dl.polyhaven.org/file/x_diff_1k.jpg'}}}}).encode()

    def failing(url):
        if 'api.polyhaven.com' in url:
            return api
        raise TimeoutError('network dropped mid-download')

    polyhaven._get = failing
    try:
        polyhaven.texture('x')
    except TimeoutError:
        pass
    leftovers = os.listdir(cache)
    assert leftovers == [], 'failed download left files in the cache: %r' % leftovers

    polyhaven._get = lambda url: api if 'api.polyhaven.com' in url else b''
    try:
        polyhaven.texture('x')
        raise AssertionError('an empty download was accepted')
    except ValueError:
        pass
    assert os.listdir(cache) == [], 'empty download left files in the cache'

    polyhaven._get = lambda url: api if 'api.polyhaven.com' in url else b'\xff\xd8jpeg-bytes'
    paths = polyhaven.texture('x')
    assert set(paths) == {'diff'} and open(paths['diff'], 'rb').read() == b'\xff\xd8jpeg-bytes'
print('polyhaven cache check passed')
