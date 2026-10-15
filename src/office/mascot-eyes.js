import * as THREE from 'three';

// The outer contour, iris and lid each carry character; a shared gold ring
// would erase that distinction at the office camera's small viewing scale.
const PROFILES = {
  main:    { width:.205, height:.167, x:.245, y:.012, z:.392, contour:'almond', color:'#159bf1', iris:'full', pupil:.025, gaze:.006, period:5.8 },
  explore: { width:.133, height:.165, x:.218, y:-.035, z:.400, tilt:-.34, contour:'curious', color:'#f3d66a', iris:'oval', irisX:.032, irisY:.088, gaze:.017, period:3.9 },
  review:  { width:.165, height:.117, x:.222, y:.003, z:.400, contour:'keen', color:'#ebc661', iris:'full', pupil:.023, gaze:.005, period:6.4 },
  verify:  { width:.115, height:.172, x:.204, y:-.012, z:.400, tilt:-.21, contour:'precise', color:'#f4df73', iris:'oval', irisX:.027, irisY:.092, gaze:.006, period:5.1 },
  builder: { width:.122, height:.143, x:.217, y:-.043, z:.400, tilt:-.08, contour:'resolute', color:'#f08066', iris:'oval', irisX:.030, irisY:.082, gaze:.007, period:5.6 },
  curator: { width:.145, height:.159, x:.215, y:-.010, z:.400, tilt:-.14, contour:'gentle', color:'#e9d692', iris:'oval', irisX:.039, irisY:.076, gaze:.010, period:4.9 },
};

function outline(kind, side, width, height) {
  const shape = new THREE.Shape();
  const move = (x,y) => shape.moveTo(x*side*width,y*height);
  const curve = (a,b,c,d,e,f) => shape.bezierCurveTo(a*side*width,b*height,c*side*width,d*height,e*side*width,f*height);
  // X points to the outside corner of each eye. Mirror the contour, not the
  // lighting: both catchlights stay upper-left in the character's front view.
  if (kind === 'keen') {
    move(-1,-.45); curve(-.78,.03,.12,.71,1,.96);
    curve(.91,-.24,.48,-1.02,-.12,-.90); curve(-.64,-.85,-.87,-.64,-1,-.45);
  } else if (kind === 'almond') {
    move(-1,-.36); curve(-.66,.24,.19,.85,1,.80);
    curve(.92,-.24,.44,-1.02,-.22,-.88); curve(-.61,-.80,-.86,-.58,-1,-.36);
  } else if (kind === 'curious') {
    move(-.86,.38); curve(-.45,.93,.50,1.16,.91,.55);
    curve(1.22,-.10,.72,-.97,.07,-1); curve(-.64,-.97,-1.12,-.28,-.86,.38);
  } else if (kind === 'precise') {
    move(-.86,.53); curve(-.40,1.12,.48,1.01,.85,.42);
    curve(1.16,-.26,.65,-1.05,.05,-1); curve(-.61,-.94,-1.13,-.17,-.86,.53);
  } else if (kind === 'resolute') {
    move(-.87,.25); curve(-.33,.40,.40,1.03,.83,.78);
    curve(1.22,-.02,.70,-1.01,.03,-1); curve(-.62,-.96,-1.09,-.36,-.87,.25);
  } else {
    move(-.89,.42); curve(-.44,.97,.43,1.12,.89,.46);
    curve(1.20,-.24,.59,-1.05,-.03,-1); curve(-.66,-.93,-1.12,-.24,-.89,.42);
  }
  shape.closePath(); return shape;
}

// A shallow, closed lens follows the eye contour. Concentric rings give the
// face real curvature without a protruding spherical eyeball or a flat decal.
function lensGeometry(shape) {
  const points = shape.getPoints(12);
  if (points[0].distanceTo(points.at(-1)) < .00001) points.pop();
  if (THREE.ShapeUtils.isClockWise(points)) points.reverse();
  const n = points.length, center = points.reduce((sum,p) => sum.add(p),new THREE.Vector2()).multiplyScalar(1/n);
  const positions=[center.x,center.y,.025], colors=[1,1,1], indices=[];
  for (const r of [.34,.68,1]) for (const p of points) {
    const x=THREE.MathUtils.lerp(center.x,p.x,r),y=THREE.MathUtils.lerp(center.y,p.y,r);
    positions.push(x,y,.008+.017*(1-r*r));
    const shade=.94+.06*(1-r); colors.push(shade,shade,shade);
  }
  for(let i=0;i<n;i++) {
    const next=(i+1)%n; indices.push(0,1+i,1+next);
    for(let ring=0;ring<2;ring++) {
      const a=1+ring*n+i,b=1+ring*n+next,c=a+n,d=b+n;
      indices.push(a,c,b,b,c,d);
    }
  }
  const back=positions.length/3; positions.push(center.x,center.y,-.004); colors.push(.9,.9,.9);
  for(let i=0;i<n;i++) indices.push(back,1+2*n+(i+1)%n,1+2*n+i);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}

export function createMascotEyes(head, role, { geometry } = {}) {
  const profile = PROFILES[role];
  if (!profile) throw new Error(`Unknown mascot eye profile: ${role}`);
  const geo = geometry || ((_key,factory) => factory());
  const ink = new THREE.MeshBasicMaterial({color:role === 'review' ? '#401e35' : '#102635',toneMapped:false});
  const color = new THREE.MeshBasicMaterial({color:profile.color,toneMapped:false,vertexColors:true});
  const light = new THREE.MeshBasicMaterial({color:'#fff9e6',toneMapped:false});
  const lidMaterial = new THREE.MeshBasicMaterial({color:role === 'main' ? '#596879' : role === 'review' ? '#70334f' : role === 'verify' ? '#a8a077' : '#243e49',toneMapped:false});
  const eyes = [], lids = [], irises = [];
  function mesh(parent, name, geometry, material) {
    const object = new THREE.Mesh(geometry,material); object.name = name;
    // Face markings must not cast detached shadows onto the face or each other.
    object.castShadow = false; object.receiveShadow = false; parent.add(object); return object;
  }
  const sphere = geo('mascot:eye-oval', () => {
    const shape = new THREE.SphereGeometry(1,20,12);
    shape.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(shape.attributes.position.count*3).fill(1),3));
    return shape;
  });
  function oval(parent,name,scale,position,material) {
    const object = mesh(parent,name,sphere,material); object.scale.set(...scale);object.position.set(...position);return object;
  }
  for (const side of [-1,1]) {
    const eye = new THREE.Group(); eye.name = `eye-${side}`;
    eye.position.set(side*profile.x,profile.y,profile.z);
    eye.rotation.z=side*(profile.tilt||0);
    head.add(eye); eyes.push(eye);
    const contour = geo(`mascot:eye:${role}:${side}`, () => lensGeometry(outline(profile.contour,side,profile.width,profile.height)));
    mesh(eye,'sculpted-eye-outline',contour,ink);
    const gaze = new THREE.Group(); gaze.name = 'gaze'; eye.add(gaze); irises.push(gaze);
    if (profile.iris === 'full') {
      const iris = mesh(eye,'colored-eye-inset',contour,color);
      iris.scale.set(.87,.82,.45); iris.position.z = .015;
      oval(gaze,'slit-pupil',[profile.pupil,role === 'main' ? .091 : .061,.008],[side*.018,-.018,.034],ink);
    } else {
      // The approved four faces have a solid colored iris on a dark eye, not
      // a ring around a second pupil. Forge's iris uses its original coral.
      oval(gaze,'solid-iris',[profile.irisX,profile.irisY,.009],[side*.010,-.012,.031],color);
    }
    oval(gaze,'eye-catchlight',[role === 'main' ? .012 : .009,.017,.006],[-.028,.045,.046],light);
    const arc = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-profile.width*.82,0,0),
      new THREE.Vector3(0,-profile.height*.40,0),
      new THREE.Vector3(profile.width*.82,.012,0),
    );
    const lid = mesh(head,`closed-lid-${side}`,geo(`mascot:lid:${role}`,()=>new THREE.TubeGeometry(arc,14,.009,6,false)),lidMaterial);
    lid.position.copy(eye.position); lid.position.y -= .012; lid.position.z += .014; lid.rotation.z=eye.rotation.z; lid.visible=false; lids.push(lid);
  }
  function animateFace(t,state) {
    const resting = state === 'sleeping' || state === 'offline';
    const phase = ((t + profile.period*.41) % profile.period + profile.period) % profile.period;
    const blink = phase < .22 ? Math.sin(phase/.22*Math.PI) : 0;
    const openness = resting ? 0 : 1-blink;
    for (let i=0;i<eyes.length;i++) {
      eyes[i].visible = openness > .12; eyes[i].scale.y = Math.max(.08,openness);
      lids[i].visible = openness <= .12;
      // Keep attention on the workstation, including while waiting. Blinking
      // remains independent, but there is no sideways or viewer-facing glance.
      irises[i].position.x = 0;
      irises[i].position.y = state === 'working' ? -.012 : -.006;
    }
  }
  animateFace(0,'waiting');
  return { eyes, eyeMat:color, eyeColor:profile.color, eyeSleepColor:profile.color, animateFace };
}
