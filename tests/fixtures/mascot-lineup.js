import * as THREE from 'three';
import { createAporiaxMascot } from '../../src/office/aporiax-mascot.js';
import { createSpecialistMascot } from '../../src/office/specialist-mascots.js';
const stage=document.querySelector('#stage'), scene=new THREE.Scene();
const renderer=new THREE.WebGLRenderer({ antialias:true,alpha:true,preserveDrawingBuffer:true });
renderer.setPixelRatio(1); renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
renderer.shadowMap.enabled=true;stage.append(renderer.domElement);
const camera=new THREE.OrthographicCamera(-6,6,4.5,-4.5,.1,100);
const hemi=new THREE.HemisphereLight('#e0efff','#b9a98e',2.5);scene.add(hemi);
const sun=new THREE.DirectionalLight('#fff2db',3);sun.position.set(-4,12,8);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-7,right:7,top:7,bottom:-7,near:1,far:35});sun.shadow.normalBias=.025;scene.add(sun);
const fill=new THREE.DirectionalLight('#c2dff4',1.1);fill.position.set(6,5,-4);scene.add(fill);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({color:'#4d594e',opacity:.16}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const geometries=new Map(),materials=new Map(),actors=new Map(),labels=[];
const helpers={ geometry:(key,factory)=>{if(!geometries.has(key))geometries.set(key,factory());return geometries.get(key);}, material:color=>{if(!materials.has(color))materials.set(color,new THREE.MeshStandardMaterial({color,roughness:.76}));return materials.get(color);} };
const roles=['main','explore','review','verify','builder','curator'];
const names=['阿珀 · AporiaX','探奇 · Scout','察微 · Sentry','验准 · Checko','搭匠 · Forge','知序 · Index'];
roles.forEach((role,index)=>{
  const root=new THREE.Group();scene.add(root);
  const actor=role==='main'?createAporiaxMascot(root,helpers):createSpecialistMascot(root,role,helpers);
  actor.animate?.(0,'waiting');
  const bounds=new THREE.Box3().setFromObject(root), center=bounds.getCenter(new THREE.Vector3());
  root.position.set((index%3-1)*2.8-center.x,-bounds.min.y,-2+(index>=3?4:0)-center.z);
  actors.set(role,{root,actor,position:root.position.clone()});
  const label=document.createElement('span');label.textContent=names[index];document.querySelector('#names').append(label);labels.push({role,label,position:new THREE.Vector3((index%3-1)*2.8,-.15,-2+(index>=3?4:0))});
});
let focused=null, faceView=false;
function draw(){renderer.render(scene,camera);labels.forEach(({role,label,position})=>{const projected=position.clone().project(camera);label.style.left=`${(projected.x*.5+.5)*stage.clientWidth}px`;label.style.top=`${(-projected.y*.5+.5)*stage.clientHeight}px`;label.style.display=!focused||role===focused?'block':'none';});}
function resize(){const aspect=stage.clientWidth/stage.clientHeight;const h=faceView?2.05:focused?1.5:4.2;camera.left=-h*aspect;camera.right=h*aspect;camera.top=h;camera.bottom=-h;camera.updateProjectionMatrix();renderer.setSize(stage.clientWidth,stage.clientHeight);draw();}
function reset(){focused=null;faceView=false;floor.visible=true;for(const {root,actor,position} of actors.values()){root.visible=true;root.position.copy(position);actor.bot.children.forEach(child=>child.visible=true);actor.animateFace?.(0,'waiting');}labels.forEach(({position},i)=>position.set((i%3-1)*2.8,-.15,-2+(i>=3?4:0)));camera.position.set(2,10,13);camera.lookAt(0,.8,0);resize();}
window.mascotLineup={
  reset,
  faces(state='waiting',time=0){
    reset();faceView=true;floor.visible=false;
    [...actors.values()].forEach(({root,actor},i)=>{
      actor.bot.children.forEach(child=>child.visible=child===actor.head);
      const head=actor.head.getWorldPosition(new THREE.Vector3());
      const target=new THREE.Vector3((i%3-1)*1.75,i<3?.85:-.95,0);
      root.position.add(target.sub(head));actor.animateFace(time,state);
      labels[i].position.set((i%3-1)*1.75,(i<3?.85:-.95)-.55,.5);
    });
    camera.position.set(0,.05,8);camera.lookAt(0,.05,0);resize();
  },
  focus(role){focused=role;for(const [id,{root}]of actors)root.visible=id===role;const {root}=actors.get(role);const target=new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());camera.position.copy(target).add(new THREE.Vector3(1.4,1.0,6));camera.lookAt(target);resize();},
  diagnostics(){let triangles=0;for(const {root}of actors.values())root.traverse(object=>{if(object.isMesh)triangles+=(object.geometry.index?.count||object.geometry.attributes.position.count)/3;});return{models:Object.fromEntries([...actors].map(([id,{actor}])=>[id,actor.modelKind])),calls:renderer.info.render.calls,triangles,renderTriangles:renderer.info.render.triangles};},
};
window.addEventListener('resize',resize);reset();
