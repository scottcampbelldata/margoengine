# Harrow Head gallery: direction

Scott's website rules (global CLAUDE.md, session rule 14) apply; this file records what they mean here. Every later
gallery batch builds on it and does not restyle it.

## What it is

A set of small pages. Each shows engine features in a scene built for the gallery, with buttons to switch between them.
The fictional place is Harrow Head: a headland with an observatory, a coast and a small town. Each page is a place there.
The exception is the model cabinet, where the subject is loading standard Khronos sample files.

## Who reads it and what they want

A developer deciding whether to try the engine. In three seconds: what this page shows, a live canvas, and the code
behind it. They came for the running feature, so the canvas is the first thing they see, not a slogan.

## Look

- Paper `#f4f1ea`, near black `#1b1a17`, muted ink `#55524a`, hairlines `#b9b3a4`, oxide red `#8f2f1c` for the one primary
  action and the selected section. Brass, slate, sea green and chalk belong to the scenes, not the page chrome.
- Type: a serif stack for titles (Iowan Old Style, Palatino, Georgia) over the self-hosted Source Sans 3 for body text,
  and a monospace stack for numbers. The plan's single self-hosted open serif is not chosen yet: it needs Scott's approval
  of the exact file, source, licence and size before any download, and only `--title` changes when it arrives.
- Left aligned. The canvas takes most of a wide screen; the panel sits left of it. On a phone the order is title, canvas,
  numbers, panel, so the scene shows before any controls.
- Scene stage rules, for every page with a place of its own: afternoon key light from the west at 35 degrees, wet slate,
  chalk or shingle ground, camera three-quarter from slightly above, objects generated in code with seeded variation.
- The aesthetic risk: a page that looks like a printed field guide or survey sheet (paper, ruled hairlines, plates with
  captions) around a live GPU scene, where most engine demos are dark with neon. The numbers strip reads like an
  instrument log.

## Bans (on top of the global list)

No gradients, no eyebrow lines, no numbering, no long dashes anywhere, no spinning cubes, no coloured random boxes, no
grey studio infinity floor, no photo textures except Khronos assets where loading is the subject. No identical card
grids: the index gives its two tiles different sizes and offsets. No fades on sections; a page gets at most one authored
motion moment, and the scaffold pages use none. Nothing is typed in that could be measured: every number on a page is
read at run time. Public wording never compares any demo to another game or engine, and the three.js example map stays
private.

## Template contract

Static HTML holds the title, the sentence, the section buttons and the footer, so the page reads with JavaScript off.
`gallery.js` wires the panel, deep links (`?section=id`, `#id`), Reset, the numbers strip and the hidden dedication.
`window.gallery` is `{readiness, engine, section, setSection, dispose}`. Each page module supplies `show(id, signal)`.
The dedication is never in the page copy, heading or panel: it enters the DOM only after its hidden interaction.
