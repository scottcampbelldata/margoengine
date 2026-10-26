# @margoengine/ui

Install `npm i margoengine` and import `margoengine/ui` (or this package alone: `npm i @margoengine/ui`, imported as
`@margoengine/ui`; the two are the same module).

Game UI that is drawn inside the engine, so it works in fullscreen and in exported games, with no DOM on top of the
canvas:

- **Widgets:** panels, labels, buttons, toggles, sliders, progress and health bars, lists, inventory grids, menus,
  dialogs, toasts and tooltips.
- **Layout:** anchors, flex-style rows and columns, grids, scrolling, safe areas.
- **Scaling:** a reference resolution, the device pixel ratio and the user's text size, with text that stays sharp
  because it is drawn by `@margoengine/text` as signed distance fields.
- **Themes:** a good-looking dark theme by default, a light theme, a high contrast theme, and `createTheme` for your own.
  All status colours come from the colour-blind-safe Okabe-Ito palette and meaning never rests on colour alone.

The package is optional and tree-shakable and adds nothing to core. `Ui` holds the widgets and produces a list of
rectangles and text in pixels; it touches neither the GPU nor the DOM, so it runs in Node and in tests.
`UiRenderer` is the engine plugin that draws that list on WebGPU. On the WebGL2 backend it warns once and draws nothing.

```ts
import { Engine } from '@margoengine/core';
import { Ui, UiRenderer, Menu } from '@margoengine/ui';

const engine = await Engine.create(document.querySelector('canvas')!);
const ui = new Ui(); // dark theme, 1 UI unit = 1 CSS pixel, system font
UiRenderer.attach(engine, ui); // steps the UI every frame and draws it over the finished frame

ui.add(
  new Menu({
    title: 'Paused',
    items: [
      { label: 'Resume', onSelect: () => ui.toast('Back in the game') },
      { label: 'Quit', onSelect: async () => (await ui.confirm('Quit to the title screen?')) && location.reload() },
    ],
  }),
);
```

## Building a screen

Every widget is a class you construct with an options object. Put them in a `Panel` (a column by default) and add the
panel to `ui`. Layout options are on every widget.

```ts
import { Ui, Panel, Label, Button, Toggle, Slider } from '@margoengine/ui';

const ui = new Ui();
const settings = new Panel({
  background: 'surface',
  border: true,
  shadow: true,
  padding: 24,
  gap: 12,
  width: 360,
  anchor: 'center',
  children: [
    new Label({ text: 'Settings', size: 'title' }),
    new Slider({ text: 'Volume', value: 0.8, onChange: (e) => console.log('volume', e.value) }),
    new Toggle({ text: 'Subtitles', checked: true, onChange: (e) => console.log('subtitles', e.value) }),
    new Button({ text: 'Done', variant: 'primary', onClick: () => settings.removeFromParent() }),
  ],
});
ui.add(settings);
```

`on(type, handler)` works on every widget and returns a function that unsubscribes; it is also disposable, so
`using off = button.on('click', fn)` ends the subscription at the end of the block. Option callbacks (`onClick`,
`onChange`, `onSelect`) are shortcuts for `on('click' | 'change' | 'select', ...)`.

## Layout

Sizes are UI units. By default one unit is one CSS pixel; see Scaling.

| Option | Default | Meaning |
| --- | --- | --- |
| `direction` | `'column'` | `'row'`, `'column'`, `'stack'` (children anchored over each other) or `'grid'` |
| `gap` | `0` | space between children; a number or `[column gap, row gap]` |
| `align` | stretch (column), center (row) | cross-axis placement: `'start'`, `'center'`, `'end'`, `'stretch'` |
| `justify` | `'start'` | main-axis placement: `'start'`, `'center'`, `'end'`, `'space-between'`, `'space-around'`, `'space-evenly'` |
| `padding`, `margin` | `0` | a number, `[vertical, horizontal]` or `[top, right, bottom, left]` |
| `width`, `height` | `'auto'` | a number, `'auto'` (fit content), `'fill'` or a percentage such as `'50%'` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | none | bounds in UI units |
| `grow`, `shrink` | `0`, `1` | shares of the free or missing main-axis space |
| `alignSelf` | the parent's `align` | cross-axis placement of this child |
| `anchor` | `'stretch'` in a stack | `'top-left'`, `'top'`, `'top-right'`, `'left'`, `'center'`, `'right'`, `'bottom-left'`, `'bottom'`, `'bottom-right'` or `'stretch'`; `margin` is the distance from the edges |
| `position` | `'flow'` | `'absolute'` takes the child out of a row or column and anchors it |
| `offset` | `[0, 0]` | shift after layout, for animation |
| `bleed` | `false` | in a stack, ignore the parent's padding and the safe area |
| `columns`, `cellWidth`, `cellHeight` | `1`, widest, tallest | for `direction: 'grid'` |
| `overflow` | `'visible'` | `'hidden'` clips; `'scroll'` clips and scrolls on the main axis |

The screen layer is a stack, so a widget with an `anchor` sits at that corner or edge of the screen, inside the safe area:

```ts
import { Ui, Panel, Label } from '@margoengine/ui';

const ui = new Ui();
ui.add(
  new Panel({ background: 'scrim', direction: 'row', gap: 12, padding: [8, 16], anchor: 'top-left', margin: 16,
    children: [new Label({ text: 'Gold' }), new Label({ text: '1,250', color: 'warning' })] }),
  new Label({ text: 'Press E to open', anchor: 'bottom', margin: 48, outline: true }),
);
ui.update(1 / 60); // lays out the tree
const [hud] = ui.root.children;
console.log(hud.rect); // { x, y, width, height } in UI units
```

Safe areas keep the HUD out of notches, rounded corners and the TV overscan. `new Ui({ safeArea: 'auto' })` (the default)
reads the device's `env(safe-area-inset-*)`; `ui.setSafeArea([top, right, bottom, left])` sets it in CSS pixels. A widget
with `bleed: true` (a full-screen backdrop, say) ignores it.

## Widgets

| Widget | Use | Key options |
| --- | --- | --- |
| `Panel` | container with an optional background, outline and shadow | `background`, `border`, `shadow`, `radius` |
| `Label` | text that wraps and scales | `text`, `size`, `color`, `align`, `wrap`, `outline` |
| `Button` | push button, 44 units tall at least | `text`, `icon`, `variant`, `onClick` |
| `Toggle` | switch or checkbox | `text`, `checked`, `variant`, `onChange` |
| `Slider` | horizontal slider | `min`, `max`, `step`, `value`, `text`, `format`, `onChange` |
| `ProgressBar` | meter with its value written in it | `value`, `max`, `text`, `variant`, `display` |
| `HealthBar` | progress bar for hit points, with a damage trail | `value`, `max` |
| `List` | scrolling list of selectable rows | `items`, `selected`, `onSelect` |
| `Inventory` | grid of item slots; drag, or pick up and put down | `columns`, `slots`, `items`, `onMove`, `onUse` |
| `Menu` | titled column of buttons | `title`, `items` |

`ui.dialog()`, `ui.confirm()` and `ui.alert()` show modal dialogs that return promises, and `ui.toast()` shows a
message that fades. `AbortSignal` closes a dialog from code.

```ts
import { Ui, HealthBar, Inventory } from '@margoengine/ui';

const ui = new Ui();
const health = new HealthBar({ max: 100, width: 260, anchor: 'top-left', margin: 16 });
const bag = new Inventory({
  columns: 4,
  slots: 12,
  anchor: 'bottom-right',
  margin: 16,
  items: [{ id: 'potion', name: 'Potion', icon: '🧪', count: 3, description: 'Restores 25 health' }],
});
bag.on('use', (e) => {
  health.value += 25;
  ui.toast(`Used ${(e.item as { name: string }).name}`, { kind: 'success' });
});
ui.add(health, bag);

health.value = 40; // eases down; the old value lingers as a pale chip
const controller = new AbortController();
const answer = await ui.dialog({
  title: 'Respawn?',
  message: 'You fell off the map.',
  buttons: [{ label: 'Respawn', value: 'respawn' }, { label: 'Quit', value: 'quit' }],
  signal: controller.signal, // controller.abort() closes it and rejects
});
console.log(answer);
```

Status never relies on colour alone: bars write their value inside, toasts carry a symbol and a word for screen readers,
and a switch moves its knob.

## Theming

`themes.dark` is the default (`themeForPreferences()` picks high contrast, light or dark from the user's settings).
`createTheme` makes your own from any base:

```ts
import { Ui, createTheme, themes } from '@margoengine/ui';

const forest = createTheme({ name: 'forest', colors: { primary: '#7bd88f', onPrimary: '#06210d' }, radius: 12 }, themes.dark);
const ui = new Ui({ theme: forest });
ui.theme = themes.highContrast; // restyles everything on the next frame
```

| Theme | Notes |
| --- | --- |
| `themes.dark` | default; every text colour is at least 4.5:1 on what it is drawn on |
| `themes.light` | same contrast rules on light surfaces |
| `themes.highContrast` | black, white, yellow and cyan; 7:1 text, thick outlines, 4-unit focus ring, no shadows or motion |

The colour roles (`primary`, `success`, `warning`, `danger`, `info`, `accent`, `focus`, `surface`, `text`, ...) are
documented on `ThemeColors`. The tests check text contrast for every built-in theme and that the success, warning and
danger colours stay apart for protan, deutan and tritan viewers (`simulateColorBlindness`, `contrastRatio` and
`colorDifference` are exported so you can check your own theme the same way).

## Scaling

```ts
import { Ui } from '@margoengine/ui';

const ui = new Ui({
  scale: { reference: [1280, 720], match: 0.5 }, // design for 720p; the UI scales with the window
  textScale: 1.25, // the user's text size preference, 0.5 to 3
});
ui.resize(1920, 1080, window.devicePixelRatio);
console.log(ui.width, ui.height, ui.scale); // 1280 720 1.5 (with a pixel ratio of 1)
```

UI units become CSS pixels by the resolution scale and device pixels by the pixel ratio on top; text is laid out in UI
units and drawn as signed distance fields at the final pixel size, so it stays sharp. `UiRenderer` calls `resize` from
the canvas every frame. `textScale` multiplies every text size and reflows the layout.

## Mouse, touch, keyboard and gamepad

`UiRenderer.attach(engine, ui)` connects the engine's canvas for you (`{ input: false }` turns that off). Everything works
with every device:

| Input | What it does |
| --- | --- |
| Mouse, pen | hover, click, drag sliders and inventory items, wheel scrolls lists |
| Touch | tap, drag, scroll; touch never hovers |
| Arrow keys, d-pad, left stick | move focus to the nearest widget in that direction (holding repeats); a focused slider takes left and right |
| Tab, Shift+Tab, bumpers | step through the widgets; Tab past the last one hands the keyboard back to the page |
| Enter, Space, gamepad A | press the focused widget |
| Escape, gamepad B | close the tooltip, then the dialog |

The focus ring shows for the keyboard and gamepad and hides for the mouse and touch. A dialog traps focus, puts it on its
first button and gives it back when it closes. A press that lands on a widget never reaches other listeners on the canvas
(it will not also orbit the camera) and `ui.wantsPointer(x, y)` tells your own code when the pointer is over the UI. Keys
go to the UI only while a widget has focus or a dialog is open; set `ui.captureKeys = true` while a full-screen menu shows
so the arrows work from the first press.

```ts
import { Input } from '@margoengine/input';
import { Ui, uiActions } from '@margoengine/ui';

const ui = new Ui();
// Gamepad (and, with { keyboard: true }, keys) as Input actions; merge your own actions in the same object.
const input = new Input({ ...uiActions(), jump: [{ type: 'key', code: 'Space' }] });
ui.bindInput(input); // reads the ui.* actions each ui.update(); call input.update() before it

ui.captureKeys = true; // a full-screen menu is open
ui.navigate('down'); // the same thing the arrow keys, the d-pad and the stick do
ui.accept(); // Enter, Space, gamepad A
ui.cancel(); // Escape, gamepad B: returns false when there was nothing to close
console.log(ui.focused?.label, ui.inputMode); // 'keyboard'
```

To handle the events yourself, call `ui.pointerMove`, `ui.pointerDown`, `ui.pointerUp`, `ui.wheel`, `ui.navigate`,
`ui.tab`, `ui.accept` and `ui.cancel` (or `ui.execute(command)`) from your own listeners, or attach a different element with
`attachInput(ui, element, { signal })`, which returns a function that detaches it and is also disposable.

```ts
import { Ui, Panel, Button, attachInput } from '@margoengine/ui';

const ui = new Ui();
ui.add(new Panel({ children: [new Button({ text: 'Play', tooltip: 'Start a new game' })] }));
const controller = new AbortController();
attachInput(ui, document.querySelector('canvas')!, { signal: controller.signal });
// controller.abort() removes every listener again.
```

A widget with a `tooltip` shows it after half a second of hovering, or a moment after the keyboard focuses it; Escape
hides it. Tooltips sit below the widget and flip above it at the bottom of the screen.

## Accessibility

The interface is usable without a mouse, without sight and without colour vision, and nothing needs configuring:

- **Keyboard and gamepad:** every control can be reached and operated, the focus ring is always visible when the keyboard
  or gamepad moves focus, and a dialog traps focus. Tab never traps the keyboard: past the last widget it returns to the page.
- **Screen readers:** `UiRenderer` also attaches a hidden DOM mirror (`attachMirror`) next to the canvas. It holds real
  buttons, switches, range inputs, progress bars, listboxes, dialogs and text, laid over the widgets so touch exploration
  works, and it shares focus with the canvas: Tab or a screen reader moving to an element focuses its widget, and moving focus
  in the UI moves DOM focus so the reader announces it. Everything behind an open dialog is `inert`.
- **Announcements:** toasts go to polite (assertive for errors) live regions, and `ui.announce(message)` says anything else.
  A widget's `tooltip` and `description` become `aria-describedby`.
- **Colour:** the themes keep success, warning and danger apart for protan, deutan and tritan viewers, bars and toasts
  carry words and symbols as well as colour, and `themes.highContrast` is black, white, yellow and cyan with 7:1 text.
  `themeForPreferences()` picks high contrast for `prefers-contrast: more` and forced colours.
- **Text size:** `ui.textScale` from 0.5 to 3 reflows the whole interface, and `new Ui({ textScale: 'auto' })` follows the font
  size the user set in the browser (`browserTextScale()`).
- **Motion:** `prefers-reduced-motion` turns transitions, easing and fades off (`ui.motion`).
- **Targets:** buttons, toggles, sliders and list rows are at least 44 units tall.

```ts
import { Ui, UiRenderer, attachMirror, themeForPreferences } from '@margoengine/ui';
import type { EngineKernel } from '@margoengine/core';

export function accessibleUi(engine: EngineKernel): Ui {
  const ui = new Ui({ theme: themeForPreferences(), textScale: 'auto' });
  // The renderer attaches input and the mirror itself; to attach them by hand, turn them off and call:
  UiRenderer.attach(engine, ui, { input: false, mirror: false });
  const detach = attachMirror(ui, engine.canvas, { label: 'Menu and heads-up display' });
  ui.announce('Level 3. Your health is full.');
  void detach; // call it to remove the mirror; it is also disposable: using detach = attachMirror(...)
  return ui;
}
```

Keep these working in your own widgets: give a `Widget` a `label` (its accessible name; text widgets use their text), a `description`,
and `focusable = true` with an `activate()` method for anything that reacts to accept.

## React

`@margoengine/ui/react` has thin components for the same widgets. They render no DOM: nest them inside `UiRoot` and they
become widgets of one `Ui`, drawn on the engine's canvas. Props update the widgets in place, `onClick`, `onChange`,
`onSelect`, `onMove` and `onUse` are the widgets' events, and `checked`, `value`, `items` and `selected` are controlled, so
state lives in React. `react` is an optional peer dependency of this package.

```tsx
import { useState } from 'react';
import type { EngineKernel } from '@margoengine/core';
import { themes, type InventoryItem } from '@margoengine/ui';
import { UiRoot, Panel, Label, HealthBar, Inventory, Toggle, Button, useUi } from '@margoengine/ui/react';

export function Hud({ engine, hp }: { engine: EngineKernel; hp: number }) {
  const [contrast, setContrast] = useState(false);
  const [bag, setBag] = useState<(InventoryItem | null)[]>([{ id: 'potion', name: 'Potion', icon: '🧪', count: 2 }, null, null, null]);
  return (
    <UiRoot engine={engine} theme={contrast ? themes.highContrast : themes.dark}>
      <Panel background="scrim" padding={12} gap={8} anchor="top-left" margin={16}>
        <Label text="Camp" size="large" />
        <HealthBar value={hp} max={100} width={240} />
        <Toggle text="High contrast" checked={contrast} onChange={(e) => setContrast(e.value as boolean)} />
      </Panel>
      <Panel anchor="bottom-right" margin={16}>
        <Inventory columns={2} slots={4} items={bag} onMove={() => setBag([...bag])} />
      </Panel>
      <Respawn />
    </UiRoot>
  );
}

function Respawn() {
  const ui = useUi(); // toast(), dialog(), confirm(), announce() for event handlers
  return <Button text="Respawn" anchor="bottom" margin={16} onClick={() => ui.toast('Respawned', { kind: 'success' })} />;
}
```

Create `UiRoot` where the engine is known (in a child of `@margoengine/react`'s `<Canvas>`, call `useEngine()` and pass it as
`engine`). Pass `ui={yourUi}` to share one `Ui` with plain code. Widgets join their parent in mount order, so show and hide a
widget with `visible` rather than by mounting it conditionally if its place in the order matters. Props only a constructor
reads (a slider's `min` and `max`, an inventory's `columns` and `slots`) recreate the widget when they change.

## Options

| `new Ui({...})` option | Default |
| --- | --- |
| `width`, `height` | `1280`, `720` (CSS pixels; `UiRenderer` keeps them in step with the canvas) |
| `pixelRatio` | `1` |
| `scale` | `1`, or `{ reference: [w, h], match, min, max }` |
| `theme` | `themeForPreferences()` |
| `font` | `system-ui, sans-serif` at weight 500; a `Font` or options from `@margoengine/text` |
| `textScale` | `1` |
| `safeArea` | `'auto'` |
| `reducedMotion` | the user's `prefers-reduced-motion` |
| `measurer` | the font; pass your own for tests or servers |

Errors follow the repository convention: bad arguments throw `TypeError` or `RangeError` whose message names the fix and
ends with a link to [margoengine.com/errors#ui](https://margoengine.com/errors#ui); using a disposed `Ui` throws a
`MargoError` with `code: 'disposed'`. `Ui`, `UiRenderer` and every widget have `dispose()` and `Symbol.dispose`.

## How it works

- **A draw list, not a scene.** `ui.draw()` returns rounded rectangles, text blocks and clip regions in device pixels,
  back to front. It is rebuilt only when something changed, and `UiRenderer` uploads it only when it was rebuilt.
- **Two instanced draws.** Rectangles are signed distance rounded boxes (crisp edges, outlines, soft shadows); glyphs are
  quads sampling the text package's atlases. Both read storage buffers by instance index, in the engine's own render pass
  after post-processing, with premultiplied alpha blending and one scissor per clip region.
- **Layout.** A small flexbox: base sizes, then free space by `grow` and a shortage by `shrink`, then `justify` and
  `align`. Stacks anchor their children; grids fill cells row by row.
- **No globals.** Nothing runs on import; the only DOM access is reading the safe area, and only when you ask for it.

## Limits

- WebGPU only for drawing. On WebGL2 the UI still updates, but nothing shows.
- Text shaping is the text package's: no Arabic or Indic shaping, no ligatures.
- Layout is single-pass flexbox without wrapping rows; use a grid for wrapped content.
