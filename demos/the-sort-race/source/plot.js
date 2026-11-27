import { COUNT } from './input.mjs';

export function createPlot(canvas, accent) {
  const context = canvas.getContext('2d', { alpha: false });
  let values;
  let ordered = false, original, progress = 1, frame = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width, height, ratio;
  const paint = () => {
    if (!values || width === undefined) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#100f17';
    context.fillRect(0, 0, width, height);

    const margin = { x: 7, y: 8 };
    const plotWidth = width - 2 * margin.x, plotHeight = height - 2 * margin.y;
    context.strokeStyle = '#373340';
    context.lineWidth = .65;
    context.beginPath();
    for (let n = 0; n <= 4; n++) {
      const x = margin.x + n * plotWidth / 4;
      const y = margin.y + n * plotHeight / 4;
      context.moveTo(x, margin.y);
      context.lineTo(x, height - margin.y);
      context.moveTo(margin.x, y);
      context.lineTo(width - margin.x, y);
    }
    context.stroke();
    const xAt = index => margin.x + index * plotWidth / (values.length - 1);
    const yAt = value => height - margin.y - value * plotHeight / (COUNT - 1);
    if (ordered && progress > .23) {
      context.globalAlpha = Math.min(1, (progress - .23) / .63);
      const gradient = context.createLinearGradient(0, margin.y, 0, height);
      gradient.addColorStop(0, accent + '30');
      gradient.addColorStop(1, accent + '04');
      context.beginPath();
      context.moveTo(xAt(0), height - margin.y);
      for (let i = 0; i < values.length; i++) context.lineTo(xAt(i), yAt(values[i]));
      context.lineTo(width - margin.x, height - margin.y);
      context.closePath();
      context.fillStyle = gradient;
      context.fill();
      context.beginPath();
      context.moveTo(xAt(0), yAt(values[0]));
      for (let i = 1; i < values.length; i++) context.lineTo(xAt(i), yAt(values[i]));
      context.strokeStyle = accent;
      context.lineWidth = 2;
      context.stroke();
      context.fillStyle = accent;
      for (let n = 0; n <= 4; n++) {
        const index = Math.round(n * (values.length - 1) / 4);
        context.beginPath();
        context.arc(xAt(index), yAt(values[index]), 2.6, 0, 2 * Math.PI);
        context.fill();
      }
      context.globalAlpha = 1;
    }
    if (!ordered || progress < 1) {
      const shown = ordered ? original : values;
      const dot = Math.max(.9, Math.min(1.6, width * .003));
      context.fillStyle = accent;
      for (let i = 0; i < shown.length; i++) {
        const value = shown[i];
        const sortedAt = margin.x + value * plotWidth / (COUNT - 1);
        const x = ordered ? xAt(i) + progress * (sortedAt - xAt(i)) : xAt(i);
        context.globalAlpha = (.24 + .46 * value / (COUNT - 1)) * (ordered ? 1 - progress : 1);
        context.fillRect(x - dot / 2, yAt(value) - dot / 2, dot, dot);
      }
      context.globalAlpha = 1;
    }
  };
  const resize = () => {
    const size = canvas.getBoundingClientRect();
    ratio = Math.min(2.5, devicePixelRatio);
    canvas.width = Math.max(1, Math.round(size.width * ratio));
    canvas.height = Math.max(1, Math.round(size.height * ratio));
    width = canvas.width / ratio;
    height = canvas.height / ratio;
    paint();
  };
  resize();
  new ResizeObserver(resize).observe(canvas);
  return (data, sorted) => {
    cancelAnimationFrame(frame);
    original = sorted && !ordered ? values : undefined;
    ordered = sorted;
    values = data;
    progress = original && !reducedMotion.matches ? 0 : 1;
    canvas.setAttribute('aria-label',
      (canvas.id === 'margo-plot' ? 'Margo' : 'CPU') +
      (ordered ? ' sorted output, sampled points rise in order from 0 to 999,999.'
        : ' input, sampled values are shuffled across all indices.'));
    paint();
    canvas.dataset.frame = progress === 1 ? 'static' : 'moving';
    if (progress === 1) return;
    const started = performance.now();
    const move = time => {
      const t = Math.min(1, Math.max(0, (time - started) / 460));
      progress = 1 - (1 - t) ** 3;
      paint();
      if (t < 1) frame = requestAnimationFrame(move);
      else canvas.dataset.frame = 'static';
    };
    frame = requestAnimationFrame(move);
  };
}
