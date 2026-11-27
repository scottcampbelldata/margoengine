"""Runs a Python download script with the network and file writes refused, and its data libraries stubbed.

python -I refuse_downloads.py <script> [arguments]. A refused call prints REFUSED and raises, so a script that ignores
its arguments fails the test without downloading or writing anything. The libraries are stubbed so that the check does
not depend on which of them are installed.
"""
import builtins
import importlib.abc
import importlib.machinery
import pathlib
import runpy
import socket
import sys
import types
import urllib.request
from unittest.mock import MagicMock

STUBBED = {'aiohttp', 'fsspec', 'netCDF4', 'nibabel', 'numpy', 'pyarrow', 'tifffile', 'xarray', 'yt'}


def refuse(what):
    def refused(*args, **kwargs):
        print('REFUSED ' + what, file=sys.stderr, flush=True)
        raise RuntimeError('REFUSED ' + what)

    return refused


class Stubs(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in STUBBED:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        return None

    def create_module(self, spec):
        module = types.ModuleType(spec.name)
        module.__getattr__ = lambda attribute: MagicMock(name=spec.name + '.' + attribute)
        return module

    def exec_module(self, module):
        pass


def read_only(opener):
    def checked(file, mode='r', *args, **kwargs):
        if set(mode) & set('wax+'):
            refuse('open for writing')()
        return opener(file, mode, *args, **kwargs)

    return checked


sys.meta_path.insert(0, Stubs())
urllib.request.urlopen = refuse('urlopen')
socket.socket.connect = refuse('socket connect')
socket.create_connection = refuse('socket connection')
socket.getaddrinfo = refuse('DNS lookup')
builtins.open = read_only(builtins.open)
for name in ('mkdir', 'write_bytes', 'write_text'):
    setattr(pathlib.Path, name, refuse('Path.' + name))
script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(script, run_name='__main__')
