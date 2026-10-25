"""The Jupyter widget messaging protocol, version 2.1, written from its specification.

Reference: the "Widget messaging protocol" document of the Jupyter widgets project (ipywidgets, docs
``jupyterwidgetmodels`` / ``protocol``) and the Jupyter messaging spec for comms. Summary of what is used here:

* The kernel opens a comm with target ``jupyter.widget``. Its ``data`` is ``{"state": ..., "buffer_paths": ...}`` and
  its metadata ``{"version": "2.1.0"}``. The state names the model and view classes and their JavaScript module
  (``_model_module``, ``_model_name``, ``_model_module_version`` and the ``_view_*`` equivalents).
* Binary values are taken out of the state. Each one leaves a placeholder, its path (a list of keys and indices) goes
  in ``buffer_paths``, and its bytes travel in the message's ``buffers`` in the same order. The frontend puts them back.
* State changes go both ways as ``{"method": "update", "state", "buffer_paths"}``. The kernel answers a frontend
  update with ``echo_update`` (new in 2.1), so other frontends see the change.
* ``{"method": "request_state"}`` from a frontend gets the full state back as an ``update``.
* ``{"method": "custom", "content"}`` carries events outside the state.
* The kernel displays a widget with the ``application/vnd.jupyter.widget-view+json`` mime type, naming the comm id.

The comm itself comes from the ``comm`` package (``comm.create_comm``), which ipykernel and other kernels provide.
Tests pass a stand-in factory.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

__all__ = ["PROTOCOL_VERSION", "MODULE", "MODULE_VERSION", "WidgetModel", "split_buffers", "join_buffers"]

#: The widget messaging protocol this module speaks.
PROTOCOL_VERSION = "2.1.0"
#: The JavaScript module with the model and view (installed as a JupyterLab prebuilt extension).
MODULE = "@margoengine/jupyter"
#: Semver range of that module.
MODULE_VERSION = "^1.0.0"
#: Mime type of a widget display.
VIEW_MIME = "application/vnd.jupyter.widget-view+json"

Path = List[Any]


def split_buffers(state: Any, path: Optional[Path] = None) -> Tuple[Any, List[Path], List[memoryview]]:
    """Take binary values out of ``state``. Returns the JSON-able state, the buffer paths and the buffers.

    Bytes, bytearrays and memoryviews count as binary. They are removed from dicts and replaced by ``None`` in lists,
    as the protocol's reference implementations do, and the frontend restores them at their paths.
    """
    path = path or []
    paths: List[Path] = []
    buffers: List[memoryview] = []
    if isinstance(state, (bytes, bytearray, memoryview)):
        return None, [path], [memoryview(state)]
    if isinstance(state, dict):
        out: Dict[str, Any] = {}
        for key, value in state.items():
            if isinstance(value, (bytes, bytearray, memoryview)):
                paths.append(path + [key])
                buffers.append(memoryview(value))
                continue
            sub, sub_paths, sub_buffers = split_buffers(value, path + [key])
            out[key] = sub
            paths += sub_paths
            buffers += sub_buffers
        return out, paths, buffers
    if isinstance(state, (list, tuple)):
        items: List[Any] = []
        for index, value in enumerate(state):
            sub, sub_paths, sub_buffers = split_buffers(value, path + [index])
            items.append(sub)
            paths += sub_paths
            buffers += sub_buffers
        return items, paths, buffers
    return state, paths, buffers


def join_buffers(state: Any, paths: List[Path], buffers: List[Any]) -> Any:
    """Put ``buffers`` back into ``state`` at ``paths`` (the inverse of :func:`split_buffers`)."""
    if len(paths) != len(buffers):
        raise ValueError(f"{len(paths)} buffer paths for {len(buffers)} buffers")
    for path, buffer in zip(paths, buffers):
        if not path:
            return buffer
        target = state
        for key in path[:-1]:
            target = target[key]
        if isinstance(target, list):
            target[path[-1]] = buffer
        else:
            target[path[-1]] = buffer
    return state


def _default_factory(**kwargs: Any) -> Any:
    try:
        import comm  # The kernel's comm implementation (ipykernel and others register it).
    except ImportError as error:  # pragma: no cover - depends on the environment
        raise RuntimeError(
            "Margo widgets need a Jupyter kernel with the 'comm' package (ipykernel 6.22+). "
            "Outside Jupyter, use figure.save_html(path)."
        ) from error
    return comm.create_comm(**kwargs)


class WidgetModel:
    """A widget model kept in sync with the frontend over one comm.

    ``state`` holds the synced attributes. Values may be bytes or memoryviews, which travel as binary buffers.
    Call :meth:`set` to change attributes; changes made by the frontend arrive in :meth:`on_update` callbacks.
    """

    model_name = "MargoFigureModel"
    view_name = "MargoFigureView"

    def __init__(self, state: Dict[str, Any], *, comm_factory: Optional[Callable[..., Any]] = None):
        self._factory = comm_factory or _default_factory
        self.state: Dict[str, Any] = {
            "_model_module": MODULE,
            "_model_module_version": MODULE_VERSION,
            "_model_name": self.model_name,
            "_view_module": MODULE,
            "_view_module_version": MODULE_VERSION,
            "_view_name": self.view_name,
            "_view_count": None,
            **state,
        }
        self._comm: Any = None
        self._update_callbacks: List[Callable[[Dict[str, Any]], None]] = []
        self._custom_callbacks: List[Callable[[Any, List[Any]], None]] = []

    @property
    def model_id(self) -> Optional[str]:
        """The comm id, once the comm is open."""
        return getattr(self._comm, "comm_id", None)

    def open(self) -> None:
        """Opens the comm with the full state (once)."""
        if self._comm is not None:
            return
        state, paths, buffers = split_buffers(self.state)
        self._comm = self._factory(
            target_name="jupyter.widget",
            data={"state": state, "buffer_paths": paths},
            metadata={"version": PROTOCOL_VERSION},
            buffers=buffers,
        )
        self._comm.on_msg(self._handle)

    def set(self, **changes: Any) -> None:
        """Changes synced attributes and sends them as one ``update``."""
        self.state.update(changes)
        if self._comm is not None:
            self._send("update", changes)

    def send_custom(self, content: Any, buffers: Optional[List[Any]] = None) -> None:
        """Sends a ``custom`` message (an event outside the state)."""
        self.open()
        self._comm.send(data={"method": "custom", "content": content}, buffers=buffers or [])

    def on_update(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """Calls ``callback(changes)`` when the frontend changes the state."""
        self._update_callbacks.append(callback)

    def on_custom(self, callback: Callable[[Any, List[Any]], None]) -> None:
        """Calls ``callback(content, buffers)`` for ``custom`` messages from the frontend."""
        self._custom_callbacks.append(callback)

    def close(self) -> None:
        """Closes the comm; the frontend removes the views."""
        if self._comm is not None:
            self._comm.close()
            self._comm = None

    def _send(self, method: str, changes: Dict[str, Any]) -> None:
        state, paths, buffers = split_buffers(changes)
        self._comm.send(data={"method": method, "state": state, "buffer_paths": paths}, buffers=buffers)

    def _handle(self, message: Dict[str, Any]) -> None:
        content = message.get("content", {})
        data = content.get("data", {})
        buffers = message.get("buffers") or []
        method = data.get("method")
        if method == "update":
            changes = join_buffers(dict(data.get("state", {})), data.get("buffer_paths", []), list(buffers))
            self.state.update(changes)
            # Protocol 2.1: echo the frontend's change so every other view of the model applies it too.
            self._send("echo_update", changes)
            for callback in list(self._update_callbacks):
                callback(changes)
        elif method == "request_state":
            self._send("update", self.state)
        elif method == "custom":
            for callback in list(self._custom_callbacks):
                callback(data.get("content"), list(buffers))

    def mimebundle(self) -> Dict[str, Any]:
        """The display bundle: the widget view (opening the comm) and a plain-text fallback."""
        self.open()
        return {
            VIEW_MIME: {"version_major": 2, "version_minor": 1, "model_id": self.model_id},
            "text/plain": f"<Margo figure {self.model_id}>",
        }
