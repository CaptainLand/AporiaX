import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { createMascotEyes } from './mascot-eyes.js';

export const SPECIALIST_MODELS = Object.freeze({ explore: 'scout-v1', review: 'sentry-v1', verify: 'checko-v1', builder: 'forge-v1', curator: 'index-v1' });

// Five distinct solid-mesh studies of the approved character sheets. Helpers
// share cached geometry/materials with the room; the room owns their disposal.
export function createSpecialistMascot(parent, role, { geometry, material } = {}) {
  if (!SPECIALIST_MODELS[role]) return null;
  const geo = geometry || ((key, factory) => factory());
  const surface = material || (color => new THREE.MeshStandardMaterial({ color, roughness: .75 }));
  const palette = {
    explore: ['#1672e6', '#47d8c1', '#fff4d6', '#f4d95e'],
    review: ['#70334f', '#51243e', '#fff0d2', '#edce66'],
    verify: ['#243d62', '#f5d831', '#fff8db', '#f1d44a'],
    builder: ['#ed655d', '#303944', '#fff2dc', '#efd274'],
    curator: ['#167980', '#72d8c1', '#fff2da', '#e7ce6b'],
  }[role];
  const [base, trim, cream] = palette.slice(0,3).map(surface);
  const ink = surface('#162c3c'), pink = role === 'curator' ? surface('#e89eac') : null;
  const eyeMat = new THREE.MeshBasicMaterial({ color: palette[3], toneMapped: false });
  const key = name => `mascot:${role}:${name}`;
  function group(target, name, position = [0,0,0]) {
    const object = new THREE.Group(); object.name = name; object.position.set(...position); target.add(object); return object;
  }
  function mesh(target, name, shape, mat, position = [0,0,0]) {
    const object = new THREE.Mesh(shape, mat); object.name = name; object.position.set(...position);
    object.castShadow = true; object.receiveShadow = true; target.add(object); return object;
  }
  function oval(target, name, scale, position, mat) {
    const object = mesh(target, name, geo('mascot:oval', () => new THREE.SphereGeometry(1,16,10)), mat, position);
    object.scale.set(...scale); return object;
  }
  function hull(target, name, points, mat, position = [0,0,0]) {
    return mesh(target, name, geo(key(name), () => {
      const vertices = points.map(point => new THREE.Vector3(...point));
      const normal = new THREE.Vector3().subVectors(vertices[1],vertices[0]).cross(new THREE.Vector3().subVectors(vertices[2],vertices[0])).normalize();
      if (vertices.every(point => Math.abs(normal.dot(new THREE.Vector3().subVectors(point,vertices[0]))) < .00001)) {
        const center = vertices.reduce((sum,point) => sum.add(point),new THREE.Vector3()).multiplyScalar(1/vertices.length);
        vertices.push(center.addScaledVector(normal,-.035));
      }
      return new ConvexGeometry(vertices);
    }), mat, position);
  }
  function plate(target, name, points, mat, position = [0,0,.35], depth = .035) {
    const shape = new THREE.Shape(); points.forEach(([x,y], index) => index ? shape.lineTo(x,y) : shape.moveTo(x,y)); shape.closePath();
    return mesh(target, name, geo(key(name), () => new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 })), mat, position);
  }
  function tube(target, name, points, radius, mat) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)));
    return mesh(target, name, geo(key(name), () => new THREE.TubeGeometry(curve,24,radius,8,false)), mat);
  }
  const bot = group(parent, SPECIALIST_MODELS[role], [-.05,.7,.95]);
  bot.userData.modelKind = SPECIALIST_MODELS[role];
  const body = group(bot, 'body', [0,.32,0]);
  const head = group(bot, 'head', [0,.92,0]);
  const tail = group(bot, 'tail');
  const arms = [], ears = [];

  if (role === 'explore') {
    oval(body,'aqua-torso',[.30,.31,.24],[0,.02,0],trim);
    oval(body,'blue-back',[.31,.23,.19],[0,.12,-.12],base);
    oval(body,'cream-belly',[.19,.23,.055],[0,-.02,.23],cream);
    hull(head,'glider-head',[[-.7,.2,-.02],[-.4,.35,-.11],[0,.27,.13],[.4,.35,-.11],[.7,.2,-.02],[.40,-.22,.18],[0,-.33,.31],[-.4,-.22,.18],[0,.13,-.30],[-.35,0,.36],[.35,0,.36]],base);
    plate(head,'swept-face-mask',[[-.52,.10],[-.26,.04],[0,.13],[.26,.04],[.52,.10],[.31,-.21],[0,-.30],[-.31,-.21]],cream);
    for (const side of [-1,1]) {
      const fin = group(bot,`gliding-arm-${side}`,[side*.26,.56,0]); arms.push(fin);
      hull(fin,`fin-${side}`,[[0,.07,0],[side*.40,-.21,-.02],[side*.36,-.35,.10],[-side*.06,-.24,.16],[0,.02,.15]],base);
      hull(fin,`fin-inlay-${side}`,[[0,-.02,.16],[side*.28,-.21,.13],[side*.15,-.25,.19]],trim);
      oval(fin,'yellow-fin-spot',[.055,.035,.015],[side*.29,-.255,.155],eyeMat);
      oval(bot,`hind-leg-${side}`,[.21,.16,.22],[side*.25,-.06,.06],base);
      for (let digit=0;digit<3;digit++) oval(bot,`webbed-toe-${side}-${digit}`,[.065,.045,.14],[side*.24+(digit-1)*.075,-.2,.21],trim);
    }
    tube(tail,'coiled-tail',[[0,.12,-.23],[.35,.16,-.29],[.78,.36,-.28],[.98,.73,-.22],[.86,1.12,-.18],[.51,1.21,-.17],[.27,1.02,-.17],[.32,.75,-.17],[.56,.65,-.17],[.75,.82,-.17],[.66,.99,-.17]],.085,base);
    tube(tail,'coil-aqua-upper',[[.86,1.12,-.16],[.66,1.22,-.15],[.46,1.18,-.15],[.3,1.02,-.15]],.087,trim);
    tube(tail,'coil-aqua-inner',[[.33,.75,-.15],[.54,.65,-.15],[.72,.8,-.15]],.087,trim);
    oval(tail,'tail-beacon',[.10,.10,.10],[.65,.99,-.13],eyeMat);
  } else if (role === 'review') {
    oval(body,'pear-owl-body',[.39,.47,.32],[0,.08,0],base);
    oval(body,'belly-feathers',[.24,.33,.065],[0,.04,.30],cream);
    oval(head,'rounded-owl-head',[.47,.39,.35],[0,.015,0],base);
    plate(head,'heart-face',[[-.44,.13],[-.33,.28],[-.15,.23],[0,.10],[.15,.23],[.33,.28],[.44,.13],[.32,-.18],[.14,-.29],[0,-.31],[-.14,-.29],[-.32,-.18]],cream);
    for (const side of [-1,1]) {
      const bracket = group(bot,`bracket-arm-${side}`,[side*.30,.57,.05]); arms.push(bracket);
      oval(bracket,'gold-shoulder',[.075,.09,.05],[0,0,.03],eyeMat);
      tube(bracket,`curved-bracket-${side}`,[[0,-.04,.08],[side*.13,-.18,.13],[side*.14,-.40,.18],[side*.05,-.57,.20],[-side*.08,-.60,.20]],.075,cream);
      oval(bot,`owl-foot-${side}`,[.21,.09,.16],[side*.22,-.19,.14],cream);
      oval(bot,`owl-ankle-${side}`,[.105,.12,.10],[side*.21,-.10,.09],base);
      const feather = oval(tail,`tail-feather-${side}`,[.16,.32,.055],[side*.19,.11,-.31],trim); feather.rotation.z = side*.30;
    }
  } else if (role === 'verify') {
    oval(body,'slender-navy-body',[.235,.38,.21],[0,.045,0],base);
    oval(body,'ivory-waist',[.18,.27,.06],[0,.015,.205],cream);
    oval(head,'checko-head',[.43,.36,.33],[0,0,0],cream);
    plate(head,'navy-eye-mask',[[-.42,.16],[-.14,.28],[0,.08],[.14,.28],[.42,.16],[.34,-.19],[.16,-.25],[0,-.08],[-.16,-.25],[-.34,-.19]],base);
    for (const side of [-1,1]) {
      const ear = group(head,`folded-ear-${side}`,[side*.25,.24,-.03]); ears.push(ear);
      hull(ear,`navy-ear-${side}`,[[0,0,0],[side*.15,.32,-.05],[side*.39,.20,-.04],[side*.46,-.03,.03],[side*.32,.06,.09],[side*.14,.10,.09]],base);
      hull(ear,`yellow-ear-tip-${side}`,[[side*.30,.12,.1],[side*.46,-.03,.08],[side*.29,-.09,.10],[side*.19,.04,.12]],trim);
      oval(ear,'ear-calibration-dot',[.045,.045,.026],[side*.13,.19,.09],eyeMat);
      const arm = group(bot,`caliper-arm-${side}`,[side*.25,.57,.02]); arms.push(arm);
      oval(arm,'shoulder-pivot',[.075,.075,.075],[0,0,0],eyeMat);
      hull(arm,`caliper-${side}`,[[0,-.07,0],[side*.22,-.15,.04],[side*.29,-.33,.1],[side*.12,-.38,.15],[-side*.03,-.24,.14]],trim);
      oval(arm,'white-grip',[.08,.065,.09],[side*.13,-.32,.17],cream);
      oval(bot,`slender-leg-${side}`,[.09,.16,.10],[side*.16,-.10,.05],base);
      oval(bot,`long-foot-${side}`,[.19,.07,.24],[side*.23,-.23,.18],base);
      oval(bot,`yellow-toe-${side}`,[.12,.055,.12],[side*.23,-.23,.32],trim);
      hull(tail,`split-tail-${side}`,[[0,.04,-.18],[side*.30,.01,-.47],[side*.39,.21,-.51],[side*.21,.24,-.32],[0,.10,-.16]],base);
      oval(tail,'tail-yellow-mark',[.08,.05,.025],[side*.29,.13,-.50],trim);
    }
  } else if (role === 'builder') {
    oval(body,'heavy-charcoal-body',[.37,.30,.29],[0,.035,0],trim);
    oval(body,'red-carapace',[.37,.20,.28],[0,.20,-.035],base);
    oval(body,'chest-plate',[.20,.20,.05],[0,.015,.28],cream);
    oval(head,'coral-helmet',[.49,.36,.35],[0,.015,0],base);
    plate(head,'white-chevron-face',[[-.45,.09],[-.34,-.15],[-.17,-.28],[0,-.32],[.17,-.28],[.34,-.15],[.45,.09],[.26,.04],[0,.22],[-.26,.04]],cream);
    for (const side of [-1,1]) {
      oval(head,`hinge-shell-${side}`,[.12,.19,.16],[side*.44,-.01,-.03],trim);
      oval(head,`hinge-pin-${side}`,[.03,.06,.07],[side*.54,0,.01],cream);
      const claw = group(bot,`pincer-arm-${side}`,[side*.30,.54,.015]); arms.push(claw);
      oval(claw,'pincer-joint',[.12,.12,.12],[0,-.07,0],trim);
      hull(claw,`coral-claw-${side}`,[[0,-.02,.05],[side*.30,-.12,0],[side*.40,-.40,.08],[side*.21,-.49,.20],[-side*.02,-.25,.20]],base);
      hull(claw,`fixed-claw-tip-${side}`,[[side*.34,-.31,.17],[side*.38,-.51,.18],[side*.21,-.57,.25],[side*.20,-.41,.25]],trim);
      hull(claw,`opposing-claw-tip-${side}`,[[side*.04,-.23,.21],[side*.10,-.44,.27],[side*.21,-.48,.27],[side*.13,-.31,.27]],trim);
      oval(bot,`red-foot-${side}`,[.22,.085,.20],[side*.24,-.17,.12],base);
      oval(bot,`charcoal-leg-${side}`,[.10,.15,.11],[side*.22,-.035,.065],trim);
      hull(bot,`black-foot-edge-${side}`,[[side*.14,-.17,.14],[side*.40,-.19,.24],[side*.35,-.23,.30],[side*.13,-.23,.22]],trim);
    }
    hull(tail,'paddle-tail',[[0,.08,-.14],[.29,.06,-.40],[.50,.1,-.69],[.20,.14,-.75],[-.07,.11,-.47],[0,.19,-.18]],trim);
    hull(tail,'coral-tail-panel',[[.08,.16,-.30],[.40,.15,-.65],[.20,.19,-.70],[.02,.18,-.45]],base);
  } else {
    oval(body,'mint-torso',[.28,.35,.23],[0,.06,0],base);
    oval(body,'cream-belly',[.21,.27,.06],[0,.045,.23],cream);
    hull(head,'index-fox-head',[[-.5,.10,.08],[-.32,.32,-.05],[0,.32,-.11],[.32,.32,-.05],[.5,.1,.08],[.32,-.23,.25],[0,-.31,.32],[-.32,-.23,.25],[-.22,.06,.35],[.22,.06,.35],[0,.1,-.29]],base);
    plate(head,'cream-face',[[-.45,.11],[-.22,.18],[0,.04],[.22,.18],[.45,.11],[.29,-.20],[0,-.29],[-.29,-.20]],cream);
    for (const side of [-1,1]) {
      const ear = group(head,`index-ear-${side}`,[side*.27,.24,-.02]); ears.push(ear);
      hull(ear,`teal-ear-${side}`,[[0,0,.06],[side*.12,.37,-.01],[side*.24,.05,.06],[side*.05,-.06,-.10]],base);
      hull(ear,`pink-inner-ear-${side}`,[[side*.05,.04,.09],[side*.12,.27,.04],[side*.18,.07,.09]],pink);
      const arm = group(bot,`little-arm-${side}`,[side*.25,.55,.07]); arms.push(arm);
      oval(arm,'teal-forelimb',[.09,.19,.10],[side*.04,-.13,.045],base);
      oval(arm,'ivory-paw',[.085,.07,.10],[side*.045,-.27,.10],cream);
      oval(bot,`teal-foot-${side}`,[.17,.08,.21],[side*.19,-.18,.16],base);
      oval(bot,`teal-leg-${side}`,[.09,.145,.10],[side*.17,-.025,.09],base);
    }
    tail.position.set(-.19,.01,-.29);
    const boards = [
      ['outer-index-board',[[-.05,.05],[-.69,.36],[-.78,.84],[-.52,1.12],[-.15,1.11],[.16,.78],[.17,.23]],trim],
      ['pink-index-board',[[-.08,.08],[-.66,.35],[-.60,.70],[-.36,.82],[-.11,.61],[.08,.25]],pink],
      ['mint-index-board',[[.02,.06],[-.27,.30],[-.41,.72],[-.25,1.03],[.03,.96],[.27,.58],[.24,.23]],trim],
    ];
    // Separate the three physical leaves; coplanar colored faces shimmer when
    // the camera moves, especially on the pink/mint overlap.
    boards.forEach(([name,points,mat],index) => plate(tail,name,points,mat,[0,0,index*.035],.055));
    plate(tail,'tail-rim',[[-.09,.08],[-.72,.37],[-.81,.85],[-.54,1.17],[-.14,1.16],[.20,.79],[.21,.25]],base,[0,0,-.04],.05);
    for (const [x,y] of [[-.49,.46],[-.45,.64],[-.09,.62]]) oval(tail,'index-tab',[.045,.055,.025],[x,y,.15],cream);
  }

  const face = createMascotEyes(head,role,{geometry:geo});
  oval(head,'small-nose',[.032,.022,.018],[0,-.19,.411],ink);
  const animation = (t,state) => {
    const sleeping = state === 'sleeping' || state === 'offline';
    const rest = role === 'review' ? .03 : role === 'explore' ? -.08 : .02;
    const work = { explore: -.48, review: -.28, verify: -.73, builder: -.57, curator: -.64 }[role];
    arms.forEach((arm,index) => {
      arm.rotation.x = state === 'working' ? work + Math.sin(t*(role === 'builder' ? 5 : 7)+index*2)*.065 : state === 'attention' && index === 1 ? -1.0 : rest;
      arm.rotation.z = (index ? -1 : 1) * (role === 'builder' ? .10 : role === 'explore' ? .06 : 0);
    });
    tail.rotation.y = Math.sin(t*.7)*(sleeping ? .02 : role === 'explore' ? .075 : .045);
    ears.forEach((ear,index) => { ear.rotation.z = Math.sin(t*.65+index)*(sleeping ? .015 : .035); });
  };
  return { bot, body, head, tail, arms, ...face, animate: animation, modelKind: SPECIALIST_MODELS[role] };
}
