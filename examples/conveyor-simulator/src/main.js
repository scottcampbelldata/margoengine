// Conveyor maintenance simulator on Margo Engine. A port of the three.js viewer in
// "conveyor simulator.html": same markup, same embedded GLB/HDR/facts, same window.freshAssembly API.
import {Engine, Geometry, PbrMaterial} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {OrbitControls, MOUSE, TOUCH} from '@margoengine/controls';
import {Environment, parseHDR} from '@margoengine/environment';
import {Lines, GridHelper, Box3Helper} from '@margoengine/lines';
import {Selection, Picking} from '@margoengine/selection';
import {readModel, readMeshes} from './glb.js';
import {StudioShading, KEY_LIGHT} from './shading.js';

const MM_PER_UNIT = 25.4, FOV = 38;
const $ = id => document.getElementById(id);
const canvas = $('assembly-canvas'), stage = $('stage');
const facts = JSON.parse($('assembly-facts').textContent || '{}');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Vectors are plain [x, y, z] arrays; boxes are {min, max}.
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => scale(a, 1 / (length(a) || 1));
const lerp = (a, b, t) => add(a, scale(sub(b, a), t));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const emptyBox = () => ({min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity]});
const isEmpty = box => box.min.some((v, i) => v > box.max[i]);
const expandPoint = (box, p) => {for (let i = 0; i < 3; i++) {box.min[i] = Math.min(box.min[i], p[i]); box.max[i] = Math.max(box.max[i], p[i]);} return box;};
const union = (box, other) => isEmpty(other) ? box : expandPoint(expandPoint(box, other.min), other.max);
const grow = (box, amount) => ({min: box.min.map(v => v - amount), max: box.max.map(v => v + amount)});
const translate = (box, offset) => ({min: add(box.min, offset), max: add(box.max, offset)});
const boxCenter = box => scale(add(box.min, box.max), 0.5);
const boxSize = box => sub(box.max, box.min);

const state = {
  ready: false, parts: [], selected: null, isolated: null, hiddenLongCover: false, hiddenDriveCover: false, explode: 0,
  showIssues: false, reviewParts: new Set, removedParts: new Set, view: 'full', selfCheck: null, meshNodeCount: 0,
  connectionRows: [], reviewGroups: [], reviewIndex: -1,
};
const partsById = new Map, partsByName = new Map, partsByMesh = new Map, issueBoxes = new Map, tinted = new Map;
const bounds = emptyBox();
let center = [0, 0, 0], size = [0, 0, 0], sharedGeometries = 0, instancedNodes = 0;
let engine, controls, lines, selection, picking, dirty = true, transition = null, markers = [], toastTimer;

const sourceName = value => String(value || '').split(/[\\/]/).pop().replace(/\.f3d$/i, '');
const formatMm = value => Number(value).toLocaleString(undefined, {maximumFractionDigits: 2});
const isLongCover = part => /^Long cover (front|underside) screw/i.test(part.name) || /2014\.86.*cover|long yellow cover/i.test(`${part.name} ${part.source}`) && !/screw|bolt|washer/i.test(part.name);
const isDriveCover = part => /^Small cover side screw/i.test(part.name) || /Gearbox cover|small drive cover/i.test(`${part.name} ${part.source}`) && !/screw|bolt|washer/i.test(part.name);
const needsReview = part => ['unresolved', 'pending', 'failed', 'conflict'].includes(part.status);

function isShown(part) {
  if (state.removedParts.has(part.id)) return false;
  const keptScrew = /screw/i.test(part.name) && (state.selected === part || state.isolated?.has(part.id));
  return !(state.hiddenLongCover && part.longCover && !keptScrew) && !(state.hiddenDriveCover && part.driveCover && !keptScrew) && (!state.isolated || state.isolated.has(part.id));
}
const coverShown = kind => state.parts.some(part => part[kind === 'long' ? 'longCover' : 'driveCover'] && !/screw/i.test(part.name) && isShown(part));
const explodedBounds = part => translate(part.bounds, scale(part.explodeVector, state.explode));
function boundsOf(parts) {
  const box = emptyBox();
  for (const part of parts) if (isShown(part)) union(box, explodedBounds(part));
  return isEmpty(box) ? {min: [...bounds.min], max: [...bounds.max]} : box;
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;}, 3200);
}

// Selection multiplies the base color by (0.62, 0.84, 1), like the three.js instance color.
function tintedMaterial(material) {
  let tint = tinted.get(material);
  if (!tint) {const d = material.data; tint = new PbrMaterial({color: [d[0] * 0.62, d[1] * 0.84, d[2]], roughness: d[4], metalness: d[5], doubleSided: !!d[6]}); tinted.set(material, tint);}
  return tint;
}

function applyState() {
  for (const part of state.parts) {
    const shown = isShown(part), offset = scale(part.explodeVector, state.explode);
    part.visible = shown; part.mesh.visible = shown;
    part.mesh.position.set(part.basePosition[0] + offset[0], part.basePosition[1] + offset[1], part.basePosition[2] + offset[2]);
    part.mesh.setMaterial(state.selected === part ? tintedMaterial(part.material) : part.material);
    const outlined = state.showIssues && state.reviewParts.has(part.id) && shown && state.selected !== part;
    let box = issueBoxes.get(part.id);
    if (outlined && !box && lines) {box = lines.add(new Box3Helper(part.bounds.min, part.bounds.max, {color: '#b76348', opacity: 0.48, onTop: true})); issueBoxes.set(part.id, box);}
    if (box) {box.visible = outlined; if (outlined) {const b = explodedBounds(part); box.setBox(b.min, b.max);}}
  }
  selection?.set(state.selected?.visible ? [state.selected.mesh] : []);
  $('isolate-part').textContent = state.isolated ? 'Show assembly' : 'Inspect connection';
  for (const [kind, label] of [['long', 'long cover'], ['drive', 'small cover']]) {
    const shown = coverShown(kind), button = $(kind === 'long' ? 'long-cover-toggle' : 'drive-cover-toggle');
    button.setAttribute('aria-pressed', String(shown)); button.textContent = `${shown ? 'Remove' : 'Reinstall'} ${label}`;
  }
  dirty = true;
}

function worldBounds(mesh, node) {
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1], t = node.translation ?? [0, 0, 0], box = emptyBox();
  const rotate = p => {const u = [x, y, z], uv = cross(u, p), uuv = cross(u, uv); return add(p, scale(add(scale(uv, w), uuv), 2));};
  for (let corner = 0; corner < 8; corner++) expandPoint(box, add(rotate([0, 1, 2].map(a => (corner >> a & 1 ? mesh.max : mesh.min)[a] * s[a])), t));
  return box;
}

function buildAssembly(glb) {
  const meshes = readMeshes(glb), {doc} = glb;
  const geometries = meshes.map(mesh => new Geometry(mesh.positions, mesh.normals, mesh.indices));
  const materials = (doc.materials ?? []).map(material => {
    const pbr = material.pbrMetallicRoughness ?? {};
    return new PbrMaterial({color: (pbr.baseColorFactor ?? [1, 1, 1]).slice(0, 3), roughness: pbr.roughnessFactor ?? 1, metalness: pbr.metallicFactor ?? 1, doubleSided: material.doubleSided ?? false});
  });
  const fallback = new PbrMaterial({color: [1, 1, 1], roughness: 1, metalness: 1, doubleSided: false}), uses = new Map;
  // The assembly is flat: every scene node is one mesh and one physical part.
  for (const index of doc.scenes[doc.scene ?? 0].nodes) {
    const node = doc.nodes[index];
    if (node.mesh === undefined) continue;
    if (node.children?.length || node.matrix) throw new Error('Expected a flat assembly of translated, rotated and scaled parts');
    const data = node.extras ?? {}, source = meshes[node.mesh], material = materials[source.material] ?? fallback;
    const mesh = engine.createMesh().setPosition(node.translation ?? [0, 0, 0]).setQuaternion(node.rotation ?? [0, 0, 0, 1]).setScale(node.scale ?? [1, 1, 1]).setGeometry(geometries[node.mesh]).setMaterial(material);
    mesh.name = node.name ?? '';
    const part = {
      id: `part-${state.parts.length}`, mesh, material, name: node.name || `Part ${state.parts.length + 1}`,
      source: sourceName(data.fresh_source_label || data.source_path || data.source_part), data,
      status: String(data.fresh_fit_status || 'unverified').toLowerCase(), reason: String(data.unresolved_reason || ''),
      bounds: worldBounds(source, node), dimensions: data.fresh_native_dimensions_mm || data.source_dimensions_mm || null,
      basePosition: [...(node.translation ?? [0, 0, 0])], triangles: source.indices.length / 3, explodeVector: [0, 0, 0], visible: true,
    };
    state.parts.push(part); partsById.set(part.id, part); partsByName.set(part.name, part); partsByMesh.set(mesh, part);
    uses.set(node.mesh, (uses.get(node.mesh) ?? 0) + 1); state.meshNodeCount++;
  }
  for (const count of uses.values()) if (count >= 3) {sharedGeometries++; instancedNodes += count;}
  for (const part of state.parts) union(bounds, part.bounds);
  center = boxCenter(bounds); size = boxSize(bounds);
  const reach = length(size) * 0.115;
  for (const part of state.parts) {
    part.longCover = isLongCover(part); part.driveCover = isDriveCover(part);
    const saved = part.data.fresh_explode_vector;
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite)) part.explodeVector = [...saved];
    else {
      let vector = sub(boxCenter(part.bounds), center); vector[1] *= 1.8;
      if (dot(vector, vector) < 1e-8) vector = [0, 1, 0];
      part.explodeVector = scale(normalize(vector), reach);
    }
  }
  if (lines) {
    const grid = lines.add(new GridHelper({size: Math.max(size[0], size[2]) * 1.45, divisions: 24, color1: '#bac5ce', color2: '#d0d9e0', opacity: 0.36}));
    grid.matrix[12] = center[0]; grid.matrix[13] = bounds.min[1] - size[1] * 0.012; grid.matrix[14] = center[2];
  }
  controls.minDistance = length(size) * 0.008; controls.maxDistance = length(size) * 5;
  engine.camera.near = Math.max(length(size) / 1e4, 0.001); engine.camera.far = length(size) * 25;
  applyState();
}

function frameBox(box, direction, immediate = false) {
  let target = boxCenter(box);
  const extent = boxSize(box), forward = normalize(direction);
  let right = cross(forward, [0, 1, 0]);
  if (dot(right, right) < 1e-8) right = [1, 0, 0];
  right = normalize(right);
  const up = normalize(cross(right, forward));
  let halfWidth = 0, halfHeight = 0, halfDepth = 0;
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    const corner = [extent[0] * x, extent[1] * y, extent[2] * z];
    halfWidth = Math.max(halfWidth, Math.abs(dot(corner, right))); halfHeight = Math.max(halfHeight, Math.abs(dot(corner, up))); halfDepth = Math.max(halfDepth, Math.abs(dot(corner, forward)));
  }
  const tan = Math.tan(FOV * Math.PI / 360), height = Math.max(stage.clientHeight, 1), aspect = Math.max(stage.clientWidth, 1) / height;
  const top = document.querySelector('.viewbar').getBoundingClientRect().height + 27, bottom = document.querySelector('.tools').getBoundingClientRect().height + 30;
  const usable = Math.max(height - top - bottom, height * 0.45);
  const distance = (Math.max(halfHeight / tan * height / usable, halfWidth / (tan * aspect)) + halfDepth) * 1.16;
  target = add(target, scale(up, -(bottom - top) / height * distance * tan));
  const position = add(target, scale(forward, Math.max(distance, length(size) * 0.012)));
  if (immediate || reducedMotion) {transition = null; engine.camera.position = position; engine.camera.target = target;}
  else transition = {start: performance.now(), duration: 460, fromPosition: [...engine.camera.position], fromTarget: [...engine.camera.target], position, target};
  dirty = true;
}
const viewDirection = view => view === 'top' ? [0.001, 1, 0.001] : view === 'under' ? [0.65, -0.8, 1] : view === 'side' ? [0.08, 0.12, 1] : view === 'drive' ? [0.65, 0.32, 1] : [1, 0.67, 1.08];
function setView(view = 'full', immediate = false) {
  if (!state.ready) return;
  state.view = view;
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view);
  let parts = state.parts;
  if (view === 'drive') {parts = state.parts.filter(part => /motor|gearbox|take.up|tension|pulley|idler|drive guard|mount.*bracket/i.test(`${part.name} ${part.source}`)); if (!parts.length) parts = state.parts;}
  frameBox(boundsOf(parts), viewDirection(view), immediate);
}

function showSelection() {
  const part = state.selected, removed = part && state.removedParts.has(part.id);
  $('selected-name').textContent = part ? part.name : 'Choose a part';
  $('selected-source').textContent = part ? part.source || 'Saved assembly part' : 'Click the model, or use the parts list.';
  $('focus-part').disabled = !part || removed; $('isolate-part').disabled = !part || removed;
  $('remove-part').disabled = !part; $('remove-part').textContent = removed ? 'Reinstall part' : 'Remove part';
  $('selected-badge').hidden = !part; $('selected-reason').hidden = !part?.reason; $('selected-reason').textContent = part?.reason || '';
  if (part) {
    const saved = Array.isArray(part.dimensions) && part.dimensions.length >= 3 && part.dimensions.slice(0, 3).every(v => Number.isFinite(Number(v)));
    const dimensions = saved ? part.dimensions.slice(0, 3).map(Number) : scale(boxSize(part.bounds), MM_PER_UNIT);
    $('selected-dimensions').textContent = `${dimensions.map(formatMm).join(' \xD7 ')} mm`;
    $('selected-dimensions').title = part.dimensions ? 'Saved native part dimensions' : 'Assembly-oriented bounding dimensions';
    const badge = $('selected-badge');
    badge.className = `badge ${needsReview(part) ? 'unresolved' : part.status === 'unverified' ? 'unverified' : ''}`;
    badge.textContent = removed ? 'Removed' : needsReview(part) ? 'Interface needs review' : part.status === 'checked' ? 'Recorded check complete' : 'Interface not verified';
  } else $('selected-dimensions').textContent = '';
  listConnectionChecks(); $('part-options').open = !state.connectionRows.length;
}

function connectionPoint(row) {
  const hole = row.leg_bore_world_center_mm || row.leg_slot_world_center_mm, normal = row.normal_outward;
  return scale(add(hole, scale(normal, dot(sub(row.plate_outer_face_world_mm, hole), normal))), 1 / MM_PER_UNIT);
}
function zoomToConnection() {
  if (!state.connectionRows.length) return;
  const box = emptyBox();
  for (const row of state.connectionRows) expandPoint(box, connectionPoint(row));
  frameBox(grow(translate(box, scale(state.selected.explodeVector, state.explode)), 35 / MM_PER_UNIT), add(state.connectionRows[0].normal_outward, [0, 0.08, 0.12]));
}
const svg = (viewBox, label) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', viewBox); element.setAttribute('role', 'img'); element.setAttribute('aria-label', label);
  return element;
};
function showConnection(group, zoom = false) {
  const rows = (facts.connectionChecks || []).filter(row => row.clearance_part === state.selected?.name && row.review_group === group);
  if (!rows.length) return false;
  state.connectionRows = rows; state.reviewIndex = state.reviewGroups.findIndex(item => item.id === group); updateReviewNav();
  for (const button of $('selected-checks').querySelectorAll('[data-check-group]')) button.setAttribute('aria-pressed', String(button.dataset.checkGroup === group));
  const detail = $('connection-detail');
  detail.replaceChildren();
  const brace = rows[0].group === 'leg_to_lower_brace', intro = document.createElement('p');
  intro.textContent = brace ? 'Verify the two lower brace mounting holes marked 1 and 2.' : 'Verify the two rail mounting slots marked 1 and 2 near the leg’s top.';
  detail.append(intro);
  const worst = rows.reduce((a, b) => b.remaining_radial_margin_mm < a.remaining_radial_margin_mm ? b : a);
  const dimensions = [[brace ? 'Leg hole diameter' : 'Leg slot width', worst.leg_bore_mm || worst.clearance_slot_width_mm], ...brace ? [['Leg hole center spacing', worst.leg_pitch_mm], ['Brace bolt center spacing', worst.brace_pitch_mm], ['Brace top to upper hole rim', worst.brace_top_to_upper_hole_rim_mm], ['Hole rim above brace bottom', Math.min(...rows.map(row => row.brace_hole_bottom_edge_gap_mm))]] : []];
  const table = document.createElement('table');
  table.setAttribute('aria-label', 'Saved model connection dimensions');
  for (const [label, value] of dimensions) {
    const row = table.insertRow(), header = document.createElement('th');
    header.scope = 'row'; header.textContent = label; row.append(header); row.insertCell().textContent = `${value.toFixed(3)} mm`;
  }
  detail.append(table);
  const washer = brace ? Math.min(...rows.map(row => row.washer_to_brace_bottom_edge_margin_mm)) : 0, margin = worst.remaining_radial_margin_mm, result = document.createElement('p');
  result.className = 'connection-result';
  result.textContent = washer < 0 ? `Bolt axes align with ${margin.toFixed(3)} mm clearance, but the lower washer extends ${(-washer).toFixed(3)} mm below the brace. Hole height is unresolved; positions have not been moved.`
    : margin >= 0 ? `The saved bolt fits, with ${margin.toFixed(3)} mm of clearance remaining.`
    : margin >= -(worst.training_tolerance_mm || 0) ? `The ${(-margin).toFixed(3)} mm difference is accepted for the training model.`
    : `In the saved model, the bolt exceeds the available hole clearance by ${(-margin).toFixed(3)} mm.`;
  detail.append(result);
  const zoomButton = document.createElement('button');
  zoomButton.type = 'button'; zoomButton.id = 'focus-connection'; zoomButton.textContent = 'Zoom to these holes'; zoomButton.addEventListener('click', zoomToConnection);
  detail.append(zoomButton);
  if (brace) {
    const drawing = svg('0 0 300 160', 'Local drawing of the two leg holes and two brace bolt axes with their saved center spacings'), leg = worst.leg_pitch_mm * 0.6, bolt = worst.brace_pitch_mm * 0.6;
    drawing.classList.add('spacing-drawing');
    drawing.innerHTML = `<defs><marker id="dimension-arrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M6 0L0 3L6 6" fill="#526271"/></marker></defs><text x="55" y="18" text-anchor="middle" fill="#17689e" font-size="12">Leg holes</text><text x="215" y="18" text-anchor="middle" fill="#a94f2e" font-size="12">Brace bolts</text><path d="M25 30V125 M85 30V125" stroke="#aebbc5"/><path d="M185 30V125 M245 30V125" stroke="#aebbc5"/>${[[-1, 2], [1, 1]].map(([side, number]) => `<circle cx="55" cy="${80 + side * leg}" r="${worst.leg_bore_mm * 0.6}" fill="#edf5fb" stroke="#17689e"/><text x="55" y="${84 + side * leg}" text-anchor="middle" fill="#17689e" font-size="10">${number}</text><circle cx="215" cy="${80 + side * bolt}" r="${worst.bolt_crest_mm * 0.6}" fill="#fff5ee" stroke="#a94f2e"/>`).join('')}<path d="M68 ${80 - leg}H120 M68 ${80 + leg}H120 M120 ${80 - leg}V${80 + leg}" fill="none" stroke="#526271"/><path d="M228 ${80 - bolt}H280 M228 ${80 + bolt}H280 M280 ${80 - bolt}V${80 + bolt}" fill="none" stroke="#526271"/><path d="M120 ${80 - leg}V${80 + leg} M280 ${80 - bolt}V${80 + bolt}" stroke="#526271" marker-start="url(#dimension-arrow)" marker-end="url(#dimension-arrow)"/><text transform="translate(113 80) rotate(-90)" text-anchor="middle" font-size="12" fill="#202b35">${worst.leg_pitch_mm.toFixed(3)} mm</text><text transform="translate(273 80) rotate(-90)" text-anchor="middle" font-size="12" fill="#202b35">${worst.brace_pitch_mm.toFixed(3)} mm</text><text x="55" y="148" text-anchor="middle" fill="#17689e" font-size="11">\xD8${worst.leg_bore_mm.toFixed(3)} mm</text><text x="215" y="148" text-anchor="middle" fill="#a94f2e" font-size="11">\xD8${worst.bolt_crest_mm.toFixed(3)} mm</text>`;
    detail.append(drawing);
  }
  const exact = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = 'Exact fit numbers and section'; exact.append(summary);
  const numbers = document.createElement('p');
  numbers.textContent = `Bolt-to-hole center offset: ${worst.axis_offset_mm.toFixed(3)} mm. Available clearance: ${worst.radial_clearance_budget_mm.toFixed(3)} mm.`; exact.append(numbers);
  const hole = worst.leg_bore_world_center_mm || worst.leg_slot_world_center_mm, axis = worst.axis_center_world_mm, across = brace ? 2 : 0, zoomFactor = 10;
  const radius = (worst.leg_bore_mm || worst.clearance_slot_width_mm) / 2 * zoomFactor, dx = brace ? (axis[across] - hole[across]) * zoomFactor : 0, dy = -(axis[1] - hole[1]) * zoomFactor;
  const section = svg('0 0 180 150', 'Blue hole boundary and orange bolt boundary at their actual relative offset');
  section.innerHTML = `${brace ? `<circle cx="90" cy="75" r="${radius}" fill="none" stroke="#17689e" stroke-width="2"/>` : `<path d="M15 ${75 - radius}H165 M15 ${75 + radius}H165" fill="none" stroke="#17689e" stroke-width="2"/>`}<circle cx="${90 + dx}" cy="${75 + dy}" r="${worst.bolt_crest_mm / 2 * zoomFactor}" fill="#a94f2e14" stroke="#a94f2e" stroke-width="2"/><path d="M85 75h10 M90 70v10" stroke="#17689e"/><path d="M${85 + dx} ${75 + dy}h10 M${90 + dx} ${70 + dy}v10" stroke="#a94f2e"/>`;
  exact.append(section);
  const key = document.createElement('p');
  key.innerHTML = `<span class="hole-key">Blue: leg ${brace ? 'hole' : 'slot'}</span> \xB7 <span class="bolt-key">Orange: bolt</span>`;
  exact.append(key); detail.append(exact);
  $('connection-markers').replaceChildren();
  markers = rows.map((row, index) => {
    const label = document.createElement('button');
    label.type = 'button'; label.className = 'connection-marker'; label.textContent = String(index + 1);
    label.setAttribute('aria-label', `Zoom to ${state.selected.name} ${brace ? 'lower brace hole' : 'rail slot'} ${index + 1}`);
    label.addEventListener('click', zoomToConnection); $('connection-markers').append(label);
    return {label, point: connectionPoint(row)};
  });
  dirty = true;
  if (zoom) zoomToConnection();
  return true;
}
function listConnectionChecks() {
  const container = $('selected-checks'), rows = (facts.connectionChecks || []).filter(row => row.clearance_part === state.selected?.name);
  container.replaceChildren(); container.hidden = !rows.length; state.connectionRows = []; markers = []; $('connection-markers').replaceChildren();
  if (!rows.length) return;
  $('selected-reason').hidden = true;
  const choices = document.createElement('div');
  choices.className = 'check-choices';
  for (const group of new Set(rows.map(row => row.review_group))) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.checkGroup = group; button.textContent = group === 'source_lower_brace_leg_fit' ? 'Lower brace holes' : 'Top rail slots';
    button.addEventListener('click', () => showConnection(group)); choices.append(button);
  }
  const detail = document.createElement('div');
  detail.id = 'connection-detail'; container.append(choices, detail); showConnection(rows[0].review_group);
}
function placeMarkers() {
  const m = engine.camera.matrix, width = stage.clientWidth, height = stage.clientHeight;
  for (const marker of markers) {
    const p = add(marker.point, scale(state.selected.explodeVector, state.explode));
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    const x = ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) / 2 * width, y = (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) / 2 * height;
    marker.label.hidden = !state.selected.visible || w <= 0 || x < 0 || x > width || y < 0 || y > height;
    marker.label.style.left = `${x}px`; marker.label.style.top = `${y}px`;
  }
}

function selectPart(idOrName, focus = false) {
  const part = idOrName == null ? null : partsById.get(idOrName) || partsByName.get(idOrName);
  if (idOrName != null && !part) return false;
  if (part && !isShown(part)) {
    if (!state.removedParts.has(part.id)) {if (part.longCover) setCoverVisibility('long', true); if (part.driveCover) setCoverVisibility('drive', true);}
    state.isolated = null;
  }
  state.selected = part;
  if (!part) state.isolated = null;
  state.reviewIndex = part ? state.reviewGroups.findIndex(group => groupParts(group).includes(part)) : -1;
  state.reviewParts.clear(); state.showIssues = false;
  $('toast').hidden = true; $('show-fit-issues').checked = false; $('show-fit-issues').disabled = true;
  showSelection(); applyState(); listParts(); showPane(part ? 'detail' : 'parts');
  if (focus && part && !state.removedParts.has(part.id)) focusSelection();
  return true;
}
function listParts() {
  const list = $('part-list'), query = $('part-search').value.toLocaleLowerCase().trim(), found = state.parts.filter(part => `${part.name} ${part.source}`.toLocaleLowerCase().includes(query));
  list.replaceChildren();
  const note = document.createElement('div');
  note.className = 'result-note'; note.textContent = `${found.length} ${found.length === 1 ? 'part' : 'parts'}${found.length > 80 ? ' \xB7 refine search to see more' : ''}`; list.append(note);
  for (const part of found.slice(0, 80)) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = `part-row${state.selected === part ? ' selected' : ''}`; row.dataset.partId = part.id;
    if (needsReview(part)) {const dot = document.createElement('span'); dot.className = 'pending-dot'; dot.setAttribute('aria-hidden', 'true'); row.append(dot);}
    row.append(document.createTextNode(part.name));
    if (state.removedParts.has(part.id)) {const small = document.createElement('small'); small.textContent = 'Removed \xB7 select to reinstall'; row.append(small);}
    if (part.source && part.source !== part.name) {const small = document.createElement('small'); small.textContent = part.source; row.append(small);}
    row.addEventListener('click', () => selectPart(part.id, true)); list.append(row);
  }
}

function namedParts(group) {
  const names = Array.isArray(group.parts) ? group.parts : [];
  return state.parts.filter(part => names.includes(part.name) || group.id && part.data.fresh_fit_group === group.id || names.some(name => part.name.startsWith(`${name} `)));
}
function connectionParts(rows) {
  const names = new Set(rows.flatMap(row => [row.host, row.clearance_part]));
  return state.parts.filter(part => names.has(part.name) || rows.some(row => part.name.startsWith(`${row.hardware_prefix} `)));
}
const GROUP_HARDWARE = {
  bracket_drive_pitch: /^Motor clamp[56] /, motor_bracket_U_slot: /^Motor clamp7 /, motor_bracket_pattern: /^(Motor - |Motor clamp[1-4] )/,
  motor_retaining_washer: /^(Motor - |Motor pulley retaining |Measured silver motor pulley$)/, takeup_side_axis: /^Take-up /,
  'long-cover-receivers': /^Long cover /, 'small-cover-slots': /^Small cover /,
};
const GROUP_CONNECTION = {source_lower_brace_leg_fit: 'leg_to_lower_brace', source_front_leg_slot_tolerance: 'leg_to_rail'};
function groupParts(group) {
  const parts = new Set(namedParts(group)), hardware = GROUP_HARDWARE[group.id], connection = GROUP_CONNECTION[group.id];
  if (hardware) for (const part of state.parts) if (hardware.test(part.name)) parts.add(part);
  if (connection) for (const part of connectionParts((facts.frameConnections || []).filter(row => row.group === connection && group.parts.includes(row.clearance_part)))) parts.add(part);
  return [...parts];
}
function relatedParts() {
  const part = state.selected;
  if (!part) return [];
  const connections = facts.frameConnections || [], hardware = connections.find(row => part.name.startsWith(`${row.hardware_prefix} `));
  if (hardware) return connectionParts(connections.filter(row => row.host === hardware.host && row.clearance_part === hardware.clearance_part && row.group === hardware.group));
  const own = connections.filter(row => row.host === part.name || row.clearance_part === part.name);
  if (own.some(row => row.group === 'leg_to_lower_brace')) return connectionParts(state.connectionRows.length ? own.filter(row => row.group === state.connectionRows[0].group) : own);
  if (/^(Motor pulley retaining |Measured silver motor pulley$)/.test(part.name)) return groupParts({id: 'motor_retaining_washer', parts: []});
  if (part.name === 'Long yellow cover' || /^Long cover /.test(part.name)) return groupParts({id: 'long-cover-receivers', parts: ['Long yellow cover', 'Measured drive rail']});
  if (part.name === 'Small drive cover' || /^Small cover /.test(part.name)) return groupParts({id: 'small-cover-slots', parts: ['Small drive cover', 'Black motor mounting bracket']});
  const group = state.reviewGroups[state.reviewIndex];
  if (group && groupParts(group).includes(part)) {
    const rows = connections.filter(row => row.clearance_part === part.name && row.group === (group.id === 'source_lower_brace_leg_fit' ? 'leg_to_lower_brace' : 'leg_to_rail'));
    return rows.length ? connectionParts(rows) : groupParts(group);
  }
  const bearing = part.name.match(/^(Bearing (\d+) (rear|front)|Center bearing (\d+)) /);
  return bearing ? state.parts.filter(other => other.name.startsWith(`${bearing[1]} `) || other.name === `Shaft ${bearing[2] || bearing[4]}` || other.name === (bearing[3] === 'rear' ? 'Rear black rail' : bearing[3] === 'front' ? 'Measured drive rail' : 'Center aluminum bearing rail')) : [part];
}
function hideCoversOver(parts) {
  const screw = /screw/i.test(state.selected?.name || '');
  setCoverVisibility('long', parts.some(part => part.longCover) && !(screw && state.selected.longCover));
  setCoverVisibility('drive', parts.some(part => part.driveCover) && !(screw && state.selected.driveCover));
}
function focusSelection(parts = relatedParts()) {
  if (!state.selected) return;
  hideCoversOver(parts);
  const framed = parts.some(part => part.name === 'Black motor mounting bracket') ? parts.filter(part => !/rail$|end beam$/.test(part.name)) : parts;
  const box = /bolt|screw|washer|nut/i.test(state.selected.name) ? grow(explodedBounds(state.selected), 35 / MM_PER_UNIT) : boundsOf(framed);
  const connection = (facts.frameConnections || []).find(row => state.selected.name.startsWith(`${row.hardware_prefix} `)), bearing = state.selected.name.match(/^(Bearing \d+ (rear|front)|Center bearing \d+) /);
  frameBox(box, connection ? add(connection.normal_outward, [0, 0.12, 0.12]) : bearing ? [0.2, bearing[2] ? 0.2 : 1, bearing[2] === 'front' ? -1 : 1] : viewDirection('drive'));
}
function isolateSelection() {
  if (!state.selected) return false;
  const parts = relatedParts();
  state.isolated = new Set(parts.map(part => part.id)); focusSelection(parts); applyState();
  return true;
}
function showAll() {state.isolated = null; setCoverVisibility('long', true); setCoverVisibility('drive', true); setView(state.view);}

function listIssues() {
  const list = $('issue-list');
  list.replaceChildren();
  let groups = Array.isArray(facts.unresolvedGroups) ? [...facts.unresolvedGroups] : [];
  if (!groups.length) {
    const byReason = new Map;
    for (const part of state.parts.filter(needsReview)) {const reason = part.reason || 'This interface has not been resolved.'; if (!byReason.has(reason)) byReason.set(reason, []); byReason.get(reason).push(part.name);}
    groups = [...byReason].map(([reason, parts]) => ({title: 'Pending interface', reason, parts}));
  }
  state.reviewGroups = groups; $('issue-count').textContent = groups.length ? `(${groups.length})` : '';
  if (!groups.length) {const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No pending group was supplied. This does not verify every mechanical interface.'; list.append(empty);}
  for (const group of groups) {
    const parts = namedParts(group), card = document.createElement('button'), title = document.createElement('strong'), count = document.createElement('small');
    card.type = 'button'; card.className = 'issue-card'; title.textContent = group.title || group.id || 'Pending interface';
    count.textContent = parts.length ? `Show ${parts.length} related ${parts.length === 1 ? 'part' : 'parts'}` : 'No matching installed part';
    card.append(title, count); card.disabled = !parts.length; card.addEventListener('click', () => reviewGroup(groups.indexOf(group))); list.append(card);
  }
  for (const note of facts.referenceNotes || []) {
    const block = document.createElement('div'), title = document.createElement('strong'), reason = document.createElement('p');
    block.className = 'unplaced reference-note'; title.textContent = note.title; reason.textContent = note.reason; block.append(title, reason); list.append(block);
  }
  if (facts.unplacedParts?.length) {
    const block = document.createElement('div'), title = document.createElement('strong');
    block.className = 'unplaced'; title.textContent = 'Saved separately \xB7 placement not supplied'; block.append(title);
    for (const item of facts.unplacedParts) {const row = document.createElement('div'); row.textContent = typeof item === 'string' ? item : item.name || item.title || item.source || 'Separate saved part'; block.append(row);}
    list.append(block);
  }
}

function setCoverVisibility(kind, visible, reinstall = false) {
  if (reinstall) {
    state.isolated = null;
    for (const part of state.parts.filter(part => part[kind === 'long' ? 'longCover' : 'driveCover'] && !/screw/i.test(part.name))) visible ? state.removedParts.delete(part.id) : state.removedParts.add(part.id);
    visible = true;
  }
  if (kind === 'long') state.hiddenLongCover = !visible; else state.hiddenDriveCover = !visible;
  $(kind === 'long' ? 'long-cover-toggle' : 'drive-cover-toggle').setAttribute('aria-pressed', String(visible));
  applyState();
  if (reinstall) {showSelection(); listParts();}
}
function toggleRemoved() {
  const part = state.selected;
  if (!part) return;
  const removed = state.removedParts.has(part.id);
  removed ? state.removedParts.delete(part.id) : state.removedParts.add(part.id);
  if (removed && (part.longCover || part.driveCover) && !/screw/i.test(part.name)) setCoverVisibility(part.longCover ? 'long' : 'drive', true); else applyState();
  showSelection(); listParts();
}
function setExplode(amount) {state.explode = clamp(Number(amount), 0, 1); $('explode-range').value = String(Math.round(state.explode * 100)); applyState();}
function restoreAssembly() {state.removedParts.clear(); state.isolated = null; selectPart(null); setExplode(0); setCoverVisibility('long', true); setCoverVisibility('drive', true); setView('full');}
function showPane(pane) {
  document.querySelector('.selection').hidden = pane !== 'detail'; $('review-nav').hidden = pane !== 'detail';
  for (const name of ['parts', 'issues']) {
    const active = name === pane;
    $(`${name}-tab`).classList.toggle('active', active); $(`${name}-tab`).setAttribute('aria-selected', String(active)); $(`${name}-pane`).hidden = !active;
  }
  if (pane !== 'detail') {
    $('selected-name').textContent = pane === 'issues' ? 'Fit review' : 'Choose a part';
    $('selected-source').textContent = pane === 'issues' ? 'Choose a connection to inspect.' : 'Click the model, or find a saved part below.';
  }
  $('panel-body').scrollTop = 0; updateReviewNav();
}
function updateReviewNav() {
  const reviewing = state.reviewIndex >= 0;
  $('review-back').textContent = reviewing ? 'Back to issues' : 'Back to parts';
  $('review-position').textContent = reviewing ? `${state.reviewIndex + 1} / ${state.reviewGroups.length}` : '';
  $('review-prev').hidden = $('review-next').hidden = !reviewing;
  $('review-prev').disabled = state.reviewIndex <= 0; $('review-next').disabled = !reviewing || state.reviewIndex >= state.reviewGroups.length - 1;
}
function reviewGroup(index) {
  const group = state.reviewGroups[index];
  if (!group) return false;
  const parts = namedParts(group);
  if (!parts.length) return false;
  state.isolated = null;
  selectPart((parts.includes(state.selected) ? state.selected : parts.find(needsReview) || parts[0]).id);
  hideCoversOver(groupParts(group));
  state.reviewIndex = index; state.reviewParts = new Set(parts.map(part => part.id)); $('show-fit-issues').disabled = false;
  if (!showConnection(group.id, true)) {$('selected-reason').textContent = group.reason; $('selected-reason').hidden = false; focusSelection(groupParts(group));}
  updateReviewNav();
  return true;
}
function leaveSelection() {
  const pane = state.reviewIndex >= 0 ? 'issues' : 'parts';
  if (state.isolated) showAll();
  selectPart(null); showPane(pane);
}

function check() {
  const problems = [];
  if (![...bounds.min, ...bounds.max].every(Number.isFinite) || isEmpty(bounds)) problems.push('Model bounds are empty or nonfinite.');
  if (facts.partCount && state.meshNodeCount !== facts.partCount) problems.push(`Expected ${facts.partCount} physical mesh nodes; loaded ${state.meshNodeCount}.`);
  const sourceCount = new Set(state.parts.map(part => part.data.fresh_source_sha256 || part.data.source_sha256 || part.data.source_path || part.source).filter(Boolean)).size;
  if (facts.sourceCount && sourceCount !== facts.sourceCount) problems.push(`Expected ${facts.sourceCount} saved sources; loaded ${sourceCount}.`);
  return {
    passed: !problems.length, problems, meshNodeCount: state.meshNodeCount, physicalPartCount: state.parts.length, sourceCount,
    sharedGeometryBatches: sharedGeometries, instancedMeshNodes: instancedNodes, dimensionsUnit: 'mm', geometryUnits: 'in', millimetersPerUnit: MM_PER_UNIT,
    boundsMm: {min: scale(bounds.min, MM_PER_UNIT), max: scale(bounds.max, MM_PER_UNIT)},
  };
}

function embedded(id) {
  const text = $(id)?.textContent.trim();
  if (!text || text.startsWith('{{')) return null;
  const binary = atob(text.replace(/\s/g, '')), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function load() {
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    engine = await Engine.create(canvas, {capacity: 1024, camera: {fov: FOV, position: [100, 75, 110], near: 0.01, far: 2000}});
    const runtime = engineRuntime(engine), shading = new StudioShading;
    runtime.lighting.direction.set(KEY_LIGHT.direction); runtime.lighting.radiance.set(KEY_LIGHT.radiance);
    engine.use(shading);
    // Lines and outlines need WebGPU; the WebGL2 fallback keeps the model, camera and panel.
    if (engine.backend === 'webgpu') {lines = Lines.attach(engine); picking = api.picking = Picking.attach(engine, {capture: false}); selection = Selection.attach(engine, {width: 2, color: [0.09, 0.41, 0.62]});}
    controls = new OrbitControls(engine.camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.085; controls.screenSpacePanning = true; controls.listenToKeyEvents(canvas);
    controls.addEventListener('start', () => {transition = null;});
    controls.addEventListener('change', () => {dirty = true;});
    api.engine = engine; api.camera = engine.camera; api.controls = controls;

    const model = embedded('model-data');
    if (!model) throw new Error('The saved-part model is missing from this HTML.');
    $('loading-message').textContent = 'Reading the saved geometry…';
    const buffer = model[0] === 31 && model[1] === 139 ? await new Response(new Blob([model]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : model.buffer;
    buildAssembly(readModel(buffer));
    state.ready = true; state.selfCheck = check(); listParts(); listIssues();
    $('long-cover-toggle').disabled = !state.parts.some(part => part.longCover); $('drive-cover-toggle').disabled = !state.parts.some(part => part.driveCover);
    $('assembly-summary').textContent = `${facts.partCount || state.meshNodeCount} parts \xB7 ${facts.sourceCount || state.selfCheck.sourceCount} saved sources`;
    $('status-dot').classList.add('ready'); $('loading').hidden = true; setView('full', true);
    if (!state.selfCheck.passed) toast('Assembly loaded with an inventory discrepancy. See the fit review.');
    requestAnimationFrame(frame);
    document.dispatchEvent(new CustomEvent('fresh-assembly-ready', {detail: state.selfCheck}));

    const hdr = embedded('environment-data');
    if (hdr && engine.backend === 'webgpu') try {
      const environment = await Environment.attach(engine, parseHDR(hdr));
      shading.environment = environment; dirty = true;
    } catch (error) {state.environmentWarning = String(error);}
  } catch (error) {
    state.error = String(error?.message || error);
    $('loading').classList.add('error'); $('loading-title').textContent = 'Assembly could not load'; $('loading-message').textContent = state.error;
    $('retry-load').hidden = false; $('assembly-summary').textContent = 'Model unavailable';
  }
}

let press, lastFrame = 0;
canvas.addEventListener('pointerdown', event => {canvas.focus({preventScroll: true}); press = event.button === 0 && event.isPrimary ? {x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId} : null;});
canvas.addEventListener('pointercancel', () => {press = null;});
canvas.addEventListener('pointerup', async event => {
  const start = press;
  press = null;
  if (!state.ready || event.button !== 0 || !start || start.id !== event.pointerId || performance.now() - start.time > 650 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
  const part = await pickPart(event.clientX, event.clientY);
  if (part) selectPart(part.id); else leaveSelection();
  // Picking is asynchronous here, so tools that time a click need to know when it has been applied.
  document.dispatchEvent(new CustomEvent('fresh-assembly-pick', {detail: part?.name ?? null}));
});
/** True when the view ray through a canvas point crosses the box of any visible part. */
function rayNearPart(x, y) {
  const camera = engine.camera, forward = normalize(sub(camera.target, camera.position)), right = normalize(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const tan = Math.tan(FOV * Math.PI / 360), origin = camera.position;
  const direction = add(forward, add(scale(right, (2 * x / canvas.clientWidth - 1) * tan * canvas.clientWidth / canvas.clientHeight), scale(up, (1 - 2 * y / canvas.clientHeight) * tan)));
  return state.parts.some(part => {
    if (!part.visible) return false;
    const box = explodedBounds(part);
    let near = 0, far = Infinity;
    for (let a = 0; a < 3; a++) {
      const t1 = (box.min[a] - origin[a]) / direction[a], t2 = (box.max[a] - origin[a]) / direction[a]; // A zero component gives +-Infinity, which the min/max handle.
      near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
    }
    return near <= far;
  });
}
/** The visible part under a client-space point, from the package's culled GPU ID pass. */
async function pickPart(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rayNearPart(clientX - rect.left, clientY - rect.top)) return null; // Skip the GPU readback for clicks on empty space.
  if (!picking) return null; // No GPU picking on WebGL2.
  if (dirty) {dirty = false; engine.render(); placeMarkers();} // The ID pass reads the transforms of the last rendered frame.
  // Calling the plugin directly needs no pick hook in core.
  return partsByMesh.get(await picking.onPick(clientX - rect.left, clientY - rect.top)) ?? null;
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
for (const button of document.querySelectorAll('[data-navigation]')) button.addEventListener('click', () => {
  const pan = button.dataset.navigation === 'pan';
  controls.mouseButtons.LEFT = pan ? MOUSE.PAN : MOUSE.ROTATE; controls.touches.ONE = pan ? TOUCH.PAN : TOUCH.ROTATE;
  for (const other of document.querySelectorAll('[data-navigation]')) other.setAttribute('aria-pressed', String(other === button));
  canvas.focus({preventScroll: true});
});
// Margo's dollyIn(factor) divides the distance by factor; three.js multiplies it.
const zoom = closer => {transition = null; controls[closer ? 'dollyIn' : 'dollyOut'](1 / 0.85);};
for (const button of document.querySelectorAll('[data-zoom]')) button.addEventListener('click', () => zoom(button.dataset.zoom === 'in'));
$('long-cover-toggle').addEventListener('click', () => setCoverVisibility('long', $('long-cover-toggle').getAttribute('aria-pressed') !== 'true', true));
$('drive-cover-toggle').addEventListener('click', () => setCoverVisibility('drive', $('drive-cover-toggle').getAttribute('aria-pressed') !== 'true', true));
$('remove-part').addEventListener('click', toggleRemoved);
$('explode-range').addEventListener('input', event => setExplode(Number(event.target.value) / 100));
$('restore-assembly').addEventListener('click', restoreAssembly);
$('focus-part').addEventListener('click', () => focusSelection());
$('isolate-part').addEventListener('click', () => {state.isolated ? showAll() : isolateSelection();});
$('show-all').addEventListener('click', showAll);
$('show-fit-issues').addEventListener('change', event => {state.showIssues = event.target.checked; applyState();});
$('part-search').addEventListener('input', listParts);
$('parts-tab').addEventListener('click', () => {selectPart(null); showPane('parts');});
$('issues-tab').addEventListener('click', () => {selectPart(null); showPane('issues');});
$('review-back').addEventListener('click', leaveSelection);
$('review-prev').addEventListener('click', () => reviewGroup(state.reviewIndex - 1));
$('review-next').addEventListener('click', () => reviewGroup(state.reviewIndex + 1));
$('retry-load').addEventListener('click', () => location.reload());
canvas.addEventListener('keydown', event => {
  if (event.key.startsWith('Arrow')) transition = null;
  if (event.key.toLowerCase() === 'f' || event.key === 'Home') {event.preventDefault(); setView('full');}
  if (['+', '=', '-', '_'].includes(event.key)) {event.preventDefault(); zoom(!'-_'.includes(event.key));}
  if (event.key === 'Escape') {state.isolated = null; leaveSelection();}
});
new ResizeObserver(() => {
  if (!stage.clientWidth || !stage.clientHeight) return;
  if (state.ready && !state.selected) setView(state.view, true);
  dirty = true;
}).observe(stage);

// Like the three.js viewer, a frame is drawn only when something changed.
function frame(time) {
  requestAnimationFrame(frame);
  const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 0;
  lastFrame = time;
  if (transition) {
    const t = clamp((time - transition.start) / transition.duration, 0, 1), eased = t * t * (3 - 2 * t);
    engine.camera.position = lerp(transition.fromPosition, transition.position, eased); engine.camera.target = lerp(transition.fromTarget, transition.target, eased);
    dirty = true;
    if (t === 1) transition = null;
  }
  if (controls.update(delta)) dirty = true;
  if (!dirty) return;
  dirty = false; engine.render({delta}); placeMarkers();
}

const api = window.freshAssembly = {
  state, facts, engine: null, camera: null, controls: null, picking: null, selectPart, setView, setExplode, setCoverVisibility, restoreAssembly, showAll, check, pickPart,
  isolatePart: id => selectPart(id) ? isolateSelection() : false,
  focusParts(names) {
    const parts = state.parts.filter(part => names.includes(part.name) || names.includes(part.id));
    if (parts.length) frameBox(boundsOf(parts), viewDirection('drive'));
    return !!parts.length;
  },
  snapshot: () => ({
    ready: state.ready, error: state.error || null, selfCheck: state.selfCheck, meshNodes: state.meshNodeCount, physicalParts: state.parts.length,
    visibleParts: state.parts.filter(isShown).length, batches: sharedGeometries, selected: state.selected?.name || null, selectionOutlined: !!state.selected?.visible,
    outlinedParts: [...issueBoxes].filter(([, box]) => box.visible).map(([id]) => id), isolated: !!state.isolated, explode: state.explode,
    longCoverVisible: coverShown('long'), driveCoverVisible: coverShown('drive'), view: state.view, backend: engine?.backend ?? null,
    renderer: {calls: engine?.stats.drawCalls ?? 0, triangles: state.parts.reduce((sum, part) => sum + (part.visible ? part.triangles : 0), 0)},
  }),
};
load();
