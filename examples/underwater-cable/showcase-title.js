import { Label, Panel, Ui, UiRenderer } from '@margoengine/ui';

const appearAt = 52.75;

class FilmTitle extends Panel {
  alpha = 0;

  get opacity() {
    return this.alpha;
  }

  fadeTo(time) {
    const u = Math.max(0, Math.min(1, (time - appearAt) / 0.78));
    const alpha = u * u * (3 - 2 * u);
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.visible = alpha > 0;
    this.invalidate(false);
  }
}

export function addTitle(engine) {
  const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
  const title = new FilmTitle({
    anchor: 'bottom-left',
    margin: [0, 0, 95, 97],
    gap: 8,
    background: 'none',
    pointerEvents: 'none',
    visible: false,
    children: [
      new Label({ text: 'MARGO ENGINE', size: 24, color: '#d9e8e9', outline: true, wrap: false }),
      new Label({ text: 'Below the Swell', size: 64, color: '#f4f7f5', outline: true, wrap: false }),
    ],
  });
  ui.add(title);
  UiRenderer.attach(engine, ui);
  return (time) => title.fadeTo(time);
}
