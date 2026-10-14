/** Shared poses and owned controls for the UI package examples. */
export function createScene(count, description) {
  if (!Number.isInteger(count) || count < 4 || count > 64) throw new RangeError('UI workload count must be 4..64');
  const started = performance.now(), points = new Float32Array(count * 4), frozen = new Uint8Array(count), side = Math.ceil(Math.sqrt(count)), extent = side * 0.6;
  let meshes = [], time = 0, frames = 0, selected = 0, disposed = false;
  const retain = index => {if (!meshes[index]) return; const pose = meshes[index].position; points[index * 4] = pose.x; points[index * 4 + 1] = pose.y; points[index * 4 + 2] = pose.z;};
  const step = delta => {
    if (disposed) return;
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid UI frame delta');
    time += delta; frames++;
    for (let i = 0; i < count; i++) {
      if (frozen[i] && meshes[i]) {retain(i); continue;}
      points[i * 4] = (i % side - (side - 1) / 2) * 1.2;
      points[i * 4 + 1] = 0.5 + Math.sin(time * 1.5 + i * 0.6) * 0.18;
      points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 1.2; points[i * 4 + 3] = i % 3;
    }
  };
  step(0);
  const setupCpuMilliseconds = performance.now() - started;
  return {points, description, bounds: {min: [-extent, 0, -extent], max: [extent, 1.6, extent]}, step,
    get meshes() {return meshes;}, get selected() {return selected;},
    mount(context) {meshes = context.meshes; meshes.forEach((mesh, i) => {mesh.name = `Actor ${i + 1}`; mesh.scale.setAll(3);});},
    select(index) {if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Invalid actor selection'); selected = index; frozen[index] = 1; retain(index);},
    details: () => ({actors: count, frames, selectedActor: selected + 1, setupCpuMilliseconds}),
    dispose() {disposed = true; meshes = [];}
  };
}

export function controls(parent, count, onSelect) {
  const document = parent.ownerDocument, life = new document.defaultView.AbortController(), root = document.createElement('div');
  root.className = 'ui-tools'; parent.hidden = false; parent.append(root);
  const listen = (element, type, handler) => element.addEventListener(type, handler, {signal: life.signal});
  const select = (text, values, change) => {
    const label = document.createElement('label'), element = document.createElement('select'); label.append(text, element);
    for (const value of values) {const option = document.createElement('option'); option.value = value; option.textContent = value; element.append(option);}
    listen(element, 'change', () => change(element.value)); root.append(label); return element;
  };
  const actor = select('Selected actor', Array.from({length: count}, (_, i) => String(i + 1)), value => onSelect(Number(value) - 1)); actor.dataset.uiActor = '';
  return {root, actor, listen, select,
    button(text, action) {const element = document.createElement('button'); element.type = 'button'; element.textContent = text; listen(element, 'click', action); root.append(element); return element;},
    dispose() {life.abort(); root.remove();}
  };
}
