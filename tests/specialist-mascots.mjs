import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSpecialistMascot, SPECIALIST_MODELS } from '../src/office/specialist-mascots.js';
const anchors = { explore: ['coiled-tail','glider-head','tail-beacon'], review: ['heart-face','curved-bracket--1','curved-bracket-1'], verify: ['folded-ear--1','folded-ear-1','caliper--1'], builder: ['coral-claw--1','opposing-claw-tip-1','paddle-tail','charcoal-leg--1'], curator: ['index-ear--1','index-ear-1','outer-index-board','pink-index-board','mint-index-board','teal-leg--1'] };
let total = 0;
for (const [role,kind] of Object.entries(SPECIALIST_MODELS)) {
  const root = new THREE.Group(), actor = createSpecialistMascot(root,role);
  assert.equal(actor.modelKind,kind); assert.equal(actor.eyes.length,2); assert.equal(actor.arms.length,2);
  for (const name of anchors[role]) assert(root.getObjectByName(name),`${role}: ${name}`);
  let triangles=0,meshes=0; const geometries=new Set(), materials=new Set();
  root.traverse(object => {
    if (!object.isMesh) return; meshes++;
    const positions=object.geometry.attributes.position;
    assert(positions.count>0,`${role}/${object.name} has solid geometry`);
    assert([...positions.array].every(Number.isFinite),`${role}/${object.name} finite vertices`);
    assert([...object.geometry.attributes.normal.array].every(Number.isFinite),`${role}/${object.name} finite normals`);
    assert(!object.material.map,'No portrait billboard in the 3D model');
    triangles+=(object.geometry.index?.count||positions.count)/3;
    geometries.add(object.geometry); materials.add(object.material);
  });
  for (const state of ['working','waiting','sleeping','offline','attention','error']) {
    actor.animate(3.4,state);
    actor.animateFace(0,state);
    const sleeping=state==='sleeping'||state==='offline';
    assert(actor.eyes.every(eye=>eye.visible===!sleeping),`${role}: open eyes match current state`);
    assert.equal(actor.head.getObjectByName('closed-lid-1').visible,sleeping,`${role}: sleeping shows a closed lid instead of a glowing slit`);
    for (const node of [actor.tail,...actor.arms]) assert([node.rotation.x,node.rotation.y,node.rotation.z].every(Number.isFinite));
  }
  const size=new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  assert(size.x<2.3&&size.y<2.2&&size.z<1.7,`${role} fits its desk: ${size.toArray()}`);
  assert(meshes<65&&triangles<11000,`${role} stays lightweight: ${meshes}/${triangles}`);
  geometries.forEach(value=>value.dispose());materials.forEach(value=>value.dispose());total+=triangles;
  console.log(`PASS ${kind}: ${meshes} solid meshes, ${triangles} triangles, distinct design anchors and state poses.`);
}
assert.equal(createSpecialistMascot(new THREE.Group(),'unknown'),null,'Unknown runtime roles retain the existing fallback');
assert(total<45000);
