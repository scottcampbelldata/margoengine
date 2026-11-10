"""Margo figures for notebooks: scatter, line, surface, volume and isosurface layers drawn by Margo Engine in the
browser (WebGPU), fed with NumPy arrays, pandas and Polars columns and xarray DataArrays as binary buffers.

A figure is a widget. Its state is a plot specification: theme, axes and a list of layers, each array stored as
float32 bytes plus its shape. The JavaScript side (``@margoengine/jupyter``) turns the specification into a
``@margoengine/sciviz`` figure. ``save_html`` writes the same specification into one self-contained HTML file.
"""

from __future__ import annotations

import array
import base64
import html
import json
import math
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from ._arrays import Encoded, column, encode, extent, frame, is_labeled, label, labeled_grid
from traitlets import Any as AnyTrait, Dict as DictTrait, Enum, HasTraits, TraitError, observe, validate

from ._widget import WidgetModel, split_buffers

__all__ = ["Figure", "COLORMAPS"]

#: The built-in colour map names (see ``@margoengine/sciviz``).
COLORMAPS = (
    "lab-linear-blue-yellow",
    "lab-diverging-blue-red",
    "lab-cyclic-diamond",
    "lab-isoluminant-hue",
    "aurora",
    "ember",
    "glacier",
    "gray",
    "cubehelix",
    "coolwarm",
    "phase",
    "viridis",
    "magma",
    "inferno",
    "plasma",
    "cividis",
)

Range = Tuple[float, float]


def _range(value: Optional[Sequence[float]], name: str) -> Optional[List[float]]:
    if value is None:
        return None
    lo, hi = (float(v) for v in value)
    if not (math.isfinite(lo) and math.isfinite(hi) and hi > lo):
        raise ValueError(f"{name} must be finite (min, max) with min < max, got ({lo}, {hi})")
    return [lo, hi]


def _colormap(name: Optional[Union[str, Sequence[str]]]) -> Union[str, List[str]]:
    if name is None:
        return "aurora"
    if isinstance(name, str):
        if name not in COLORMAPS:
            raise ValueError(f"unknown colormap {name!r}; use one of {', '.join(COLORMAPS)} or a list of '#rrggbb' stops")
        return name
    stops = [str(s) for s in name]
    if len(stops) < 2:
        raise ValueError("a custom colormap needs at least two '#rrggbb' stops")
    return stops


def _array(value: Any, name: str) -> Dict[str, Any]:
    encoded = encode(value, name=name)
    return {**encoded.descriptor(), "buffer": encoded.data}


class Figure(HasTraits):
    """A 3D figure. Add layers with :meth:`scatter`, :meth:`line`, :meth:`surface`, :meth:`volume`,
    :meth:`isosurface` and :meth:`colorbar` (each returns the figure, so calls chain). The figure shows itself as the
    last expression of a notebook cell; :meth:`save_html` writes a standalone page.

    Args:
        theme: ``"dark"`` (default) or ``"light"``.
        height: CSS height of the view in pixels. Default 480.
        aspect: Relative size of the plot box (x, y, z). Default (1, 1, 0.75).
        titles: Axis titles as a dict with ``x``, ``y`` and ``z``.
        axes: Draw axes, grid and tick labels. Default True.
        point_budget: Most scatter points drawn per frame. Default 2,000,000.
    """

    def __init__(
        self,
        *,
        theme: str = "dark",
        height: int = 480,
        aspect: Sequence[float] = (1.0, 1.0, 0.75),
        titles: Optional[Dict[str, str]] = None,
        axes: bool = True,
        point_budget: int = 2_000_000,
        comm_factory: Optional[Callable[..., Any]] = None,
    ):
        if theme not in ("dark", "light"):
            raise ValueError(f"theme must be 'dark' or 'light', got {theme!r}")
        if not (isinstance(height, int) and 100 <= height <= 4000):
            raise ValueError(f"height must be a whole number of pixels from 100 to 4000, got {height!r}")
        aspect = [float(a) for a in aspect]
        if len(aspect) != 3 or not all(a > 0 and math.isfinite(a) for a in aspect):
            raise ValueError("aspect must be three positive numbers")
        self._spec: Dict[str, Any] = {
            "version": 1,
            "theme": theme,
            "height": height,
            "aspect": aspect,
            "titles": dict(titles or {}),
            "axes": bool(axes),
            "pointBudget": int(point_budget),
            "layers": [],
            "colorbars": [],
        }
        super().__init__()
        self._receiving = False
        self._model = WidgetModel({"spec": self._spec, "camera": None, "drag_mode": "orbit"}, comm_factory=comm_factory)
        self._model.on_update(self._from_frontend)
        self._model.on_custom(self._event)
        self._click_callbacks: List[Callable[[Dict[str, Any]], None]] = []
        self._select_callbacks: List[Callable[[Dict[int, Any]], None]] = []

    # ----- camera -----

    camera = DictTrait(
        help="The view's camera in scene units (the plot box spans about -1 to 1): position, target, up and fov "
        "(vertical field of view in degrees). The view reports it as you orbit, pan and zoom; set it (all or some "
        "parts) to move the view. Watch it with fig.observe(callback, names='camera')."
    )

    @validate("camera")
    def _check_camera(self, proposal: Any) -> Dict[str, Any]:
        value = proposal["value"]
        unknown = set(value) - {"position", "target", "up", "fov"}
        if unknown:
            raise TraitError(f"camera takes position, target, up and fov, not {', '.join(sorted(unknown))}")
        merged: Dict[str, Any] = dict(self.camera or {})
        for key in ("position", "target", "up"):
            if key in value:
                vector = [float(v) for v in value[key]]
                if len(vector) != 3 or not all(math.isfinite(v) for v in vector):
                    raise TraitError(f"camera {key} must be three finite numbers, got {value[key]!r}")
                merged[key] = vector
        if "fov" in value:
            fov = float(value["fov"])
            if not 0 < fov < 180:
                raise TraitError(f"camera fov must be between 0 and 180 degrees, got {fov}")
            merged["fov"] = fov
        if "position" in merged and merged.get("position") == merged.get("target"):
            raise TraitError("camera position and target must differ")
        return merged

    @observe("camera")
    def _send_camera(self, change: Any) -> None:
        # A camera the view reported is already there; one set from Python moves the view.
        if not self._receiving:
            self._model.set(camera=change["new"])

    def _from_frontend(self, changes: Dict[str, Any]) -> None:
        if changes.get("camera"):
            self._receiving = True
            try:
                self.camera = changes["camera"]
            finally:
                self._receiving = False

    # ----- clicks and selections -----

    drag_mode = Enum(
        ("orbit", "box", "lasso"),
        default_value="orbit",
        help="What a left-button drag does: 'orbit' the camera (default), or select points in a 'box' or 'lasso'.",
    )

    selection = AnyTrait(
        None,
        allow_none=True,
        help="The last box or lasso selection: {layer index: indices of its points inside the region} (NumPy uint32 "
        "arrays when NumPy is installed), or None.",
    )

    @observe("drag_mode")
    def _send_drag_mode(self, change: Any) -> None:
        self._model.set(drag_mode=change["new"])

    def on_click(self, callback: Callable[[Dict[str, Any]], None], remove: bool = False) -> "Figure":
        """Calls ``callback(event)`` when the view is clicked (pressed and released without dragging).

        ``event`` has ``x`` and ``y`` (CSS pixels from the view's top-left), ``button``, ``modifiers`` (``shift``,
        ``ctrl``, ``alt``, ``meta``) and ``hit``: None, or the scatter point, line vertex or surface point under the
        pointer as ``{"layer": layer index, "index": point index, "point": [x, y, z], "value": colour value}``.
        ``remove=True`` unregisters ``callback``.
        """
        self._register(self._click_callbacks, callback, remove)
        return self

    def on_select(self, callback: Callable[[Dict[int, Any]], None], remove: bool = False) -> "Figure":
        """Calls ``callback(selection)`` when a box or lasso selection ends (see :attr:`drag_mode`), with the same
        value as :attr:`selection`. ``remove=True`` unregisters ``callback``."""
        self._register(self._select_callbacks, callback, remove)
        return self

    @staticmethod
    def _register(callbacks: List[Any], callback: Any, remove: bool) -> None:
        if not callable(callback):
            raise TypeError(f"callback must be callable, got {type(callback).__name__}")
        if remove:
            if callback in callbacks:
                callbacks.remove(callback)
        else:
            callbacks.append(callback)

    def _event(self, content: Any, buffers: List[Any]) -> None:
        # Custom messages from the view: clicks, and selections with one uint32 buffer of point indices per layer.
        if not isinstance(content, dict):
            return
        if content.get("event") == "click":
            event = {key: content.get(key) for key in ("x", "y", "button", "modifiers", "hit")}
            for callback in list(self._click_callbacks):
                callback(event)
        elif content.get("event") == "selection":
            layers = content.get("layers", [])
            if len(layers) != len(buffers):
                raise ValueError(f"selection names {len(layers)} layers but carries {len(buffers)} buffers")
            selection = {int(layer): _indices(buffer) for layer, buffer in zip(layers, buffers)}
            self.selection = selection
            for callback in list(self._select_callbacks):
                callback(selection)

    # ----- layers -----

    def _push(self, layer: Dict[str, Any]) -> "Figure":
        self._spec["layers"].append(layer)
        self._sync()
        return self

    def _sync(self) -> None:
        # One update with the whole specification keeps the frontend's layer list in step.
        self._model.set(spec=self._spec)

    def scatter(
        self,
        data: Any = None,
        *,
        x: Any,
        y: Any,
        z: Any = None,
        color: Any = None,
        size: Any = None,
        colormap: Optional[Union[str, Sequence[str]]] = None,
        range: Optional[Range] = None,
        point_size: Optional[float] = None,
        edl: bool = False,
        colorbar: Optional[str] = None,
    ) -> "Figure":
        """A scatter plot. ``x``, ``y``, ``z``, ``color`` and ``size`` are arrays or column names of ``data``
        (a pandas or Polars DataFrame or LazyFrame, an xarray Dataset, or a dict of arrays). Millions of points draw with level of detail.

        ``colorbar`` adds a colour bar with that title for the ``color`` values.
        """
        layer: Dict[str, Any] = {"type": "scatter", "colormap": _colormap(colormap), "edl": bool(edl)}
        columns = {"x": x, "y": y, "z": z, "color": color, "size": size}
        data = frame(data, list(columns.values()))
        lengths = set()
        for key, value in columns.items():
            value = column(data, value, key)
            if value is None:
                continue
            encoded = encode(value, name=key)
            if len(encoded.shape) != 1:
                raise ValueError(f"scatter {key} must be one-dimensional, got shape {encoded.shape}")
            lengths.add(encoded.shape[0])
            layer[key] = {**encoded.descriptor(), "buffer": encoded.data}
            if key == "color":
                colour_range = _range(range, "range") or list(extent(encoded))
                layer["range"] = colour_range
        if len(lengths) > 1:
            raise ValueError(f"scatter columns differ in length: {sorted(lengths)}")
        if point_size is not None:
            if not (point_size > 0):
                raise ValueError(f"point_size must be positive, got {point_size}")
            layer["pointSize"] = float(point_size)
        self._push(layer)
        if colorbar is not None and "range" in layer:
            self.colorbar(layer["colormap"], layer["range"], label=colorbar)
        return self

    def line(
        self,
        data: Any = None,
        *,
        x: Any,
        y: Any,
        z: Any = None,
        color: Any = None,
        colormap: Optional[Union[str, Sequence[str]]] = None,
        range: Optional[Range] = None,
        width: float = 2.0,
    ) -> "Figure":
        """A line through the points (x, y, z), optionally coloured by ``color`` values."""
        layer: Dict[str, Any] = {"type": "line", "colormap": _colormap(colormap), "width": float(width)}
        columns = {"x": x, "y": y, "z": z, "color": color}
        data = frame(data, list(columns.values()))
        for key, value in columns.items():
            value = column(data, value, key)
            if value is not None:
                encoded = encode(value, name=key)
                layer[key] = {**encoded.descriptor(), "buffer": encoded.data}
                if key == "color":
                    layer["range"] = _range(range, "range") or list(extent(encoded))
        return self._push(layer)

    def surface(
        self,
        z: Any,
        *,
        x: Optional[Range] = None,
        y: Optional[Range] = None,
        colormap: Optional[Union[str, Sequence[str]]] = None,
        range: Optional[Range] = None,
        contours: int = 10,
        colorbar: Optional[str] = None,
    ) -> "Figure":
        """A surface plot of a 2D array of heights ``z[row][column]`` over the ``x`` (columns) and ``y`` (rows) ranges.
        NaN heights leave holes.

        An xarray DataArray brings its own ranges (from the coordinates of its two dimensions, rows first) and axis
        titles; ``x`` and ``y`` override the ranges."""
        spans: List[Any] = [None, None]
        if is_labeled(z):
            z, spans, names = labeled_grid(z, "surface z", ranges=x is None or y is None)
            self._default_titles(x=names[-1], y=names[0])
        encoded = encode(z, name="z")
        if len(encoded.shape) != 2 or min(encoded.shape) < 2:
            raise ValueError(f"surface z must be a 2D array of at least 2 x 2, got shape {encoded.shape}")
        ny, nx = encoded.shape
        heights = _range(range, "range") or list(extent(encoded))
        if heights[0] == heights[1]:
            heights = [heights[0] - 0.5, heights[1] + 0.5]
        layer = {
            "type": "surface",
            "z": {**encoded.descriptor(), "buffer": encoded.data},
            "x": _range(x, "x") or _range(spans[-1], "x") or [0.0, float(nx - 1)],
            "y": _range(y, "y") or _range(spans[0], "y") or [0.0, float(ny - 1)],
            "colormap": _colormap(colormap),
            "range": heights,
            "contours": int(contours),
        }
        self._push(layer)
        if colorbar is not None:
            self.colorbar(layer["colormap"], heights, label=colorbar)
        return self

    def volume(
        self,
        values: Any,
        *,
        bounds: Optional[Sequence[float]] = None,
        colormap: Optional[Union[str, Sequence[str]]] = None,
        range: Optional[Range] = None,
        opacity: Optional[Sequence[Sequence[float]]] = None,
        density: float = 1.0,
        mode: str = "composite",
        colorbar: Optional[str] = None,
    ) -> "Figure":
        """A volume rendering of a 3D array ``values[z][y][x]``.

        ``opacity`` maps normalised values to opacity as ``[(t, alpha), ...]`` (default rising as t squared);
        ``mode`` is ``"composite"`` or ``"mip"`` (maximum intensity). An xarray DataArray with dimensions in
        (z, y, x) order brings its bounds from its coordinates, and its axis titles; ``bounds`` overrides them.
        """
        values, coord_bounds = self._grid(values, "volume values", bounds)
        encoded = encode(values, name="values")
        if len(encoded.shape) != 3 or min(encoded.shape) < 2:
            raise ValueError(f"volume values must be a 3D array of at least 2 x 2 x 2, got shape {encoded.shape}")
        if mode not in ("composite", "mip"):
            raise ValueError(f"mode must be 'composite' or 'mip', got {mode!r}")
        nz, ny, nx = encoded.shape
        data_range = _range(range, "range") or list(extent(encoded))
        layer: Dict[str, Any] = {
            "type": "volume",
            "values": {**encoded.descriptor(), "buffer": encoded.data},
            "dims": [nx, ny, nz],
            "colormap": _colormap(colormap),
            "range": data_range,
            "density": float(density),
            "mode": mode,
        }
        if bounds is not None or coord_bounds is not None:
            layer["bounds"] = self._bounds(bounds if bounds is not None else coord_bounds)
        if opacity is not None:
            layer["opacity"] = [[float(t), float(a)] for t, a in opacity]
        self._push(layer)
        if colorbar is not None:
            self.colorbar(layer["colormap"], data_range, label=colorbar)
        return self

    def isosurface(
        self,
        values: Any,
        level: float,
        *,
        bounds: Optional[Sequence[float]] = None,
        color: Optional[str] = None,
    ) -> "Figure":
        """An isosurface of a 3D array ``values[z][y][x]`` at ``level``, extracted by marching cubes on the GPU.
        An xarray DataArray brings its bounds and axis titles, as in :meth:`volume`."""
        values, coord_bounds = self._grid(values, "isosurface values", bounds)
        encoded = encode(values, name="values")
        if len(encoded.shape) != 3 or min(encoded.shape) < 2:
            raise ValueError(f"isosurface values must be a 3D array, got shape {encoded.shape}")
        if not math.isfinite(level):
            raise ValueError(f"level must be finite, got {level}")
        nz, ny, nx = encoded.shape
        layer: Dict[str, Any] = {
            "type": "isosurface",
            "values": {**encoded.descriptor(), "buffer": encoded.data},
            "dims": [nx, ny, nz],
            "level": float(level),
        }
        if bounds is not None or coord_bounds is not None:
            layer["bounds"] = self._bounds(bounds if bounds is not None else coord_bounds)
        if color is not None:
            layer["color"] = str(color)
        return self._push(layer)

    def colorbar(self, colormap: Union[str, Sequence[str]], range: Range, *, label: Optional[str] = None) -> "Figure":
        """A colour bar for ``colormap`` over ``range``."""
        bar: Dict[str, Any] = {"colormap": _colormap(colormap), "range": _range(range, "range")}
        if label is not None:
            bar["label"] = str(label)
        self._spec["colorbars"].append(bar)
        self._sync()
        return self

    def _grid(self, values: Any, name: str, bounds: Optional[Sequence[float]]) -> Tuple[Any, Optional[List[float]]]:
        # A 3D DataArray (z, y, x): its values, its bounds from the coordinates (index units where one is missing)
        # and its dimension titles for the axes the figure has not titled.
        if not is_labeled(values):
            return values, None
        if len(values.dims) != 3:
            raise ValueError(f"{name} must be a 3D DataArray, got dimensions {tuple(values.dims)}")
        array, spans, names = labeled_grid(values, name, ranges=bounds is None)
        self._default_titles(x=names[2], y=names[1], z=names[0])
        if bounds is not None:
            return array, None
        nz, ny, nx = array.shape
        sx, sy, sz = (s or (0.0, float(n - 1)) for s, n in zip(spans[::-1], (nx, ny, nz)))
        return array, [*sx, *sy, *sz]

    def _default_titles(self, **titles: str) -> None:
        # Axis titles from labelled data fill in only the axes the caller left untitled.
        for axis, title in titles.items():
            self._spec["titles"].setdefault(axis, title)

    @staticmethod
    def _bounds(bounds: Sequence[float]) -> List[float]:
        b = [float(v) for v in bounds]
        if len(b) != 6 or not all(math.isfinite(v) for v in b) or b[1] < b[0] or b[3] < b[2] or b[5] < b[4]:
            raise ValueError("bounds must be (xmin, xmax, ymin, ymax, zmin, zmax) with each min <= max")
        return b

    # ----- display and export -----

    @property
    def spec(self) -> Dict[str, Any]:
        """The plot specification (arrays as descriptors with their bytes under ``buffer``)."""
        return self._spec

    @property
    def widget(self) -> WidgetModel:
        """The widget model (for listening to frontend events)."""
        return self._model

    def _repr_mimebundle_(self, include: Any = None, exclude: Any = None) -> Dict[str, Any]:
        if _in_colab():
            # Colab's widget manager loads third-party widget code only from npm, where @margoengine/jupyter is not
            # published: Colab gets the figure as an inline page instead (it draws and orbits; no events reach Python).
            return {"text/html": self._inline_html(), "text/plain": "<Margo figure>"}
        return self._model.mimebundle()

    def show(self) -> None:
        """Displays the figure (in a notebook cell, without being its last expression)."""
        from IPython.display import display  # Present in every Jupyter kernel.

        display(self._repr_mimebundle_(), raw=True)

    def _payload(self) -> str:
        # The specification with its arrays as base64, and the camera, as JSON safe inside a <script> element.
        state, paths, buffers = split_buffers(self._spec)
        payload = {
            "spec": state,
            "bufferPaths": paths,
            "camera": dict(self.camera) or None,
            "buffers": [base64.b64encode(bytes(b)).decode("ascii") for b in buffers],
        }
        return json.dumps(payload, separators=(",", ":")).replace("</", "<\\/")

    def _inline_html(self) -> str:
        """The figure as an HTML fragment (frontend bundle and data inline) for notebook outputs without the widget."""
        host = f"margo-{id(self):x}-{len(self._spec['layers'])}"
        return (
            f'<div id="{host}" style="position:relative;width:100%;height:{self._spec["height"]}px"></div>\n'
            f"<script>{_frontend_bundle()}</script>\n"
            f"<script>MargoFigure.renderPayload(document.getElementById({json.dumps(host)}), {self._payload()});</script>"
        )

    def to_html(self, *, title: str = "Margo figure") -> str:
        """A self-contained HTML page with the figure: the frontend bundle inline, arrays as base64."""
        bundle = _frontend_bundle()
        data = self._payload()
        return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{margin:0;background:{'#0f141c' if self._spec['theme'] == 'dark' else '#ffffff'}}}#figure{{position:relative;width:100vw;height:100vh}}</style></head>
<body><div id="figure"></div>
<script type="application/json" id="margo-spec">{data}</script>
<script>{bundle}</script>
<script>
window.margoFigure = MargoFigure.renderPayload(document.getElementById('figure'), JSON.parse(document.getElementById('margo-spec').textContent));
</script>
</body>
</html>
"""

    def save_html(self, path: Union[str, Path], *, title: str = "Margo figure") -> Path:
        """Writes :meth:`to_html` to ``path`` and returns the path. Opens in any WebGPU browser, no server needed."""
        target = Path(path)
        target.write_text(self.to_html(title=title), encoding="utf-8")
        return target

    def to_png(
        self,
        path: Union[str, Path],
        *,
        width: int = 960,
        height: Optional[int] = None,
        scale: float = 1.0,
        browser: Optional[str] = None,
        timeout: float = 60.0,
    ) -> Path:
        """Writes a PNG image of the figure to ``path`` and returns the path.

        The figure is drawn with WebGPU in a headless Chrome, Edge or Chromium (found automatically, or ``browser`` /
        ``$MARGO_BROWSER``), from the same page :meth:`save_html` writes; no Python packages are needed.

        Args:
            width: Image width in CSS pixels. Default 960.
            height: Image height in CSS pixels. Default the figure's height.
            scale: Device pixel ratio; 2 gives an image twice as wide and tall. Default 1.
            browser: Browser executable name or path. Default: an installed Chrome, Edge or Chromium.
            timeout: Seconds to wait for the browser and the drawing. Default 60.
        """
        from ._png import render_png

        height = self._spec["height"] if height is None else height
        for name, value in (("width", width), ("height", height)):
            if not (isinstance(value, int) and 16 <= value <= 8192):
                raise ValueError(f"{name} must be a whole number of pixels from 16 to 8192, got {value!r}")
        if not (isinstance(scale, (int, float)) and 0.25 <= scale <= 4):
            raise ValueError(f"scale must be from 0.25 to 4, got {scale!r}")
        png = render_png(self.to_html(), width=width, height=height, scale=float(scale), browser=browser, timeout=float(timeout))
        target = Path(path)
        target.write_bytes(png)
        return target


def _indices(buffer: Any) -> Any:
    # Little-endian uint32 point indices: a NumPy array when NumPy is loaded, else an array.array('I').
    raw = bytes(buffer)
    np = sys.modules.get("numpy")
    if np is not None:
        return np.frombuffer(raw, dtype="<u4").copy()
    out = array.array("I")
    out.frombytes(raw)
    if sys.byteorder == "big":
        out.byteswap()
    return out


def _in_colab() -> bool:
    # Colab kernels have imported google.colab by the time a cell runs.
    return "google.colab" in sys.modules


def _frontend_bundle(folder: Optional[Path] = None) -> str:
    bundle = (folder or Path(__file__).parent) / "static" / "margo-figure.iife.js"
    if not bundle.exists():
        raise FileNotFoundError(
            f"The Margo frontend bundle is missing ({bundle}); build it with "
            "`node python/build-frontend.mjs` in the Margo Engine repository"
        )
    return bundle.read_text(encoding="utf-8")
