# GPU labels

`@margoengine/labels/gpu` exports `GPULabelLayer`, `GPULabel`, and `GPULabelOptions`.
Call `await GPULabelLayer.create(options)`, attach with `engine.use(layer)`, then
call `layer.setLabels(labels)`. Collections can contain 100,000 or more points;
each non-whitespace glyph is an instance, and all visible glyphs share one draw.
Text support loads only when `create` is called. The labels root stays independent.

Positions are world coordinates. Font size, offsets, grid size and padding are CSS
pixels. Pixel size is constant in perspective and orthographic cameras. The view's
viewport and scissor are applied. Labels are an overlay and do not occlude one
another by depth; decluttering keeps higher priorities first, with input order
breaking ties. The grid tests full raster glyph rectangles, including SDF padding.
Turn `declutter` off to retain all overlapping points. `visible: false` removes a
label from the current frame. Label fields may change between frames.

Defaults: sans-serif, 16 px, white RGBA, priority 0, offset [0, 0], visible true,
declutter true, grid 64 px, padding 2 px, atlas side 1024 texels and at most 32
pages, plugin name `gpu-labels`, graph order 24. Font loading completes before
creation resolves. `signal` checks cancellation. `dispose` and `Symbol.dispose`
release device resources; engine device restoration rebuilds them from CPU glyphs.

All pages share one RGBA texture array. Text layout and SDF generation use Margo's
text package, including its shaping and color glyph support. Atlas exhaustion is a
coded `state` error; increase its size/page budget. GPU allocation limits still
apply. GPU glyph instances cost 80 bytes each. CPU glyph bitmaps remain cached for
restoration. A still frame currently repacks and uploads the visible instances;
incremental updates are a finish-phase optimization, with no speed claim here.

CPU tests cover 100,000 independent points, priority/grid behavior, camera-distance
invariance, clip conventions, invalid input, cancellation and atlas exhaustion.
The existing labels browser gate adds real WebGPU, native WebGL2 and compatibility
WebGL2 rendering: 100,000 glyphs in one draw, 99,999 overlaps removed with 99,999
exact comparisons, behind-camera culling, disposal and equal near/far pixel bounds.
Fixtures are authored numerical controls, not a published geographic demo.
