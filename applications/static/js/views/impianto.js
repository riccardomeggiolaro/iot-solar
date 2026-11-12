// Impianto: vista 3D in tempo reale (three.js incluso nel progetto, funziona senza internet).
// Un campo di pannelli per ogni inverter, generato dai kWp; inverter, quadro di consegna,
// sensore di irraggiamento, flussi di energia e sole nella posizione reale (o simulata).
// Clic su un elemento: dettagli. Trascinamento: sposta l'elemento (posizione salvata, come in iot-weight).

import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from '../vendor/three/CSS2DRenderer.js';
import { plant, deviceState } from '../plant.js';
import { esc, kw, kwh, formatNumber } from '../ui.js';

const POS_KEY = 'kinetra-energia.3d.positions';
const PANEL_WP = 400;          // potenza di un pannello: serve solo a decidere quanti disegnarne
const PANEL_W = 1.05, PANEL_H = 1.75, TILT = THREE.MathUtils.degToRad(25);
const MAX_COLS = 12, ROW_GAP = 2.4;
const STATE_COLOR = { ok: 0x138a4b, warn: 0xd99100, err: 0xc0262d, '': 0x8b95a5 };

function loadPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (_) { return {}; } }
function savePositions(p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (_) {} }
function isDark() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(bg);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3 < 100;
}

/** Texture delle celle fotovoltaiche, condivisa da tutti i pannelli. */
function cellTexture() {
  const c = document.createElement('canvas');
  c.width = 120; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#1b2f63'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(190,210,255,.35)'; g.lineWidth = 2;
  for (let x = 0; x <= 6; x++) { g.beginPath(); g.moveTo(x * 20, 0); g.lineTo(x * 20, 200); g.stroke(); }
  for (let y = 0; y <= 10; y++) { g.beginPath(); g.moveTo(0, y * 20); g.lineTo(120, y * 20); g.stroke(); }
  g.strokeStyle = '#c9d1dc'; g.lineWidth = 6; g.strokeRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function label(html, cls = '', name = '') {
  const div = document.createElement('div');
  div.className = `lbl3d ${cls}`;
  div.dataset.name = name;
  div.innerHTML = html;
  return new CSS2DObject(div);
}

export function renderImpianto(el) {
  el.innerHTML = `
    <div class="plant3d">
      <div class="plant3d-canvas"></div>
      <div class="plant3d-bar card">
        <span class="plant3d-time" data-time>—</span>
        <span class="plant3d-legend">
          <span><i style="background:var(--ok)"></i>In produzione</span>
          <span><i style="background:var(--warn)"></i>Rende meno</span>
          <span><i style="background:var(--err)"></i>Guasto / non comunica</span>
          <span><i style="background:var(--idle)"></i>In attesa del sole</span>
        </span>
        <button type="button" class="btn small" data-reset title="Riporta tutti gli elementi nella disposizione automatica">Ripristina posizioni</button>
      </div>
      <aside class="plant3d-detail card" hidden></aside>
      <p class="plant3d-hint muted">Trascina per ruotare · rotella per lo zoom · clic su un elemento per i dettagli · trascina un elemento per spostarlo</p>
    </div>`;
  const host = el.querySelector('.plant3d-canvas');
  const detail = el.querySelector('.plant3d-detail');
  const timeEl = el.querySelector('[data-time]');

  // ── Renderer, scena, camera ─────────────────────────────────
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (_) {
    host.innerHTML = '<div class="placeholder"><div class="big">🧊</div><h2>Vista 3D non disponibile</h2><p class="muted">Il browser o la scheda grafica non supportano WebGL.</p></div>';
    return () => {};
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'plant3d-labels';
  host.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  controls.minDistance = 8;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x6d7a63, 0.9);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight, sunLight.target);
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffd36b }));
  scene.add(sunMesh);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xcdd8c4, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(600, 120, 0x9fae98, 0xb8c4b0);
  grid.position.y = 0.01;
  grid.material.transparent = true; grid.material.opacity = 0.35;
  scene.add(grid);

  const panelTexture = cellTexture();
  const disposables = [panelTexture];

  // ── Modello: oggetti per nome ───────────────────────────────
  let signature = '';
  let items = {};          // name -> { group, kind, ... }
  let flows = [];          // { curve, dots, speed, active }
  let clickable = [];      // mesh -> name (userData.name)
  let world = new THREE.Group();
  scene.add(world);
  let positions = loadPositions();

  function material(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, ...opts });
    disposables.push(m);
    return m;
  }
  function geometry(g) { disposables.push(g); return g; }

  function buildField(d) {
    const n = Math.max(4, Math.min(240, Math.round(d.kwp * 1000 / PANEL_WP)));
    const cols = Math.min(MAX_COLS, n);
    const rows = Math.ceil(n / cols);
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ map: panelTexture, roughness: 0.32, metalness: 0.35, emissive: 0x000000 });
    disposables.push(mat);
    const panels = new THREE.InstancedMesh(geometry(new THREE.BoxGeometry(PANEL_W, 0.05, PANEL_H)), mat, n);
    panels.castShadow = true; panels.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(TILT, 0, 0));
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const x = (c - (cols - 1) / 2) * (PANEL_W + 0.06);
      m4.compose(new THREE.Vector3(x, 0.95, -r * ROW_GAP), q, new THREE.Vector3(1, 1, 1));
      panels.setMatrixAt(i, m4);
    }
    group.add(panels);
    // base colorata sotto il campo: mostra lo stato dell'inverter senza alterare il colore dei pannelli
    const width0 = cols * (PANEL_W + 0.06);
    const depth0 = (rows - 1) * ROW_GAP + PANEL_H;
    const padMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.ok, transparent: true, opacity: 0.28, depthWrite: false });
    disposables.push(padMat);
    const pad = new THREE.Mesh(geometry(new THREE.PlaneGeometry(width0 + 1.2, depth0 + 1.4)), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.02, -(depth0 - PANEL_H) / 2);
    group.add(pad);
    // strutture di sostegno: una trave per fila
    const beamMat = material(0x9aa4b1, { metalness: 0.6, roughness: 0.4 });
    const width = cols * (PANEL_W + 0.06);
    for (let r = 0; r < rows; r++) {
      const beam = new THREE.Mesh(geometry(new THREE.BoxGeometry(width + 0.3, 0.08, 0.08)), beamMat);
      beam.position.set(0, 0.55, -r * ROW_GAP - 0.55);
      beam.castShadow = true;
      group.add(beam);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(geometry(new THREE.BoxGeometry(0.08, 0.6, 0.08)), beamMat);
        leg.position.set(side * width / 2, 0.3, -r * ROW_GAP - 0.55);
        group.add(leg);
      }
    }
    panels.userData.name = d.name;
    clickable.push(panels);
    return { group, panels, mat, padMat, width, depth: depth0, rows, cols, n };
  }

  function buildInverter(d) {
    const g = new THREE.Group();
    g.scale.setScalar(1.7);
    const body = new THREE.Mesh(geometry(new THREE.BoxGeometry(1.1, 1.5, 0.55)), material(0xe9edf2, { roughness: 0.35 }));
    body.position.y = 1.05; body.castShadow = true;
    const screen = new THREE.Mesh(geometry(new THREE.PlaneGeometry(0.6, 0.3)), material(0x17202e, { roughness: 0.2 }));
    screen.position.set(0, 1.35, 0.281);
    const ledMat = new THREE.MeshStandardMaterial({ color: STATE_COLOR.ok, emissive: STATE_COLOR.ok, emissiveIntensity: 1.2 });
    disposables.push(ledMat);
    const led = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.07, 16, 12)), ledMat);
    led.position.set(0, 0.95, 0.29);
    const stand = new THREE.Mesh(geometry(new THREE.BoxGeometry(0.12, 0.35, 0.12)), material(0x8b95a5));
    stand.position.y = 0.17;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xc0262d, transparent: true, opacity: 0 });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(geometry(new THREE.RingGeometry(0.9, 1.2, 40)), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    g.add(body, screen, led, stand, ring);
    [body, screen].forEach(m => { m.userData.name = d.name; clickable.push(m); });
    const lbl = label('', 'inv', d.name);
    lbl.position.set(0, 2.1, 0);
    g.add(lbl);
    return { group: g, ledMat, ring, ringMat, lbl };
  }

  function buildQuadro() {
    const g = new THREE.Group();
    g.scale.setScalar(1.4);
    const body = new THREE.Mesh(geometry(new THREE.BoxGeometry(2.4, 2.1, 0.9)), material(0x0f1e3d, { roughness: 0.4, metalness: 0.3 }));
    body.position.y = 1.05; body.castShadow = true;
    const stripe = new THREE.Mesh(geometry(new THREE.BoxGeometry(2.42, 0.16, 0.92)), material(0xf26a1b, { emissive: 0xf26a1b, emissiveIntensity: 0.25 }));
    stripe.position.y = 1.75;
    const pole = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.09, 0.12, 5, 10)), material(0x7c8796));
    pole.position.set(1.8, 2.5, -0.2); pole.castShadow = true;
    const arm = new THREE.Mesh(geometry(new THREE.BoxGeometry(1.4, 0.1, 0.1)), material(0x7c8796));
    arm.position.set(1.8, 4.7, -0.2);
    g.add(body, stripe, pole, arm);
    body.userData.name = '__quadro'; clickable.push(body);
    const lbl = label('', 'quadro', '__quadro');
    lbl.position.set(0, 2.9, 0);
    g.add(lbl);
    return { group: g, lbl };
  }

  function buildSensor(d) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.05, 0.06, 2.6, 10)), material(0x9aa4b1, { metalness: 0.6 }));
    pole.position.y = 1.3; pole.castShadow = true;
    const head = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 20)), material(0xe9edf2));
    head.position.y = 2.66;
    const dome = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.13, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
      material(0xbfd4ff, { transparent: true, opacity: 0.7, roughness: 0.05 }));
    dome.position.y = 2.72;
    g.add(pole, head, dome);
    [pole, head].forEach(m => { m.userData.name = d.name; clickable.push(m); });
    const lbl = label('', 'sensor', d.name);
    lbl.position.set(0, 3.3, 0);
    g.add(lbl);
    return { group: g, lbl };
  }

  /** Cavo a L: dall'inverter verso sud fino alla dorsale, poi lungo la dorsale fino al quadro. */
  function buildFlow(from, to, lane = 0) {
    const y = 0.12;
    const busZ = to.z - 2.2 - lane * 0.35;
    const pts = [new THREE.Vector3(from.x, y, from.z + 0.6), new THREE.Vector3(from.x, y, busZ),
      new THREE.Vector3(to.x + lane * 0.35, y, busZ), new THREE.Vector3(to.x + lane * 0.35, y, to.z)];
    const curve = new THREE.CurvePath();
    for (let i = 0; i < pts.length - 1; i++) curve.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    const cable = new THREE.Mesh(geometry(new THREE.TubeGeometry(curve, 96, 0.06, 6, false)), material(0x3d4655, { roughness: 0.8 }));
    world.add(cable);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x5b8ff0 });
    disposables.push(dotMat);
    const dotGeo = geometry(new THREE.SphereGeometry(0.2, 12, 8));
    const dots = Array.from({ length: 10 }, (_, i) => {
      const m = new THREE.Mesh(dotGeo, dotMat);
      m.userData.t = i / 10;
      world.add(m);
      return m;
    });
    return { curve, cable, dots, speed: 0, density: 0 };
  }

  // ── Disposizione automatica ─────────────────────────────────
  function rebuild(p) {
    // svuota la scena precedente
    scene.remove(world);
    world.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
    world = new THREE.Group();
    scene.add(world);
    items = {}; flows = []; clickable = [];

    const inverters = p.devices.filter(d => d.type === 'inverter');
    const sensors = p.devices.filter(d => d.type === 'irradiance');
    const fields = inverters.map(d => ({ d, field: buildField(d), inv: buildInverter(d) }));
    const cols = Math.max(1, Math.ceil(Math.sqrt(fields.length)));
    const cellW = Math.max(8, ...fields.map(f => f.field.width)) + 5;
    const cellD = Math.max(6, ...fields.map(f => f.field.depth)) + 6;

    fields.forEach(({ d, field, inv }, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const group = new THREE.Group();
      field.group.position.set(0, 0, 0);
      inv.group.position.set(field.width / 2 - 1, 0, 2.6);
      group.add(field.group, inv.group);
      const auto = new THREE.Vector3((col - (cols - 1) / 2) * cellW, 0, -row * cellD - 4);
      const saved = positions[d.name];
      group.position.copy(saved ? new THREE.Vector3(saved[0], 0, saved[1]) : auto);
      group.userData.name = d.name;
      world.add(group);
      items[d.name] = { kind: 'inverter', group, field, inv, d };
    });

    const quadro = buildQuadro();
    const qSaved = positions.__quadro;
    quadro.group.position.copy(qSaved ? new THREE.Vector3(qSaved[0], 0, qSaved[1]) : new THREE.Vector3(0, 0, 9));
    quadro.group.userData.name = '__quadro';
    world.add(quadro.group);
    items.__quadro = { kind: 'quadro', group: quadro.group, quadro };

    sensors.forEach((d, i) => {
      const s = buildSensor(d);
      const saved = positions[d.name];
      const first = fields[0];
      const auto = first ? new THREE.Vector3(-(cols * cellW) / 2 - 2 - i * 2, 0, -2) : new THREE.Vector3(-6 - i * 2, 0, 4);
      s.group.position.copy(saved ? new THREE.Vector3(saved[0], 0, saved[1]) : auto);
      s.group.userData.name = d.name;
      world.add(s.group);
      items[d.name] = { kind: 'sensor', group: s.group, sensor: s, d };
    });

    world.updateMatrixWorld(true);
    inverterItems().forEach((it, i) => { it.lane = i; it.flow = buildFlow(cabinetWorld(it), quadroInput(), i); flows.push(it.flow); });
    frameCamera();
  }

  const inverterItems = () => Object.values(items).filter(it => it.kind === 'inverter');
  const cabinetWorld = it => it.inv.group.getWorldPosition(new THREE.Vector3());
  const quadroInput = () => items.__quadro.group.position.clone().add(new THREE.Vector3(0, 0, -0.5));

  function refreshFlow(it) {
    if (!it.flow) return;
    world.remove(it.flow.cable);
    it.flow.dots.forEach(d => world.remove(d));
    flows = flows.filter(f => f !== it.flow);
    world.updateMatrixWorld(true);
    it.flow = buildFlow(cabinetWorld(it), quadroInput(), it.lane);
    flows.push(it.flow);
  }

  let framed = false;
  function frameCamera(force = false) {
    if (framed && !force) return;
    const box = new THREE.Box3().setFromObject(world);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 12);
    // distanza per far stare tutto l'impianto nello schermo (sfera che lo contiene, campo visivo più stretto tra i due)
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 8);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2) * 0.82;
    const dir = new THREE.Vector3(0.18, 0.62, 0.76).normalize();
    center.y = 0;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.maxDistance = extent * 4;
    const sh = sunLight.shadow.camera;
    sh.left = -extent; sh.right = extent; sh.top = extent; sh.bottom = -extent; sh.near = 1; sh.far = 600;
    sh.updateProjectionMatrix();
    sunLight.target.position.copy(center);
    framed = true;
  }

  // ── Aggiornamento dai dati ──────────────────────────────────
  let last = null;
  function update(p) {
    if (!p) return;
    last = p;
    const sig = p.devices.map(d => `${d.name}:${d.type}:${d.kwp}`).join('|');
    if (sig !== signature) { signature = sig; framed = false; rebuild(p); }

    const alarmed = new Set(p.active_alarms.map(a => a.device));
    for (const d of p.devices) {
      const it = items[d.name];
      if (!it) continue;
      if (it.kind === 'inverter') {
        const st = deviceState(d);
        const v = d.values || {};
        const color = STATE_COLOR[st.kind];
        it.inv.ledMat.color.setHex(color); it.inv.ledMat.emissive.setHex(color);
        it.field.padMat.color.setHex(color);
        it.field.padMat.opacity = st.kind === '' ? 0.12 : 0.32;
        it.field.mat.color.setHex(d.online && st.kind !== 'err' ? 0xffffff : 0x7d838c);
        it.alarm = alarmed.has(d.name);
        const ratio = d.expected_w ? (v.ac_power_w || 0) / d.expected_w : null;
        it.inv.lbl.element.className = `lbl3d inv ${st.kind}`;
        it.inv.lbl.element.innerHTML = `<b>${esc(d.name)}</b><span>${d.online ? esc(kw(v.ac_power_w)) : 'non comunica'}${ratio != null && d.online ? ` · ${Math.round(ratio * 100)}%` : ''}</span>`;
        const load = d.online && d.kwp ? Math.min(1, (v.ac_power_w || 0) / (d.kwp * 1000)) : 0;
        it.flow.speed = 0.08 + load * 0.45;
        it.flow.density = load > 0.005 ? Math.max(2, Math.round(load * 10)) : 0;
      } else if (it.kind === 'sensor') {
        const poa = d.values?.poa_wm2;
        it.sensor.lbl.element.className = `lbl3d sensor ${d.online ? '' : 'err'}`;
        it.sensor.lbl.element.innerHTML = `<b>${esc(d.name)}</b><span>${d.online ? `${poa ?? '—'} W/m²` : 'non comunica'}</span>`;
      }
    }
    const q = items.__quadro;
    if (q) {
      q.quadro.lbl.element.className = 'lbl3d quadro';
      q.quadro.lbl.element.innerHTML = `<b>Quadro di consegna</b><span>${esc(kw(p.power_w))} verso la rete</span>`;
    }
    updateSun(p.sun);
    if (!detail.hidden && detail.dataset.name) showDetail(detail.dataset.name);
  }

  function updateSun(sun) {
    if (!sun) return;
    const el = THREE.MathUtils.degToRad(sun.elevation), az = THREE.MathUtils.degToRad(sun.azimuth);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    const center = controls.target;
    sunLight.position.copy(center).addScaledVector(dir, 120);
    sunMesh.position.copy(center).addScaledVector(dir, 260);
    const day = Math.max(0, Math.min(1, (sun.elevation + 2) / 12));
    sunMesh.visible = sun.elevation > -1;
    sunLight.intensity = 2.6 * day;
    hemi.intensity = 0.25 + 0.75 * day;
    const dark = isDark();
    const daySky = new THREE.Color(dark ? 0x1a2433 : 0xdde8f5);
    const nightSky = new THREE.Color(dark ? 0x070a10 : 0x27324a);
    scene.background = nightSky.clone().lerp(daySky, day);
    scene.fog = new THREE.Fog(scene.background, 120, 520);
    ground.material.color.setHex(dark ? 0x26302a : 0xcdd8c4);
    grid.material.opacity = dark ? 0.07 : 0.35;
    const time = new Date(sun.time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    timeEl.innerHTML = `${sun.simulated ? '<span class="badge warn">Simulato</span> ' : ''}Ore ${esc(time)} · sole a ${formatNumber(sun.elevation, 0)}° ${sun.elevation < 0 ? '(notte)' : `· ${direction(sun.azimuth)}`}`;
  }
  const direction = a => ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'][Math.round(a / 45) % 8];

  // ── Dettagli al clic ────────────────────────────────────────
  function showDetail(name) {
    const p = last;
    if (!p) return;
    detail.dataset.name = name;
    let html = '';
    if (name === '__quadro') {
      html = `<h3>Quadro di consegna</h3><dl class="detail-kv">
        <dt>Potenza</dt><dd>${esc(kw(p.power_w))}</dd><dt>Attesa</dt><dd>${esc(kw(p.expected_w))}</dd>
        <dt>Energia oggi</dt><dd>${esc(kwh(p.energy_today_wh))}</dd><dt>Potenza installata</dt><dd>${formatNumber(p.kwp)} kWp</dd></dl>`;
    } else {
      const d = p.devices.find(x => x.name === name);
      if (!d) { detail.hidden = true; return; }
      const v = d.values || {};
      if (d.type === 'inverter') {
        const st = deviceState(d);
        const alarms = p.active_alarms.filter(a => a.device === name);
        html = `<h3>${esc(name)} <span class="badge ${st.kind}">${esc(st.label)}</span></h3>
          <dl class="detail-kv">
            <dt>Potenza</dt><dd>${d.online ? esc(kw(v.ac_power_w)) : '—'}</dd>
            <dt>Attesa</dt><dd>${esc(kw(d.expected_w))}</dd>
            <dt>Energia oggi</dt><dd>${esc(kwh(d.energy_today_wh))}</dd>
            <dt>Persa oggi</dt><dd>${esc(kwh(d.lost_today_wh))}</dd>
            <dt>Lato DC</dt><dd>${d.online && v.dc_voltage_v != null ? `${formatNumber(v.dc_voltage_v, 0)} V · ${formatNumber(v.dc_current_a)} A` : '—'}</dd>
            <dt>Temperatura</dt><dd>${d.online && v.temperature_c != null ? `${Math.round(v.temperature_c)} °C` : '—'}</dd>
            <dt>Potenza installata</dt><dd>${formatNumber(d.kwp)} kWp (${items[name]?.field.n ?? '—'} pannelli disegnati)</dd>
            ${d.info?.manufacturer ? `<dt>Modello</dt><dd>${esc([d.info.manufacturer, d.info.model].filter(Boolean).join(' '))}</dd>` : ''}
            ${d.info?.serial ? `<dt>Matricola</dt><dd>${esc(d.info.serial)}</dd>` : ''}
          </dl>
          ${alarms.length ? `<div class="alarm-list">${alarms.map(a => `<div class="alarm-item ${a.severity === 'critical' ? 'err' : 'warn'}"><div class="alarm-t">${esc(a.message)}</div>${a.hint ? `<div class="alarm-h muted">${esc(a.hint)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
      } else {
        html = `<h3>${esc(name)} <span class="badge ${d.online ? 'ok' : 'err'}">${d.online ? 'Comunica' : 'Non comunica'}</span></h3>
          <dl class="detail-kv"><dt>Irraggiamento</dt><dd>${v.poa_wm2 ?? '—'} W/m² sul piano dei moduli</dd>
          <dt>Orizzontale</dt><dd>${v.ghi_wm2 ?? '—'} W/m²</dd></dl>`;
      }
    }
    detail.innerHTML = `<button type="button" class="icon-btn dialog-x" aria-label="Chiudi">✕</button>${html}`;
    detail.querySelector('.dialog-x').addEventListener('click', () => { detail.hidden = true; detail.dataset.name = ''; });
    detail.hidden = false;
  }

  // ── Puntatore: clic per i dettagli, trascinamento per spostare ──
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag = null;

  function aim(e) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  function hit(e) {
    aim(e);
    const h = raycaster.intersectObjects(clickable, false)[0];
    return h ? h.object.userData.name : null;
  }
  function groundPoint() {
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(dragPlane, p) ? p : null;
  }
  function onDown(e, fromLabel = null) {
    const name = fromLabel || hit(e);
    if (!name || !items[name]) return;
    if (fromLabel) aim(e);
    const start = groundPoint();
    if (!start) return;
    drag = { name, start, origin: items[name].group.position.clone(), moved: false, x: e.clientX, y: e.clientY };
    controls.enabled = false;
    e.target.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag) { renderer.domElement.style.cursor = hit(e) ? 'pointer' : ''; return; }
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.moved = true;
    aim(e);
    const p = groundPoint();
    if (!p) return;
    const it = items[drag.name];
    it.group.position.copy(drag.origin).add(p.sub(drag.start)).setY(0);
    renderer.domElement.style.cursor = 'grabbing';
  }
  function onUp(e) {
    if (!drag) return;
    const { name, moved } = drag;
    drag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    try { e.target.releasePointerCapture?.(e.pointerId); } catch (_) {}
    if (!moved) { showDetail(name); return; }
    const pos = items[name].group.position;
    positions[name] = [Math.round(pos.x * 10) / 10, Math.round(pos.z * 10) / 10];
    savePositions(positions);
    world.updateMatrixWorld(true);
    if (name === '__quadro') inverterItems().forEach(refreshFlow);
    else refreshFlow(items[name]);
  }
  renderer.domElement.addEventListener('pointerdown', e => onDown(e));
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerup', onUp);
  // le etichette sono il bersaglio più comodo (anche su telefono): clic = dettagli, trascinamento = sposta
  labels.domElement.addEventListener('pointerdown', e => {
    const lbl = e.target.closest('.lbl3d');
    if (lbl?.dataset.name) onDown(e, lbl.dataset.name);
  });
  labels.domElement.addEventListener('pointermove', e => { if (drag) onMove(e); });
  labels.domElement.addEventListener('pointerup', onUp);
  el.querySelector('[data-reset]').addEventListener('click', () => {
    positions = {}; savePositions(positions); signature = ''; framed = false;
    if (last) update(last);
  });

  // ── Dimensioni e ciclo di disegno ───────────────────────────
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved) { framed = false; frameCamera(); }
  }
  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const clock = new THREE.Clock();
  let frame = 0;
  let destroyed = false;
  function animate() {
    if (destroyed) return;
    frame = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    for (const f of flows) {
      f.dots.forEach((dot, i) => {
        dot.visible = i < f.density;
        if (!dot.visible) return;
        dot.userData.t = (dot.userData.t + dt * f.speed) % 1;
        dot.position.copy(f.curve.getPointAt(dot.userData.t)).setY(0.32);
      });
    }
    for (const it of Object.values(items)) {
      if (it.kind !== 'inverter') continue;
      const pulse = (Math.sin(t * 4) + 1) / 2;
      it.inv.ringMat.opacity = it.alarm ? 0.25 + pulse * 0.5 : 0;
      it.inv.ring.scale.setScalar(it.alarm ? 1 + pulse * 0.25 : 1);
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  }
  animate();

  const off = plant.on(update);
  if (plant.data) update(plant.data);

  return () => {
    destroyed = true;
    cancelAnimationFrame(frame);
    off();
    ro.disconnect();
    controls.dispose();
    world.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
    disposables.forEach(x => x.dispose?.());
    ground.geometry.dispose(); ground.material.dispose(); sunMesh.geometry.dispose(); sunMesh.material.dispose();
    grid.geometry.dispose(); grid.material.dispose();
    renderer.dispose();
  };
}
