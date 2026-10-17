# Selection outlines children: decision

Date: 2026-10-17. Decided by Scott. Status: final.

## The behaviour

Selecting a parent outlines that mesh and everything under it. This holds for a plain core mesh and for a loaded
model (gltf-pro and other loader-owned models).

A child pick stays child-only: selecting a child outlines that child and its own descendants, not its parent or
siblings. This already passed on FridgeDoor.

It came in with the repository consolidation commit `8f710eb3` (the mask flag that marks a selected mesh's
descendants). The proof triage on branch `claude/proof-triage` classified it as an intended change.

## Why

A CAD root often has no triangles of its own; the outline of its children is the selection. `parseCADAsync` builds the
assembly's parts as core meshes, so limiting the descendant walk to gltf-pro models would make a selected CAD assembly
draw no outline at all.

## Rules for whoever works on `@margoengine/selection`

- Do not revert this behaviour and do not restrict the descendant walk to loader-owned models.
- Do not re-pin the selection proof back to a reference from before `8f710eb3`. The current reference, which includes
  this behaviour, is correct.
- Keep a child pick child-only, and keep a regression check for both cases: a selected root with no triangles (a CAD
  assembly from `parseCADAsync`) outlines all of its parts, and a picked child (FridgeDoor) outlines only itself and its
  descendants.
- Docs that describe selection (the `@margoengine/selection` README, the API report) should state this rule in these
  words: "Selecting a parent outlines that mesh and everything under it."
