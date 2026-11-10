# Viewer extras

`@margoengine/stage/viewer-extras` and its generated `margoengine/stage/viewer-extras` alias export `addViewerExtras` and `registerViewerElement`. The first loads the existing product viewer with its full environment, shadow, tonemap, framing and turntable options, then composes interaction. The second explicitly registers a declarative HTML element. Neither changes the stage root or core. Importing the entry does not register a tag, create DOM, fetch a model or require browser globals.

## Controller

The controller retains every `Viewer` property, including its live `turntable` accessor. It adds:

| Option | Default | Behaviour |
| --- | --- | --- |
| `parent` | canvas parent | Overlay, poster and AR button host; must belong to a browser document |
| `hotspots` | empty | HTML elements plus the full owning `LabelOptions` contract: mesh/local offset or world position, anchor, screen offset, visibility, priority, distance scaling and custom occlusion |
| `autoplay` | false | Play the first or selected clip; skin/morph rest deformation attaches even while paused |
| `animationName` | first clip | Clip name or index; invalid selection rejects and rolls back |
| `variant` | original materials | `KHR_materials_variants` name or index |
| `picking` | true | Shared GPU picker, automatic PBR source discovery and canvas pointer selection |
| `poster` | none | Image in an accessible reveal button, disabled and busy during loading |
| `reveal` | auto | Auto hides the poster after the first model render; manual keeps it until `dismissPoster()` or a button activation |
| `alt` | 3D model | Poster description; declarative form also labels the canvas |
| `ar` | false | `true` or stage XR button options; mode is always `immersive-ar` |

`animation` is the owning Animation player or null. `play(nameOrIndex)` selects and restarts; `play()` resumes without resetting time; `pause()` retains the pose; `seek(seconds)` uses the owning animation time contract. No-clip play/seek rejects with a coded state error. Available names are `animation.clips` and `model.variants`. `selectVariant()` restores original materials. The controller's `events` emits `play`, `pause`, `variant-change`, `pick` and `poster-dismissed` CustomEvents. Play detail has `clip`; variant detail has the owning model's selected variant index; pick detail is the hit or null.

`pick(x,y)` uses canvas-relative CSS pixels and returns only this viewer's model, with the owning selection package's mesh/model/primitive information. Empty pixels and another model return null. Pointer down/up selects only with a matching pointer ID and at most four CSS pixels of movement; pointer cancellation clears the gesture. Scaled canvas coordinates map back to its CSS size. Selection errors reach engine.onError. With `picking: false`, no selection package is imported and pick rejects with enable guidance.

`addHotspot` lazily imports labels, returns its live Label, and rejects a duplicate element. `removeHotspot(element)` restores its prior DOM location, sibling order and inline style. Disposal, abort, stage disposal, external model disposal and failed setup also restore caller-owned elements. Detached input elements return to detached state. Shared picking plugins are released only by their last helper owner; a caller's pre-existing picker is never disposed. Hotspots belong to an independently named label overlay. Dynamic mesh anchors follow the owning node transform, including node animation. Surface barycentric anchors and automatic surface-normal occlusion are not claimed; callers can use LabelOptions.occlude.

The poster covers the model while it loads. Failure removes it with the other owned resources and rejects the load. Manual reveal does not defer network or GPU loading. AR uses the existing stage/xr feature and its browser/device checks, session lifecycle and user-activation button. Unsupported browsers show a disabled button with a reason. It requires HTTPS and WebXR with the engine's supported binding or compatibility route. No native Scene Viewer or Quick Look conversion/launch is claimed. Physical immersive-AR presentation still needs a compatible device.

## Declarative element

Invoke `registerViewerElement()` in a browser to define `margo-viewer`, or pass a custom tag name and `{stage, viewer}` defaults. Re-registering an existing name rejects with reuse guidance. Give the element an explicit height or layout height; minimum height is 150 CSS pixels. It mounts an accessible canvas and owned overlays in an open shadow root, leaving caller annotations restorable in the light DOM.

Observed attributes are `src`, `alt`, `poster`, `reveal`, `autoplay`, `animation-name`, `variant-name`, `ar` and `auto-rotate`. Boolean attributes use presence. Source/poster/reveal/AR changes reload; clip, variant, autoplay, rotation and description update a loaded viewer in place. Attribute values override registered defaults when supplied. Without a registered default, autoplay, rotation and AR are off. Source is resolved against the element's base URI. Empty src clears the viewer. Source replacement cancels the old load; disconnect cancels and disposes; reconnect loads again. An engine creation that finishes after cancellation is immediately disposed.

Child HTML annotations have a slot name beginning `hotspot-`, `data-position="x y z"` for a world anchor, optional `data-node` for a glTF node name/index, and `data-offset="x y z"` for a local offset. Vectors require three finite space-separated numbers. An unknown node rejects with a state error. Initial children are read after model load; invoke `reload()` to reread changed declarative annotations, or use `element.viewer.addHotspot` for live additions.

The element exposes `src`, nullable `stage` and `viewer`, the current `ready` promise, `availableAnimations`, `availableVariants`, `paused`, `currentTime`, `play`, `pause`, `dismissPoster` and `reload`. Await `ready` after calling reload, or listen for `load`. Automatic attribute loads retain a handled rejection while explicit ready/reload callers still receive failures. `load`, `error` and the controller's interaction events bubble and cross the shadow boundary. Error detail is `{error}`; load detail is `{viewer}`. `aria-busy` covers loading and is cleared after success, failure or disconnect.

## Evidence

CPU tests in `packages/stage/tests/viewer-extras.test.js` exercise ownership, shared/external pickers, SSR import, selection filtering, animation resume, variant reset, poster state, source replacement, cancellation at producer resolution, disconnect/reconnect and annotation DOM restoration. The browser fixture `packages/stage/test/gpu/viewer-extras.html` uses real openly licensed BoxTextured, RiggedFigure, MorphStressTest and MaterialsVariantsShoe assets already recorded in the repository. It compares the controller against direct viewer/Animation setup on native WebGPU and webgl2-compat, checks every named shoe variant, actual picking, projected and node-following labels, manual reveal, unsupported AR UI, and the real custom element lifecycle. This proves facade equivalence for the requested feature set, not a new shading algorithm or a complete reimplementation of every model-viewer option.
