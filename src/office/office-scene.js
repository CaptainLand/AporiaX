import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createAporiaxMascot } from './aporiax-mascot.js';
import { createSpecialistMascot } from './specialist-mascots.js';

// Geometry is deliberately local and procedural: no remote models, textures, or account data.
export function createOffice(container, roster, { onSelect, onView, labels = {} } = {}) {
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.domElement.setAttribute('aria-label', labels.canvas || '可拖动和缩放的办公室场景');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-12, 12, 9, -9, .1, 120);
  const home = new THREE.Vector3(16, 17, 21);
  camera.position.copy(home);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, .6, 0);
  controls.enableDamping = true;
  controls.dampingFactor = .1;
  controls.minPolarAngle = .48;
  controls.maxPolarAngle = 1.08;
  controls.minAzimuthAngle = .12;
  controls.maxAzimuthAngle = 1.22;
  controls.minZoom = .65;
  controls.maxZoom = 2.2;
  controls.rotateSpeed = .55;
  controls.zoomSpeed = .75;
  controls.screenSpacePanning = true;
  controls.target0.copy(controls.target);
  controls.position0.copy(home);
  controls.zoom0 = 1;

  const geometryCache = new Map();
  const materials = new Map();
  const textures = new Set();
  const actors = new Map();
  const hitTargets = [];
  const windowMaterials = [];
  let disposed = false, night = false, paused = false, frame = 0, lastFrame = 0, elapsed = 0;
  let selected = null, interactionUntil = 0, width = 1, height = 1, lastZoom = 0;

  function material(color, roughness = .78) {
    const key = `${color}/${roughness}`;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness }));
    return materials.get(key);
  }
  function geometry(key, factory) {
    if (!geometryCache.has(key)) geometryCache.set(key, factory());
    return geometryCache.get(key);
  }
  function box(parent, size, position, color, radius = .04) {
    const [w, h, d] = size;
    const key = `box:${size}:${radius}`;
    const shape = geometry(key, () => radius ? new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)) : new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(shape, typeof color === 'string' ? material(color) : color);
    mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }
  function cylinder(parent, top, bottom, h, position, color, segments = 16) {
    const geo = geometry(`cyl:${top}:${bottom}:${h}:${segments}`, () => new THREE.CylinderGeometry(top, bottom, h, segments));
    const mesh = new THREE.Mesh(geo, typeof color === 'string' ? material(color) : color);
    mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }
  function sphere(parent, scale, position, color) {
    const mesh = new THREE.Mesh(geometry('sphere', () => new THREE.SphereGeometry(1, 16, 10)), material(color));
    mesh.scale.set(...scale); mesh.position.set(...position); mesh.castShadow = true;
    parent.add(mesh); return mesh;
  }
  function group(parent, position, rotation = 0) {
    const g = new THREE.Group(); g.position.set(...position); g.rotation.y = rotation; parent.add(g); return g;
  }
  function canvasTexture(w, h, draw) {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    draw(canvas.getContext('2d'), w, h);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
    textures.add(texture); return texture;
  }
  function plane(parent, w, h, pos, texture) {
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    const mesh = new THREE.Mesh(geometry(`plane:${w}:${h}`, () => new THREE.PlaneGeometry(w, h)), mat);
    mesh.position.set(...pos); parent.add(mesh); return mesh;
  }

  const hemi = new THREE.HemisphereLight('#d7ecff', '#c1aa87', 2.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1d5', 3.4); sun.position.set(-3, 16, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
  sun.shadow.normalBias = .035; sun.shadow.bias = -.00015;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#a8cff1', 1.1); fill.position.set(10, 8, -8); scene.add(fill);

  const office = group(scene, [0, 0, 0]);
  const foundation = box(office, [15.1, .5, 11.8], [0, -.32, 0], '#e0d4be', .14);
  box(office, [14.9, .16, 11.6], [0, -.03, 0], '#ede0ca');
  const woods = ['#d9bd98', '#ddc29e', '#dfc5a5', '#d4b692', '#e0c7a8'];
  for (let row = 0; row < 18; row++) {
    const z = -5.38 + row * .635;
    for (let col = 0; col < 4; col++) {
      box(office, [3.68, .07, .622], [-5.55 + col * 3.7, .085, z], woods[(row * 3 + col) % woods.length], .008);
    }
  }
  const wallMat = material('#f1f0e8');
  box(office, [15, 3.5, .18], [0, 1.82, -5.72], wallMat);
  box(office, [.18, 3.5, 11.6], [-7.45, 1.82, 0], wallMat);
  box(office, [15, .17, .24], [0, .24, -5.58], '#c7b89f');
  box(office, [.24, .17, 11.5], [-7.31, .24, 0], '#c7b89f');
  box(office, [15.16, .11, .29], [0, 3.6, -5.72], '#fcfaf3');
  box(office, [.29, .11, 11.76], [-7.45, 3.6, 0], '#fcfaf3');

  // Large rear window with a tiny stylized skyline, entirely inside the diorama.
  const win = group(office, [.7, 2.2, -5.57]);
  box(win, [5.3, 2, .14], [0, 0, 0], '#a6bfc2');
  const sky = new THREE.MeshStandardMaterial({ color: '#cde9ed', emissive: '#b9dce9', emissiveIntensity: .26, roughness: .9 });
  windowMaterials.push(sky);
  box(win, [5.04, 1.75, .03], [0, 0, .08], sky, 0);
  for (let i = 0; i < 10; i++) {
    box(win, [.36, .22 + (i % 4) * .12, .03], [-2.3 + i * .5, -.62 + (i % 4) * .06, .106], i % 2 ? '#b8d4da' : '#c0dade', 0);
  }
  [-2.58, -.87, .87, 2.58].forEach(x => box(win, [.055, 2, .12], [x, 0, .16], '#faf8ee', .01));
  [-.94, .94].forEach(y => box(win, [5.3, .065, .12], [0, y, .16], '#faf8ee', .01));
  box(win, [5.65, .12, .52], [0, -1.05, .17], '#efddbd');

  const sign = canvasTexture(768, 220, (ctx, w, h) => {
    ctx.fillStyle = '#f7f5ed'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#326e94'; ctx.font = '600 96px "Segoe UI", sans-serif'; ctx.fillText('AporiaX', 48, 126);
    ctx.fillStyle = '#87908b'; ctx.font = '20px "Segoe UI", sans-serif'; ctx.fillText('A LITTLE SPACE FOR BIG IDEAS', 54, 176);
  });
  box(office, [3.28, 1.05, .12], [-4.72, 2.45, -5.52], '#ddd4c0');
  plane(office, 3.14, .9, [-4.72, 2.45, -5.45], sign);

  // Wall clock uses fixed demo time, not a fake elapsed-work counter.
  const clock = group(office, [5.6, 2.55, -5.46]);
  const clockOuter = cylinder(clock, .43, .43, .09, [0, 0, 0], '#687e81', 40); clockOuter.rotation.x = Math.PI / 2;
  const clockInner = cylinder(clock, .37, .37, .02, [0, 0, .055], '#fcf9ed', 40); clockInner.rotation.x = Math.PI / 2;
  const hand1 = box(clock, [.035, .23, .025], [0, .1, .08], '#52676e', .006); hand1.rotation.z = -.65;
  const hand2 = box(clock, [.025, .29, .025], [.11, .05, .08], '#52676e', .005); hand2.rotation.z = -1.1;

  function plant(parent, x, z, scale = 1, base = .15) {
    const p = group(parent, [x, base, z]); p.scale.setScalar(scale);
    cylinder(p, .27, .21, .42, [0, .21, 0], '#e9e2d4');
    cylinder(p, .235, .235, .022, [0, .425, 0], '#6f6150');
    cylinder(p, .025, .033, .65, [0, .73, 0], '#738569', 8);
    for (let j = 0; j < 7; j++) {
      const a = j * 2.4;
      const leaf = sphere(p, [.13, .36, .14], [Math.cos(a) * .2, .67 + j * .08, Math.sin(a) * .2], ['#6c966f', '#85a77c', '#4e7b60'][j % 3]);
      leaf.rotation.z = Math.cos(a) * .55; leaf.rotation.x = Math.sin(a) * .55;
    }
    return p;
  }
  plant(office, -6.6, -4.6, 1.15);
  plant(office, 6.35, -4.7, 1.5);
  plant(office, 6.65, 4.7, .85);
  plant(win, -1.8, .15, .38, -1);
  plant(win, 1.8, .15, .35, -1);

  // Bookcase and coffee counter along the left wall.
  const shelf = group(office, [-6.8, 0, -1.15]);
  box(shelf, [.65, 2.35, 2.1], [0, 1.32, 0], '#ae9679');
  box(shelf, [.025, 2.1, 1.83], [.338, 1.33, 0], '#dbc7a9');
  for (const y of [.35, 1.04, 1.74, 2.44]) box(shelf, [.83, .07, 2.2], [.1, y, 0], '#e2cfad');
  for (let j = 0; j < 17; j++) {
    const tier = Math.floor(j / 6); const z = -.82 + (j % 6) * .29;
    const b = box(shelf, [.4, .42 + (j % 3) * .045, .16], [.18, .6 + tier * .7, z], ['#8ea5a1', '#bc9372', '#e2d9b8', '#718b9c'][j % 4], .015);
    if (j === 4 || j === 10) b.rotation.x = .16;
  }
  const coffee = group(office, [-6.65, 0, 3.65]);
  box(coffee, [.98, .95, 2.25], [0, .61, 0], '#e3dac8');
  box(coffee, [1.08, .1, 2.36], [0, 1.14, 0], '#b79b77');
  box(coffee, [.042, .74, .93], [.51, .64, -.52], '#d1c3ac');
  box(coffee, [.042, .74, .93], [.51, .64, .52], '#d1c3ac');
  const espresso = box(coffee, [.62, .57, .63], [0, 1.46, -.56], '#71898a');
  box(espresso, [.025, .27, .43], [.324, -.07, 0], '#263e43');
  cylinder(coffee, .085, .065, .14, [.31, 1.26, -.56], '#f8f2e4');
  plant(coffee, 0, .76, .42, 1.2);

  // Lounge: asymmetric soft rug, sofa, oak table, magazine and mug.
  box(office, [3.5, .025, 3.8], [-4.1, .143, 2.18], '#b7c4b2', .12);
  const sofa = group(office, [-4.98, .16, 1.9]);
  box(sofa, [1.28, .35, 2.7], [0, .4, 0], '#749298', .16);
  box(sofa, [.26, .73, 2.7], [-.51, .73, 0], '#87a2a3', .13);
  [-1.22, 1.22].forEach(z => box(sofa, [1.3, .62, .23], [0, .64, z], '#91aaab', .11));
  [-.56, .56].forEach(z => box(sofa, [.88, .22, 1.05], [.14, .64, z], '#aac0bc', .1));
  const cushion = box(sofa, [.22, .46, .52], [-.2, .96, -.72], '#e5bb85', .08); cushion.rotation.z = -.25;
  cylinder(office, .67, .67, .12, [-3.12, .66, 2.12], '#dec4a0', 36);
  cylinder(office, .13, .28, .43, [-3.12, .4, 2.12], '#87988e');
  const magazine = box(office, [.43, .045, .32], [-3.26, .745, 2.05], '#e5e9d9', .012); magazine.rotation.y = .3;
  cylinder(office, .08, .065, .15, [-2.9, .79, 2.15], '#c48469');

  // Small wall artwork: framed botanical abstraction, not an external image.
  const art = group(office, [-7.29, 2.38, 2.2], Math.PI / 2);
  box(art, [1.9, 1.3, .09], [0, 0, 0], '#baa385');
  const artwork = canvasTexture(360, 240, (ctx, w, h) => {
    ctx.fillStyle = '#eee8d8'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d9b17d'; ctx.beginPath(); ctx.arc(260, 64, 36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#94aa8d'; ctx.beginPath(); ctx.ellipse(110, 155, 100, 54, -.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#587e70'; ctx.beginPath(); ctx.ellipse(218, 201, 126, 65, .1, 0, Math.PI * 2); ctx.fill();
  });
  plane(art, 1.73, 1.13, [0, 0, .051], artwork);

  const codeTexture = canvasTexture(512, 300, ctx => {
    ctx.fillStyle = '#233e4a'; ctx.fillRect(0, 0, 512, 300);
    ctx.fillStyle = '#344d56'; ctx.fillRect(0, 0, 512, 28); ctx.fillRect(0, 29, 78, 271);
    ['#dcad80', '#8ebaaa', '#8bb9d7'].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(15 + i * 15, 14, 4, 0, Math.PI * 2); ctx.fill(); });
    for (let i = 0; i < 11; i++) {
      ctx.fillStyle = ['#7fb8c7', '#b1ccb2', '#d5b892'][i % 3];
      ctx.fillRect(105 + (i % 3) * 19, 49 + i * 19, 76 + ((i * 43) % 180), 6);
      ctx.fillStyle = '#728b91'; ctx.fillRect(18, 52 + i * 19, 36, 4);
    }
  });
  const chartTexture = canvasTexture(512, 300, ctx => {
    ctx.fillStyle = '#f1f1e9'; ctx.fillRect(0, 0, 512, 300);
    ctx.fillStyle = '#dce3dd'; ctx.fillRect(0, 0, 512, 32);
    ctx.fillStyle = '#6f909e'; ctx.fillRect(30, 61, 171, 12);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? '#7babac' : '#8aafc4'; ctx.fillRect(38 + i * 68, 244 - i * 24, 41, 25 + i * 24); }
  });

  function robot(parent, agent) {
    const bot = group(parent, [-.05, .7, .95], .18);
    const body = box(bot, [.55, .61, .4], [0, .34, 0], agent.color, .15);
    box(bot, [.3, .12, .03], [0, .29, .215], '#d4e0da', .025);
    const head = group(bot, [0, .92, 0]);
    box(head, [.78, .59, .57], [0, 0, 0], '#f0f0e7', .18);
    box(head, [.59, .29, .046], [0, -.01, .292], '#263e4c', .075);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#bce7f1' });
    const eyes = [-.14, .14].map(x => box(head, [.062, .095, .023], [x, .018, .319], eyeMat, .022));
    [-.422, .422].forEach(x => sphere(head, [.075, .11, .11], [x, 0, 0], agent.color));
    const arms = [-1, 1].map(side => {
      const arm = group(bot, [side * .34, .57, .025]);
      box(arm, [.15, .29, .16], [0, -.12, .035], agent.color, .065);
      sphere(arm, [.09, .085, .12], [0, -.2, .15], '#e7e9df');
      arm.rotation.x = -1.15; return arm;
    });
    [-.17, .17].forEach(x => {
      box(bot, [.16, .26, .17], [x, -.03, .16], '#4e6571', .05);
      box(bot, [.22, .14, .32], [x, -.2, .24], '#e3e5dc', .05);
    });
    if (agent.accessory === 'tie') {
      const tie = box(bot, [.09, .23, .04], [0, .45, .236], '#f1d199', .018); tie.rotation.z = -.08;
    }
    if (agent.accessory === 'antenna') {
      cylinder(head, .025, .025, .2, [.19, .39, 0], '#677c83', 8);
      sphere(head, [.065, .065, .065], [.19, .51, 0], agent.color);
    }
    if (agent.accessory === 'headphones') {
      const arch = new THREE.Mesh(geometry('headphones', () => new THREE.TorusGeometry(.41, .042, 6, 20, Math.PI)), material('#435968'));
      arch.position.y = .025; head.add(arch);
      [-.43, .43].forEach(x => box(head, [.12, .25, .25], [x, 0, 0], '#475f69', .05));
    }
    if (agent.accessory === 'glasses') {
      [-.14, .14].forEach(x => {
        const rim = new THREE.Mesh(geometry('glass', () => new THREE.TorusGeometry(.105, .014, 6, 20)), material('#dfb78f'));
        rim.position.set(x, .01, .337); head.add(rim);
      });
      box(head, [.07, .022, .02], [0, .02, .337], '#dfb78f', .005);
    }
    if (agent.accessory === 'cap') {
      box(head, [.74, .11, .58], [0, .28, .04], agent.color, .08);
      box(head, [.72, .045, .26], [0, .26, .31], agent.color, .022);
    }
    return { bot, body, head, eyes, eyeMat, arms };
  }

  for (const agent of roster) {
    const desk = group(office, [agent.x, .12, agent.z], agent.angle);
    if (agent.id === 'lead') box(desk, [3, .025, 2.85], [0, .013, .45], '#b2cad2', .07);
    box(desk, [2.46, .13, 1.15], [0, 1.02, 0], agent.id === 'lead' ? '#bd9a72' : '#ead4b2', .07);
    [-1.04, 1.04].forEach(x => {
      [-.4, .4].forEach(z => box(desk, [.1, .93, .1], [x, .51, z], '#8c9b98', .02));
      box(desk, [.11, .075, .92], [x, .1, 0], '#8c9b98');
    });
    box(desk, [.47, .6, .62], [.89, .65, -.02], '#d1c9b8', .045);
    [.49, .71].forEach(y => box(desk, [.19, .023, .03], [.89, y, .301], '#8b968e', .006));
    const screen = group(desk, [-.22, 1.49, -.33], -.08);
    box(screen, [1.32, .79, .09], [0, 0, 0], '#657d81', .055);
    const screenMat = new THREE.MeshBasicMaterial({ map: agent.id === 'lead' ? chartTexture : codeTexture, toneMapped: false });
    const display = new THREE.Mesh(geometry('screen', () => new THREE.PlaneGeometry(1.2, .665)), screenMat);
    display.position.z = .052; screen.add(display);
    box(desk, [.065, .23, .065], [-.22, 1.19, -.33], '#7d8d8e');
    box(desk, [.43, .055, .26], [-.22, 1.11, -.3], '#8c9a96');
    box(desk, [.77, .04, .25], [-.21, 1.11, .26], '#bcc8c4', .025);
    for (let r = 0; r < 3; r++) box(desk, [.65, .015, .02], [-.21, 1.137, .18 + r * .068], '#8b9d9d', .003);
    sphere(desk, [.07, .025, .1], [.39, 1.13, .27], '#879b9c');
    cylinder(desk, .084, .068, .19, [.96, 1.19, .28], agent.color);
    cylinder(desk, .059, .059, .008, [.96, 1.289, .28], '#6a513f');
    const note = box(desk, [.23, .012, .24], [.65, 1.097, -.12], '#e7c779', .005); note.rotation.y = -.2;
    // Office chair, with visible castors and arms.
    cylinder(desk, .055, .07, .4, [-.05, .36, .98], '#72878d');
    box(desk, [.78, .14, .72], [-.05, .6, 1], '#748c99', .12);
    box(desk, [.75, .66, .15], [-.05, .94, 1.36], '#8da3ac', .1);
    [-.48, .38].forEach(x => box(desk, [.1, .1, .45], [x, .88, 1], '#6b818b', .035));
    for (let i = 0; i < 5; i++) {
      const foot = box(desk, [.065, .045, .5], [-.05, .14, .98], '#6c8189', .012);
      foot.rotation.y = i * Math.PI * 2 / 5;
    }
    const actor = agent.id === 'lead' ? createAporiaxMascot(desk, { geometry, material }) : createSpecialistMascot(desk, agent.role, { geometry, material }) || robot(desk, agent);
    // The whole character faces its own monitor; the head stays aligned with
    // the seated body rather than turning back toward the room camera.
    actor.bot.rotation.y = Math.PI;
    actor.head.rotation.y = 0;
    const bubble = document.createElement('button'); bubble.className = 'agent-label';
    bubble.setAttribute('aria-label', labels.agent ? labels.agent(agent) : `查看${agent.name}，${agent.role}`);
    bubble.innerHTML = '<i></i><span></span><small></small>';
    bubble.querySelector('span').textContent = agent.name;
    const onBubble = () => onSelect?.(agent.id);
    bubble.addEventListener('click', onBubble);
    container.appendChild(bubble);
    const marker = new THREE.Mesh(geometry('select-ring', () => new THREE.RingGeometry(.45, .5, 48)), new THREE.MeshBasicMaterial({ color: '#3b91cf', side: THREE.DoubleSide, transparent: true, opacity: .7, depthWrite: false }));
    marker.rotation.x = -Math.PI / 2; marker.position.set(-.05, .04, .95); marker.visible = false; desk.add(marker);
    const sleep = document.createElement('span'); sleep.className = 'sleep-bubble'; sleep.textContent = 'z z'; sleep.setAttribute('aria-hidden', 'true'); container.appendChild(sleep);
    actors.set(agent.id, { ...actor, desk, screenMat, marker, bubble, sleep, onBubble, state: agent.state, statusText: agent.statusText, seed: actors.size * 1.17 });
    desk.traverse(obj => { if (obj.isMesh) { obj.userData.agentId = agent.id; hitTargets.push(obj); } });
  }

  // Subtle floor shadow without postprocessing or expensive realtime ambient occlusion.
  const shadowTexture = canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(53,65,58,.22)'); g.addColorStop(.6, 'rgba(53,65,58,.1)'); g.addColorStop(1, 'rgba(53,65,58,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  const shadowPlane = plane(scene, 23, 17, [1, -.61, .7], shadowTexture); shadowPlane.rotation.x = -Math.PI / 2;

  // Batch static props by material and workstation. Preserve selection IDs while
  // avoiding hundreds of tiny furniture draw calls on integrated desktop GPUs.
  office.updateMatrixWorld(true);
  const batches = new Map();
  const dynamicRoots = new Set([...actors.values()].flatMap(a => [a.bot, a.marker]));
  office.traverse(obj => {
    if (!obj.isMesh || obj.material.transparent) return;
    for (let parent = obj; parent; parent = parent.parent) { if (dynamicRoots.has(parent)) return; }
    const key = `${obj.material.uuid}/${obj.userData.agentId || 'room'}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(obj);
  });
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const pieces = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    const mergedGeometry = mergeGeometries(pieces);
    if (!mergedGeometry) throw new Error('Office static geometry could not be combined.');
    pieces.forEach(geo => geo.dispose());
    const combined = new THREE.Mesh(mergedGeometry, meshes[0].material);
    combined.castShadow = true; combined.receiveShadow = true;
    combined.userData.agentId = meshes[0].userData.agentId;
    meshes.forEach(mesh => mesh.removeFromParent());
    scene.add(combined);
  }
  hitTargets.length = 0;
  scene.traverse(obj => { if (obj.isMesh && obj.userData.agentId && !dynamicRoots.has(obj)) hitTargets.push(obj); });

  const ray = new THREE.Raycaster(); const pointer = new THREE.Vector2();
  let down = null;
  function pointerDown(e) { down = { x: e.clientX, y: e.clientY, button: e.button }; interactionUntil = performance.now() + 2500; }
  function pointerUp(e) {
    if (!down || down.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((e.clientX - rect.left) / width * 2 - 1, -(e.clientY - rect.top) / height * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(hitTargets, false)[0];
    if (hit) onSelect?.(hit.object.userData.agentId);
  }
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  const startInteraction = () => { interactionUntil = performance.now() + 2500; };
  controls.addEventListener('start', startInteraction);
  controls.addEventListener('change', startInteraction);

  const vector = new THREE.Vector3();
  function positionLabels() {
    camera.updateMatrixWorld(); office.updateMatrixWorld(true);
    for (const item of actors.values()) {
      vector.set(0, item.modelKind ? 2.7 : 2.35, .88); item.desk.localToWorld(vector); vector.project(camera);
      const x = (vector.x * .5 + .5) * width; const y = (-vector.y * .5 + .5) * height;
      const visible = vector.z > -1 && vector.z < 1 && x > 10 && x < width - 10 && y > 10 && y < height - 10;
      item.bubble.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      item.bubble.style.visibility = visible ? 'visible' : 'hidden';
      item.sleep.style.transform = `translate(${x + 28}px, ${y + 25}px) rotate(-12deg)`;
      item.sleep.style.visibility = visible && item.state === 'sleeping' ? 'visible' : 'hidden';
    }
  }
  function syncActors() {
    for (const [id, item] of actors) {
      const sleeping = item.state === 'sleeping' || item.state === 'offline';
      item.screenMat.color.set(sleeping ? '#111e28' : item.state === 'waiting' ? '#9dafb5' : '#ffffff');
      item.screenMat.map = sleeping ? null : id === 'lead' ? chartTexture : codeTexture;
      item.screenMat.needsUpdate = true;
      item.eyeMat.color.set(item.state === 'error' ? '#ef9b93' : item.state === 'attention' ? '#f0d391' : item.eyeColor ? (sleeping ? item.eyeSleepColor : item.eyeColor) : item.modelKind ? (sleeping ? '#387da9' : '#189dff') : sleeping ? '#91b7bd' : '#bce7f1');
      item.bubble.dataset.state = item.state;
      item.bubble.dataset.selected = String(id === selected);
      item.bubble.setAttribute('aria-pressed', String(id === selected));
      item.bubble.querySelector('small').textContent = item.statusText || labels.states?.[item.state] || { working: '工作', waiting: '等待', sleeping: '休息', offline: '未连接', error: '失败', attention: '待处理' }[item.state];
      item.marker.visible = id === selected;
    }
  }
  function animateActors(t) {
    for (const item of actors.values()) {
      const v = t + item.seed; const sleeping = item.state === 'sleeping' || item.state === 'offline';
      item.head.rotation.x = sleeping ? .28 : .025 + Math.sin(v * .9) * .01;
      item.head.rotation.z = 0;
      item.head.position.y = sleeping ? .72 + Math.sin(v * 1.8) * .012 : .92 + Math.sin(v * 1.5) * .008;
      item.head.rotation.y = 0;
      item.body.scale.y = 1 + Math.sin(v * (sleeping ? 1.5 : 2)) * .018;
      if (item.animateFace) item.animateFace(v,item.state);
      else item.eyes.forEach(eye => { eye.scale.y = sleeping ? .15 : Math.sin(v * .9) > .998 ? .12 : 1; });
      if (item.animate) item.animate(v,item.state);
      else {
        item.arms.forEach((arm, i) => { arm.rotation.x = item.modelKind ? (item.state === 'working' ? -.55 + Math.sin(v * 7 + i * 2) * .06 : item.state === 'attention' && i === 1 ? -1 : .02) : item.state === 'working' ? -1.1 + Math.sin(v * 9 + i * 2) * .1 : item.state === 'attention' && i === 1 ? -2.7 : sleeping ? -1.35 : -.5; });
        if (item.tail) item.tail.rotation.y = Math.sin(v * .65) * (sleeping ? .035 : .13);
      }
    }
  }

  function resize() {
    if (disposed) return;
    width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
    const aspect = width / height;
    const halfHeight = Math.max(9.1, 12.7 / aspect);
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix(); renderer.setSize(width, height);
    draw();
  }
  function draw() {
    controls.update(); positionLabels(); renderer.render(scene, camera);
    const zoom = Math.round(camera.zoom * 100);
    if (zoom !== lastZoom) { lastZoom = zoom; onView?.(zoom); }
  }
  function loop(now) {
    if (disposed || document.hidden) return;
    frame = requestAnimationFrame(loop);
    const interval = now < interactionUntil ? 1000 / 60 : 1000 / 30;
    if (now - lastFrame < interval) return;
    const dt = Math.min((now - lastFrame) / 1000, .07); lastFrame = now;
    if (!paused) { elapsed += dt; animateActors(elapsed); }
    if (!paused || now < interactionUntil) draw();
  }
  function visibility() {
    cancelAnimationFrame(frame);
    if (!document.hidden) { lastFrame = performance.now(); draw(); frame = requestAnimationFrame(loop); }
  }
  function theme(value) {
    night = value === 'night';
    hemi.intensity = night ? 1.25 : 2.6;
    hemi.color.set(night ? '#92b3d8' : '#d7ecff');
    sun.intensity = night ? 1.3 : 3.4; sun.color.set(night ? '#c6d8ef' : '#fff1d5');
    fill.intensity = night ? .8 : 1.1;
    renderer.toneMappingExposure = night ? .95 : 1.2;
    wallMat.color.set(night ? '#9eabb0' : '#f1f0e8');
    foundation.material.color.set(night ? '#798791' : '#e0d4be');
    windowMaterials.forEach(mat => { mat.color.set(night ? '#244763' : '#cde9ed'); mat.emissive.set(night ? '#25475d' : '#b9dce9'); });
    draw();
  }
  function reset() { controls.reset(); camera.zoom = 1; camera.updateProjectionMatrix(); draw(); }
  function zoom(factor) { camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); draw(); }
  function focus(id) {
    const item = actors.get(id); if (!item) return;
    const target = new THREE.Vector3(item.desk.position.x, 1, item.desk.position.z);
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(target); camera.position.copy(target).add(offset); camera.zoom = 1.65;
    camera.updateProjectionMatrix(); draw();
  }
  function keyDown(e) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.15); }
    if (e.key === '-') { e.preventDefault(); zoom(1 / 1.15); }
    if (e.key === '0' || e.key.toLowerCase() === 'r') { e.preventDefault(); reset(); }
  }
  renderer.domElement.addEventListener('keydown', keyDown);
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  function contextLost(e) { e.preventDefault(); cancelAnimationFrame(frame); container.dispatchEvent(new CustomEvent('office-error', { detail: labels.contextLost || '图形上下文暂时不可用，请重试场景。' })); }
  const observer = new ResizeObserver(resize); observer.observe(container);
  document.addEventListener('visibilitychange', visibility);
  syncActors(); animateActors(0); resize(); frame = requestAnimationFrame(loop);

  return {
    setTheme: theme, zoom, reset, focus,
    setPaused(value) { paused = value; draw(); },
    setStates(states) {
      let changed = false;
      for (const [id, state] of Object.entries(states)) {
        const item = actors.get(id);
        if (item && item.state !== state && ['working', 'waiting', 'sleeping', 'offline', 'error', 'attention'].includes(state)) { item.state = state; changed = true; }
      }
      if (changed) { syncActors(); animateActors(elapsed); draw(); }
    },
    setMetadata(roster) {
      let changed = false;
      for (const agent of roster) {
        const item = actors.get(agent.id); if (!item || (item.statusText === agent.statusText && item.name === agent.name)) continue;
        changed = true; item.name = agent.name; item.statusText = agent.statusText; item.bubble.querySelector('span').textContent = agent.name;
        item.bubble.setAttribute('aria-label', labels.agent ? labels.agent(agent) : `查看${agent.name}，${agent.role}`);
        item.bubble.title = `${agent.name} · ${agent.statusText || ''}`;
      }
      if (changed) { syncActors(); draw(); }
    },
    view() { return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom }; },
    restoreView(view) { if (!view) return; camera.position.fromArray(view.position); controls.target.fromArray(view.target); camera.zoom = THREE.MathUtils.clamp(view.zoom, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); draw(); },
    select(id) { selected = id; syncActors(); draw(); },
    diagnostics() { return { zoom: camera.zoom, camera: camera.position.toArray(), target: controls.target.toArray(), night, paused, states: Object.fromEntries([...actors].map(([id, a]) => [id, a.state])), agentModels: Object.fromEntries([...actors].map(([id, a]) => [id, a.modelKind || 'robot-v1'])), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: renderer.info.render.frame, hidden: document.hidden }; },
    destroy() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      document.removeEventListener('visibilitychange', visibility);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('keydown', keyDown);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      const allMaterials = new Set(); const allGeometries = new Set();
      scene.traverse(obj => { if (obj.geometry) allGeometries.add(obj.geometry); if (obj.material) { for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) allMaterials.add(m); } });
      for (const item of actors.values()) { item.bubble.removeEventListener('click', item.onBubble); item.bubble.remove(); item.sleep.remove(); }
      geometryCache.forEach(geo => allGeometries.add(geo));
      allMaterials.forEach(mat => mat.dispose()); allGeometries.forEach(geo => geo.dispose()); textures.forEach(texture => texture.dispose());
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
