"""Arrays to binary buffers for the widget protocol.

NumPy arrays, pandas and Polars Series and DataFrame columns, xarray DataArrays, ``array.array``, memoryviews and
plain lists all become a little-endian float32 buffer plus its shape. Nothing is converted to JSON: the buffer travels as a binary
attachment of the comm message, and the browser reads it as a Float32Array without parsing.
"""

from __future__ import annotations

import array
import math
import sys
from typing import Any, Sequence, Tuple

__all__ = ["Encoded", "encode", "column", "extent", "frame", "is_labeled", "labeled_grid"]


class Encoded:
    """A float32 buffer with its shape (row-major, last axis fastest)."""

    __slots__ = ("data", "shape")

    def __init__(self, data: memoryview, shape: Tuple[int, ...]):
        self.data = data
        self.shape = shape

    @property
    def size(self) -> int:
        """Number of elements."""
        return math.prod(self.shape)

    def descriptor(self) -> dict:
        """The JSON part sent in the widget state; the bytes go in the message's buffers."""
        return {"dtype": "float32", "shape": list(self.shape)}

    def values(self) -> array.array:
        """The elements as an ``array.array('f')`` (for tests and small summaries)."""
        out = array.array("f")
        out.frombytes(self.data.tobytes())
        if sys.byteorder == "big":
            out.byteswap()
        return out


def _numpy():
    return sys.modules.get("numpy")


def encode(value: Any, *, name: str = "array") -> Encoded:
    """Encode ``value`` as float32 bytes and a shape.

    Accepts NumPy arrays (any numeric dtype; booleans become 0/1), pandas Series and Index, Polars Series (nulls
    become NaN), xarray DataArrays, ``array.array``, memoryviews, and (nested) lists or tuples of numbers. Raises ``TypeError`` for anything else and ``ValueError``
    for ragged nested lists.
    """
    np = _numpy()
    if hasattr(value, "to_numpy") and not isinstance(value, (list, tuple)):
        value = value.to_numpy()
    if np is not None and isinstance(value, np.ndarray):
        if value.dtype.kind not in "biuf":
            raise TypeError(f"{name} has dtype {value.dtype}; pass numbers (convert with .astype('float32'))")
        values = np.ascontiguousarray(value, dtype="<f4")
        return Encoded(memoryview(values).cast("B"), tuple(int(d) for d in values.shape))
    if isinstance(value, memoryview):
        value = value.tolist()
    if isinstance(value, array.array):
        if value.typecode in ("u", "w"):
            raise TypeError(f"{name} is a character array; pass numbers")
        out = array.array("f", value)
        return Encoded(_little(out), (len(out),))
    if isinstance(value, (list, tuple)):
        shape = _shape(value, name)
        flat = array.array("f", _flatten(value))
        return Encoded(_little(flat), shape)
    raise TypeError(f"{name} must be a NumPy array, pandas Series, array.array or list of numbers, not {type(value).__name__}")


def _little(values: array.array) -> memoryview:
    if sys.byteorder == "big":
        values = array.array(values.typecode, values)
        values.byteswap()
    return memoryview(values).cast("B")


def _shape(value: Sequence, name: str) -> Tuple[int, ...]:
    shape = [len(value)]
    first = value[0] if len(value) else None
    if isinstance(first, (list, tuple)):
        inner = _shape(first, name)
        for item in value:
            if not isinstance(item, (list, tuple)) or _shape(item, name) != inner:
                raise ValueError(f"{name} is ragged; every row needs the same length")
        shape += list(inner)
    return tuple(shape)


def _flatten(value: Sequence):
    for item in value:
        if isinstance(item, (list, tuple)):
            yield from _flatten(item)
        elif isinstance(item, bool) or isinstance(item, (int, float)):
            yield float(item)
        else:
            raise TypeError(f"expected numbers, found {type(item).__name__}")


def column(source: Any, key: Any, name: str) -> Any:
    """``source[key]`` when ``key`` names a column (a DataFrame column or a dict entry), else ``key`` itself."""
    if key is None:
        return None
    if isinstance(key, str):
        if source is None:
            raise ValueError(f"{name}={key!r} names a column, but no DataFrame was given")
        # pandas and Polars frames list their columns; Polars raises its own error type for a missing one.
        columns = getattr(source, "columns", None)
        if columns is not None and not isinstance(source, dict) and key not in list(columns):
            raise KeyError(f"{name}={key!r} is not a column of the data")
        try:
            return source[key]
        except (KeyError, IndexError, TypeError) as error:
            raise KeyError(f"{name}={key!r} is not a column of the data") from error
    return key


def extent(encoded: Encoded) -> Tuple[float, float]:
    """Min and max of the finite values ((0.0, 1.0) when there are none)."""
    np = _numpy()
    if np is not None:
        values = np.frombuffer(encoded.data, dtype="<f4")
        finite = values[np.isfinite(values)]
        return (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)
    finite = [v for v in encoded.values() if math.isfinite(v)]
    return (min(finite), max(finite)) if finite else (0.0, 1.0)


def frame(source: Any, keys: Sequence[Any]) -> Any:
    """``source`` ready for :func:`column`: a Polars LazyFrame is collected, reading only the named columns."""
    if type(source).__name__ == "LazyFrame" and hasattr(source, "collect"):
        names = list(dict.fromkeys(k for k in keys if isinstance(k, str)))
        return source.select(names).collect()
    return source


def is_labeled(value: Any) -> bool:
    """True for an xarray DataArray (an array with named dimensions and coordinates)."""
    return hasattr(value, "dims") and hasattr(value, "coords") and hasattr(value, "to_numpy")


def label(value: Any, fallback: str) -> str:
    """A DataArray's or coordinate's title the way xarray's own plots write it: long name (or name) and units."""
    attrs = getattr(value, "attrs", {}) or {}
    text = attrs.get("long_name") or attrs.get("standard_name") or getattr(value, "name", None) or fallback
    units = attrs.get("units")
    return f"{text} ({units})" if units else str(text)


def labeled_grid(value: Any, name: str, ranges: bool) -> Tuple[Any, list, list]:
    """The values of a DataArray as a NumPy array, with each axis's data range and title, in the array's axis order.

    With ``ranges``, each dimension coordinate must be numeric and evenly spaced (the grid is drawn uniform); a
    decreasing coordinate is flipped so the array runs from the minimum to the maximum. A dimension without a
    coordinate gets ``None`` (index units).
    """
    np = _numpy()
    values = value.to_numpy()
    spans: list = []
    titles: list = []
    for axis, dim in enumerate(value.dims):
        coord = value.coords[dim] if dim in value.coords else None
        titles.append(label(coord, str(dim)) if coord is not None else str(dim))
        if not ranges or coord is None:
            spans.append(None)
            continue
        c = coord.to_numpy()
        if c.dtype.kind not in "iuf":
            raise TypeError(
                f"{name} coordinate {dim!r} has dtype {c.dtype}; give it numbers (assign_coords) or pass the range explicitly"
            )
        c = c.astype("float64")
        if c.size < 2:
            spans.append(None)
            continue
        step = (c[-1] - c[0]) / (c.size - 1)
        if step == 0 or float(np.max(np.abs(np.diff(c) - step))) > 1e-3 * abs(step):
            raise ValueError(
                f"{name} coordinate {dim!r} is not evenly spaced; Margo draws uniform grids, so resample it first "
                f"(for example .interp({dim}=np.linspace(lo, hi, n))) or pass the range explicitly"
            )
        if step < 0:
            values = np.flip(values, axis=axis)
        spans.append((float(min(c[0], c[-1])), float(max(c[0], c[-1]))))
    return values, spans, titles
