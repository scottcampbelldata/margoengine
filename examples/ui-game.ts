// Game UI demo: a title menu, a HUD with a health bar and an inventory, a pause menu, settings and dialogs, drawn by
// @margoengine/ui over a small spinning scene. Mouse, touch, keyboard and gamepad all work; a hidden DOM mirror lets
// screen readers read the same interface. The game keys (D, F, Esc) go to the game unless the UI has focus or a dialog is open.
import { createStage } from 'margoengine';
import {
  Button,
  HealthBar,
  Inventory,
  Label,
  List,
  Menu,
  Panel,
  Slider,
  Toggle,
  Ui,
  UiRenderer,
  themes,
  type InventoryItem,
} from '@margoengine/ui';

declare global {
  interface Window {
    uiDemo?: { ui: Ui; screen: () => string; health: () => number };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!,
  status = document.querySelector<HTMLParagraphElement>('#status')!;
const life = new AbortController();
window.addEventListener('pagehide', () => life.abort(), { once: true });

try {
  // The backdrop: an orb among a few turning boxes. The camera is fixed (no orbit controls to fight the UI).
  const app = await createStage(canvas, { controls: false, label: 'A game scene with a user interface drawn on top' });
  const orb = app.sphere({ radius: 1, color: '#84d6bd', roughness: 0.25 });
  const crates = [-3.2, 3.2].map((x, i) =>
    app.box({ size: [1.1, 1.1, 1.1], color: i ? '#e69f00' : '#56b4e9', position: [x, -0.4, 0] }),
  );
  app.fit();
  // The backdrop holds still under prefers-reduced-motion (and so in the visual checks' still frame).
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  app.onTick((delta) => {
    if (reduced.matches) return;
    orb.setRotation([0, orb.rotation.y + delta * 0.6, 0]);
    crates.forEach((crate, i) => crate.setRotation([0, crate.rotation.y + delta * (i ? -0.9 : 0.9), 0]));
  });

  // One Ui for the whole game. A reference size keeps it readable in a small canvas and in fullscreen.
  const ui = new Ui({ scale: { reference: [960, 540], match: 0.5, min: 0.6, max: 2.2 } });
  UiRenderer.attach(app.engine, ui);
  await ui.ready;

  let screen: 'title' | 'play' | 'pause' = 'title';
  let health = 100,
    gold = 0;

  // --- HUD -------------------------------------------------------------------------------------------------------

  const bar = new HealthBar({ id: 'health', value: health, width: 260 });
  const goldLabel = new Label({ text: 'Gold 0', color: 'warning', size: 'large' });
  const stats = new Panel({
    id: 'stats',
    background: 'scrim',
    padding: [10, 14],
    gap: 8,
    anchor: 'top-left',
    margin: 16,
    children: [bar, goldLabel],
  });

  const items: (InventoryItem | null)[] = [
    { id: 'potion', name: 'Healing potion', icon: '🧪', count: 3, description: 'Restores 25 health', color: 'success' },
    { id: 'bomb', name: 'Bomb', icon: '💣', count: 2, description: 'Hurts you by 15. Why would you?', color: 'danger' },
    { id: 'key', name: 'Iron key', icon: '🗝️', description: 'Opens something, somewhere', color: 'accent' },
    { id: 'map', name: 'Old map', icon: '🗺️', description: 'Half of it is missing', color: 'info' },
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const bag = new Inventory({ id: 'bag', label: 'Backpack', columns: 5, slots: 10, items });
  const bagPanel = new Panel({
    background: 'scrim',
    padding: 10,
    gap: 8,
    anchor: 'bottom-right',
    margin: 16,
    children: [new Label({ text: 'Backpack', size: 'small', color: 'textMuted' }), bag],
  });

  const hint = new Label({
    text: 'Drag items, or pick up and put down with Enter',
    color: 'textMuted',
    size: 'small',
    anchor: 'bottom',
    margin: 8,
    outline: true,
  });
  const actions = new Panel({
    direction: 'row',
    gap: 8,
    background: 'scrim',
    padding: 8,
    anchor: 'bottom-left',
    margin: 16,
    children: [
      new Button({ text: 'Take damage', icon: '💥', tooltip: 'Lose 20 health (D)', onClick: () => damage(20) }),
      new Button({ text: 'Find item', icon: '🎁', tooltip: 'Find something in the grass (F)', onClick: () => find() }),
      new Button({ text: 'Pause', variant: 'ghost', tooltip: 'Pause the game (Esc)', onClick: () => pause() }),
    ],
  });
  const hud = [stats, bagPanel, actions, hint];

  bag.on('use', async (e) => {
    const item = e.item as InventoryItem,
      slot = e.index!;
    if (item.id === 'potion') {
      heal(25);
      consume(slot);
    } else if (item.id === 'bomb') {
      damage(15);
      consume(slot);
    } else ui.toast(`${item.name}: nothing happens`);
  });
  function consume(slot: number): void {
    const item = bag.get(slot);
    if (!item) return;
    bag.set(slot, (item.count ?? 1) > 1 ? { ...item, count: (item.count ?? 1) - 1 } : null);
  }

  function setHealth(next: number): void {
    health = Math.max(0, Math.min(100, next));
    bar.value = health;
  }
  function heal(amount: number): void {
    setHealth(health + amount);
    ui.toast(`Healed ${amount}`, { kind: 'success' });
  }
  async function damage(amount: number): Promise<void> {
    if (screen !== 'play' || health <= 0) return;
    setHealth(health - amount);
    ui.toast(`Ouch, ${amount} damage`, { kind: health < 30 ? 'danger' : 'warning' });
    if (health > 0) return;
    const again = await ui
      .dialog({
        title: 'You fell',
        message: 'Your health ran out. Try again from the last camp?',
        buttons: [
          { label: 'Respawn', value: true },
          { label: 'Quit to title', value: false },
        ],
        dismissible: false,
        signal: life.signal,
      })
      .catch(() => false);
    if (again) setHealth(100);
    else title();
  }
  const FOUND = [
    { id: 'potion', name: 'Healing potion', icon: '🧪', count: 1, description: 'Restores 25 health', color: 'success' },
    { id: 'coin', name: 'Gold coin', icon: '🪙', count: 1, description: 'Shiny', color: 'warning' },
  ];
  function find(): void {
    if (screen !== 'play') return;
    const found = FOUND[Math.floor(Math.random() * FOUND.length)];
    if (found.id === 'coin') {
      gold += 5;
      goldLabel.text = `Gold ${gold}`;
      ui.toast('Found 5 gold', { kind: 'success' });
      return;
    }
    const at = items.findIndex((_, i) => bag.get(i)?.id === found.id);
    const slot = at >= 0 ? at : items.findIndex((_, i) => !bag.get(i));
    if (slot < 0) ui.toast('Your backpack is full', { kind: 'warning' });
    else {
      const have = bag.get(slot);
      bag.set(slot, have ? { ...have, count: (have.count ?? 1) + 1 } : { ...found });
      ui.toast(`Found ${found.name}`, { kind: 'info', action: { label: 'Undo', onClick: () => consume(slot) } });
    }
  }

  // --- Screens ---------------------------------------------------------------------------------------------------

  const titleMenu = new Menu({
    title: 'Margo Quest',
    items: [
      { label: 'Play', icon: '▶', onSelect: () => play() },
      { label: 'Settings', onSelect: () => settings() },
      { label: 'How to play', onSelect: () => help() },
    ],
  });
  const pauseMenu = new Menu({
    title: 'Paused',
    items: [
      { label: 'Resume', onSelect: () => play() },
      { label: 'Settings', variant: 'secondary', onSelect: () => settings() },
      {
        label: 'Quit to title',
        variant: 'danger',
        onSelect: async () => {
          const quit = await ui
            .confirm('Quit to the title screen? Your progress is lost.', {
              title: 'Quit?',
              confirmLabel: 'Quit',
              cancelLabel: 'Keep playing',
              signal: life.signal,
            })
            .catch(() => false);
          if (quit) title();
        },
      },
    ],
  });

  function show(next: typeof screen): void {
    screen = next;
    ui.root.clear();
    ui.focus(null);
    if (next === 'title') ui.add(titleMenu);
    if (next === 'pause') ui.add(pauseMenu);
    // Menus take the keys, so the arrows work from the first press; in play the game keeps them.
    ui.captureKeys = next !== 'play';
    if (next === 'play') ui.add(...hud);
    status.textContent = { title: 'Title screen', play: 'Playing', pause: 'Paused' }[next];
  }
  function title(): void {
    gold = 0;
    goldLabel.text = 'Gold 0';
    setHealth(100);
    show('title');
  }
  function play(): void {
    show('play');
  }
  function pause(): void {
    if (screen === 'play') show('pause');
  }

  async function help(): Promise<void> {
    await ui
      .alert(
        'Click or tap, or use the arrow keys and Enter. Press Esc to pause. Drag items between slots. Everything here is drawn by the engine, so it also works in fullscreen.',
        {
          title: 'How to play',
          signal: life.signal,
        },
      )
      .catch(() => {});
  }

  function settings(): void {
    const names = ['Dark', 'Light', 'High contrast'],
      choices = [themes.dark, themes.light, themes.highContrast];
    const panel = new Panel({
      background: 'surface',
      border: true,
      shadow: true,
      padding: 20,
      gap: 12,
      width: 380,
      anchor: 'center',
      label: 'Settings',
    });
    panel.add(
      new Label({ text: 'Settings', size: 'title' }),
      new Label({ text: 'Theme', color: 'textMuted' }),
      new List({
        items: names,
        selected: choices.indexOf(ui.theme),
        height: 120,
        onSelect: (e) => (ui.theme = choices[e.index!]),
      }),
      new Slider({
        text: 'Text size',
        min: 0.75,
        max: 2,
        step: 0.25,
        value: ui.textScale,
        format: (v) => `${v}×`,
        onChange: (e) => (ui.textScale = e.value as number),
      }),
      new Slider({
        text: 'Volume',
        value: 0.8,
        onChange: (e) => ui.announce(`Volume ${Math.round((e.value as number) * 100)} percent`),
      }),
      new Toggle({ text: 'Reduce motion', checked: !ui.motion, onChange: (e) => (ui.motion = !e.value) }),
      new Button({ text: 'Done', variant: 'primary', onClick: () => back() }),
    );
    const back = () => {
      panel.removeFromParent();
      ui.focus(null);
      if (screen === 'title') ui.add(titleMenu);
      else ui.add(pauseMenu);
      ui.captureKeys = true;
    };
    ui.root.clear();
    ui.add(panel);
  }

  // --- Game keys: only when the UI has not taken them -------------------------------------------------------------

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        if (ui.cancel()) return;
        if (screen === 'play') pause();
        else if (screen === 'pause') play();
      } else if (screen === 'play' && !ui.focused) {
        if (key === 'd') void damage(20);
        else if (key === 'f') find();
      }
    },
    { signal: life.signal },
  );

  title();
  window.uiDemo = { ui, screen: () => screen, health: () => health };
  canvas.dataset.ready = 'true';
} catch (error) {
  status.textContent = `Could not start: ${(error as Error).message}`;
}
