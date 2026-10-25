"""Margo Engine for notebooks: GPU plots of NumPy arrays and pandas DataFrames in Jupyter.

    import margoengine as margo
    margo.scatter(df, x="lon", y="lat", z="depth", color="magnitude")
    margo.volume(ct_scan)
    margo.surface(z)

Arrays travel to the browser as binary float32 buffers over the Jupyter widget protocol (never as JSON), and Margo
Engine draws them with WebGPU: millions of points, volumes, surfaces and isosurfaces.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence, Union

from ._figure import COLORMAPS, Figure

__all__ = ["Figure", "COLORMAPS", "figure", "scatter", "line", "surface", "volume", "isosurface", "__version__"]

__version__ = "1.0.0"


def figure(**options: Any) -> Figure:
    """A new empty figure (see :class:`Figure` for the options)."""
    return Figure(**options)


def scatter(data: Any = None, *, x: Any, y: Any, z: Any = None, color: Any = None, size: Any = None, colormap: Optional[Union[str, Sequence[str]]] = None, **options: Any) -> Figure:
    """A figure with one scatter layer (and a colour bar when ``color`` is given). Columns may be names in ``data``."""
    layer_keys = {"range", "point_size", "edl"}
    layer = {k: options.pop(k) for k in list(options) if k in layer_keys}
    fig = Figure(**options)
    label = color if isinstance(color, str) else ("color" if color is not None else None)
    return fig.scatter(data, x=x, y=y, z=z, color=color, size=size, colormap=colormap, colorbar=label, **layer)


def line(data: Any = None, *, x: Any, y: Any, z: Any = None, color: Any = None, **options: Any) -> Figure:
    """A figure with one line layer."""
    layer_keys = {"colormap", "range", "width"}
    layer = {k: options.pop(k) for k in list(options) if k in layer_keys}
    return Figure(**options).line(data, x=x, y=y, z=z, color=color, **layer)


def surface(z: Any, **options: Any) -> Figure:
    """A figure with one surface plot of the 2D array ``z`` and its colour bar."""
    layer_keys = {"x", "y", "colormap", "range", "contours"}
    layer = {k: options.pop(k) for k in list(options) if k in layer_keys}
    return Figure(**options).surface(z, colorbar="z", **layer)


def volume(values: Any, **options: Any) -> Figure:
    """A figure with one volume rendering of the 3D array ``values`` and its colour bar."""
    layer_keys = {"bounds", "colormap", "range", "opacity", "density", "mode"}
    layer = {k: options.pop(k) for k in list(options) if k in layer_keys}
    return Figure(**options).volume(values, colorbar="value", **layer)


def isosurface(values: Any, level: float, **options: Any) -> Figure:
    """A figure with one isosurface of the 3D array ``values`` at ``level``."""
    layer_keys = {"bounds", "color"}
    layer = {k: options.pop(k) for k in list(options) if k in layer_keys}
    return Figure(**options).isosurface(values, level, **layer)
