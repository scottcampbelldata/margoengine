# The UI Layout Editor

Build a control screen for the fictional Coastal Relay station. Drag a widget onto the preview or into the layer list. A tap or keyboard activation adds the same widget to the selected container. Drag the grip beside a layer to move it. The Inspector also offers **Move up**, **Move down**, and a **Parent** menu for the same changes without dragging.

Click a widget on the preview or choose its layer to edit its text, spacing, or meter value. Undo and redo cover the document changes. Use **Markup** or **Styles** to see and edit the actual files that define the preview. **Apply edit** validates the draft. **Download project** exports the engine's versioned JSON with both source strings, and **Open project** restores a saved project.

## Engine and design

This is a finished treatment of the pinned public Margo Engine [UI editor example](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/examples/ui-editor). The custom, touch-accessible workspace builds on its public [UI package](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/ui). Margo's LayoutDocument handles insertion, ordering, validation, history, and project serialization. Its built widgets supply the rendered preview and the actual bounds used for selection and dropping. UiRenderer draws the same fixed-aspect artboard first on WebGPU or through its real WebGL2 preview backend. The original preset uses system fonts and requires no external media.

The editor selects the preview widgets for authoring. Files can define their layout and appearance with Margo UI markup and styles. The example is a layout prototype with no configured game actions. Nodes need a unique ID to appear in the visual editor. Source editing remains available for unnamed widgets and list or menu items.

The drag interaction uses standardized pointer capture and the tactile controls have alternatives for adding, reordering, and reparenting widgets. [W3C Pointer Events](https://www.w3.org/TR/pointerevents/) · [W3C WCAG 2.2 guidance on dragging](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements)
