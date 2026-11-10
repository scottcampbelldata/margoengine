"""A thin anywidget view of the web figure spec. Rendering remains entirely in JavaScript."""
from __future__ import annotations

import base64
import copy
import hashlib
import html
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Union

import anywidget
import traitlets

_STATIC = Path(__file__).parent / "static" / "sciviz-notebook.js"
_DTYPES = {"?": "Uint8Array", "b": "Int8Array", "B": "Uint8Array", "h": "Int16Array", "H": "Uint16Array",
           "i": "Int32Array", "I": "Uint32Array", "e": "Float16Array", "f": "Float32Array", "d": "Float64Array"}


def _buffer(value: Any) -> tuple[memoryview, str]:
    # Arrow's to_numpy returns a borrowed numeric buffer when null-free and unchunked.
    if type(value).__module__.split(".")[0] == "pyarrow":
        if getattr(value, "num_chunks", 0) == 1:
            value = value.chunk(0)
        value = value.to_numpy(zero_copy_only=value.null_count == 0 and not hasattr(value, "chunks"))
    view = memoryview(value)
    fmt = view.format.lstrip("@=<>!")
    if fmt in ("l", "L") and view.itemsize == 4:
        fmt = "i" if fmt == "l" else "I"
    if fmt in ("q", "Q", "l", "L") and view.itemsize == 8:
        import numpy as np
        array = np.asarray(value)
        if array.size and (int(array.min()) < -(2**53) or int(array.max()) > 2**53):
            raise ValueError("SCIVIZ_NOTEBOOK: integers beyond exact JavaScript numbers need explicit conversion; https://margoengine.com/errors#sciviz")
        value = array.astype("<f8")
        view, fmt = memoryview(value), "d"
    if fmt not in _DTYPES or (fmt in ("i", "I") and view.itemsize != 4):
        raise TypeError("SCIVIZ_NOTEBOOK: use real numeric 8/16/32-bit integers or 16/32/64-bit floats; https://margoengine.com/errors#sciviz")
    big = view.format.startswith((">", "!")) or (sys.byteorder == "big" and not view.format.startswith("<"))
    if not view.c_contiguous or big:
        import numpy as np
        array = np.asarray(value)
        value = np.ascontiguousarray(array, dtype=array.dtype.newbyteorder("<"))
        view = memoryview(value)
    return view.cast("B"), _DTYPES[fmt]


class NotebookFigure(anywidget.AnyWidget):
    """Display any version-1 sciviz spec in JupyterLab, VS Code, Colab or an AFM host.

    ``spec`` defaults to an empty 3D figure; ``options`` supplies web FigureOptions.
    ``limits`` defaults to (0, 1, 0, 1, 0, 1), in the portable spec's plot coordinates.
    NumPy and Arrow numeric inputs to ``add`` travel as binary attachments. They are
    borrowed until changed; call ``refresh`` after modifying their contents in place.
    Observe ``camera`` and ``selection`` with the standard traitlets observer API.
    """
    _esm = _STATIC
    spec = traitlets.Dict().tag(sync=True)
    buffers = traitlets.Dict().tag(sync=True)
    camera = traitlets.Any(None, allow_none=True).tag(sync=True)
    selection = traitlets.Any(None, allow_none=True).tag(sync=True)
    height = traitlets.Int(480, min=100, max=4000).tag(sync=True)
    error = traitlets.Unicode("").tag(sync=True)
    backend = traitlets.Enum(("auto", "webgpu", "webgl2"), default_value="auto").tag(sync=True)

    def __init__(self, spec: Optional[Mapping[str, Any]] = None, *, options: Optional[Mapping[str, Any]] = None,
                 limits: Sequence[float] = (0, 1, 0, 1, 0, 1), height: int = 480, **kwargs: Any) -> None:
        initial = copy.deepcopy(dict(spec)) if spec is not None else {
            "version": 1, "options": dict(options or {}), "limits": list(limits), "dragMode": "orbit",
            "camera": {"position": [2.6, 1.7, 2.9], "target": [0, 0, 0], "up": [0, 1, 0], "fov": 45, "near": 0.01, "far": 100},
            "resources": [], "layers": [],
        }
        if initial.get("version") != 1:
            raise ValueError("SCIVIZ_NOTEBOOK: supply a version-1 FigureSpec; https://margoengine.com/errors#sciviz")
        super().__init__(spec=initial, height=height, **kwargs)

    def _encode(self, value: Any, buffers: Dict[str, memoryview]) -> Any:
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else {"$number": str(value).replace("nan", "NaN").replace("inf", "Infinity")}
        if isinstance(value, Mapping):
            return {str(key): self._encode(item, buffers) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._encode(item, buffers) for item in value]
        data, dtype = _buffer(value)
        key = f"b{len(buffers)}"
        buffers[key] = data
        return {"$array": dtype, "$buffer": key, "sha256": hashlib.sha256(data).hexdigest()}

    def add(self, kind: str, *args: Any, layer: bool = True) -> "NotebookFigure":
        """Append one web API recipe, e.g. ``add('scatter', {'x': x, 'y': y}, {'size': 4})``.

        Set ``layer=False`` for resources such as colorbars. Existing full specs may
        also be assigned directly; custom recipe implementations stay in the web host.
        """
        if not isinstance(kind, str) or not kind:
            raise TypeError("SCIVIZ_NOTEBOOK: supply a web figure method name; https://margoengine.com/errors#sciviz")
        spec, buffers = copy.deepcopy(self.spec), dict(self.buffers)
        ids = {r["id"] for r in spec["resources"]}
        index = 0
        while f"r{index}" in ids:
            index += 1
        resource_id = f"r{index}"
        spec.pop("sha256", None)
        spec["resources"].append({"id": resource_id, "kind": kind, "args": self._encode(args, buffers), "state": {}, "updates": []})
        if layer:
            spec["layers"].append(resource_id)
        with self.hold_sync():
            self.buffers, self.spec = buffers, spec
        return self

    def refresh(self) -> "NotebookFigure":
        """Rehash borrowed buffers after caller mutations and send current bytes over the comm."""
        spec = copy.deepcopy(self.spec)
        def visit(value: Any) -> None:
            if isinstance(value, dict):
                if "$buffer" in value:
                    value["sha256"] = hashlib.sha256(self.buffers[value["$buffer"]]).hexdigest()
                if "resources" in value and "version" in value:
                    value.pop("sha256", None)
                for item in value.values():
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)
        visit(spec)
        with self.hold_sync():
            self.spec = spec
            self.send_state(["spec", "buffers"])
        return self

    def to_spec(self) -> Dict[str, Any]:
        """Return portable JSON with inline array bytes, suitable for web Figure.fromJSON."""
        def visit(value: Any) -> Any:
            if isinstance(value, dict):
                if "$buffer" in value:
                    data = self.buffers[value["$buffer"]]
                    return {"$array": value["$array"], "bytes": base64.b64encode(data).decode("ascii"), "sha256": hashlib.sha256(data).hexdigest()}
                return {key: visit(item) for key, item in value.items() if not (key == "sha256" and "resources" in value)}
            if isinstance(value, list):
                return [visit(item) for item in value]
            return value
        result = visit(self.spec)
        if self.camera is not None:
            result["camera"] = copy.deepcopy(self.camera)
        if self.selection is not None:
            def selected(point: Mapping[str, Any]) -> Dict[str, Any]:
                import array
                indices = point["indices"]
                data = memoryview(array.array("I", indices)) if isinstance(indices, list) else memoryview(indices)
                data = data.cast("B")
                return {"layer": {"$ref": result["layers"][point["layer"]]},
                        "indices": {"$array": "Uint32Array", "bytes": base64.b64encode(data).decode("ascii"),
                                    "sha256": hashlib.sha256(data).hexdigest()}}
            result["selection"] = {"region": copy.deepcopy(self.selection["region"]),
                                   "points": [selected(point) for point in self.selection["points"]]}
        return result

    def to_html(self, *, title: str = "Margo scientific figure") -> str:
        """Return offline interactive HTML for Quarto or Observable; no live Python kernel is needed."""
        runtime = base64.b64encode(_STATIC.read_bytes()).decode("ascii")
        state = json.dumps({"spec": self.to_spec(), "buffers": {}, "camera": self.camera, "selection": self.selection,
                            "height": self.height, "backend": self.backend}, default=lambda value: list(memoryview(value).cast("B").cast("I"))).replace("<", "\\u003c")
        return (f'<!doctype html><html lang="en"><meta charset="utf-8"><title>{html.escape(title)}</title>'
                '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="figure"></div>'
                f'<script id="state" type="application/json">{state}</script><script type="module">'
                f'import {{render}} from "data:text/javascript;base64,{runtime}";'
                'const state=JSON.parse(document.getElementById("state").textContent), events=new Map();'
                'const model={get:k=>state[k],set:(k,v)=>{state[k]=v;for(const f of events.get("change:"+k)??[])f()},'
                'save_changes(){},on:(k,f)=>events.set(k,[...(events.get(k)??[]),f]),'
                'off:(k,f)=>events.set(k,(events.get(k)??[]).filter(x=>x!==f))};'
                'const dispose=await render({model,el:document.getElementById("figure")});'
                'addEventListener("pagehide",dispose,{once:true});</script></html>')

    def save_html(self, path: Union[str, Path], *, title: str = "Margo scientific figure") -> None:
        """Write a self-contained page. Runtime and data stay local; no publishing occurs."""
        Path(path).write_text(self.to_html(title=title), encoding="utf-8")
