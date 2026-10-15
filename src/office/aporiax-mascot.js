import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { createMascotEyes } from './mascot-eyes.js';

// First 3D study of the approved folded-wing design. Solid local meshes, not a
// camera-facing portrait. The office owns and disposes every resource below.
export function createAporiaxMascot(parent, { geometry, material } = {}) {
  const geo = geometry || ((key, factory) => factory());
  const mat = material || (color => new THREE.MeshStandardMaterial({ color, roughness: .72 }));
  const charcoal = mat('#24282f'), edge = mat('#161b23'), slate = mat('#424d60'), fold = mat('#333d4c');
  const blue = new THREE.MeshBasicMaterial({ color: '#189dff', toneMapped: false });
  function group(target, name, position = [0, 0, 0]) {
    const object = new THREE.Group(); object.name = name; object.position.set(...position); target.add(object); return object;
  }
  function mesh(target, name, shape, surface, position = [0, 0, 0]) {
    const object = new THREE.Mesh(shape, surface); object.name = name; object.position.set(...position);
    object.castShadow = true; object.receiveShadow = true; target.add(object); return object;
  }
  function hull(target, name, vertices, surface) {
    return mesh(target, name, geo(`aporiax:${name}`, () => new ConvexGeometry(vertices.map(v => new THREE.Vector3(...v)))), surface);
  }
  function oval(target, name, scale, position, surface) {
    const object = mesh(target, name, geo('aporiax:oval', () => new THREE.SphereGeometry(1, 16, 10)), surface, position);
    object.scale.set(...scale); return object;
  }
  const bot = group(parent, 'aporiax-folded-wing', [-.05, .7, .95]);
  bot.userData.modelKind = 'aporiax-folded-wing-v1';
  const body = group(bot, 'body', [0, .32, 0]);
  oval(body, 'torso', [.285, .38, .23], [0, .02, 0], charcoal);
  hull(body, 'chest-facet', [[0,.32,.24],[-.18,.15,.22],[0,-.26,.24],[.18,.15,.22],[0,.1,.27]], fold);
  for (const side of [-1, 1]) {
    oval(bot, `foot-${side}`, [.17, .115, .23], [side * .17, -.13, .15], charcoal);
  }
  const head = group(bot, 'head', [0, .92, 0]);
  hull(head, 'head-shell', [
    [0,-.34,.25],[-.43,-.17,.29],[-.57,.11,.17],[-.43,.34,.04],[0,.37,.1],[.43,.34,.04],[.57,.11,.17],[.43,-.17,.29],
    [0,-.24,-.29],[-.43,-.07,-.24],[-.43,.23,-.23],[0,.34,-.26],[.43,.23,-.23],[.43,-.07,-.24],[-.22,.08,.39],[.22,.08,.39],
  ], charcoal);
  for (const side of [-1, 1]) {
    const ear = group(head, `ear-${side}`);
    hull(ear, `ear-shell-${side}`, [[side*.21,.25,.04],[side*.53,.18,.03],[side*.55,.79,-.03],[side*.22,.24,-.17],[side*.5,.25,-.2]], edge);
    hull(ear, `inner-ear-${side}`, [[side*.28,.29,.065],[side*.47,.26,.06],[side*.5,.65,.02],[side*.41,.34,.08]], slate);
  }
  const face = createMascotEyes(head,'main',{geometry:geo});
  hull(head, 'nose', [[-.033,-.19,.349],[.033,-.19,.349],[0,-.218,.359],[0,-.19,.374]], edge);
  const arms = [-1, 1].map(side => {
    const wing = group(bot, `folded-wing-${side}`, [side*.26,.58,.015]);
    // Wings hang against the chest at rest. Negative Z points toward the desk
    // when the office's shared arm animation tips them forward to work.
    hull(wing, `wing-outline-${side}`, [[0,.05,.01],[side*.39,-.22,.01],[side*.25,-.66,.02],[-side*.12,-.43,.16],[side*.02,-.06,.2],[side*.12,-.31,-.13]], edge);
    hull(wing, `wing-panel-${side}`, [[side*.02,.015,.06],[side*.34,-.24,.07],[side*.21,-.59,.07],[-side*.07,-.39,.2],[side*.09,-.25,.22]], slate);
    hull(wing, `wing-fold-${side}`, [[side*.02,.015,.07],[side*.34,-.24,.08],[side*.09,-.25,.23]], fold);
    return wing;
  });
  const tail = group(bot, 'tail', [0,.08,-.14]);
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0),new THREE.Vector3(.25,-.12,-.2),new THREE.Vector3(.52,-.12,-.25),new THREE.Vector3(.68,.11,-.16),new THREE.Vector3(.79,.25,-.13)]);
  mesh(tail, 'curved-tail', geo('aporiax:tail', () => new THREE.TubeGeometry(curve, 20, .042, 7, false)), edge);
  const tip = oval(tail, 'tail-tip', [.15,.075,.055], [.8,.25,-.13], charcoal); tip.rotation.z = .55;
  const jewel = oval(tail, 'tail-blue-inlay', [.088,.038,.025], [.8,.25,-.077], blue); jewel.rotation.z = .55;
  return { bot, body, head, ...face, arms, tail, modelKind: 'aporiax-folded-wing-v1' };
}
