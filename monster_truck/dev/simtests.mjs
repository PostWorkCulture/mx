import {TruckWorld} from './MonsterTruckSim.js';
const deg=r=>(r*180/Math.PI).toFixed(0);
function run(name,setup,secs,ctrl,every=0.25){
  const W=setup();const dt=1/60;let t=0;const T=W.trucks;
  for(const tr of T){tr.onLand=(v,i)=>console.log(`  [${t.toFixed(2)}] ${tr.name} LAND ${v.toFixed(1)}m/s wheels=${Object.values(i.perWheel).map(x=>x.toFixed(1))} tilt=${deg(i.tilt)}`);
    tr.onRollover=()=>console.log(`  [${t.toFixed(2)}] ${tr.name} ROLLOVER`);
    tr.onImpact=(o,v)=>console.log(`  [${t.toFixed(2)}] ${tr.name} IMPACT ${o?o.name:'static'} ${v.toFixed(1)}m/s`)}
  console.log('== '+name);let next=0;
  while(t<secs){ctrl&&ctrl(t,T);W.step(dt);t+=dt;
    if(t>=next){next+=every;console.log(t.toFixed(2)+' '+T.map(tr=>`${tr.name}: p=(${tr.pos.map(v=>v.toFixed(2))}) v=${tr.speed.toFixed(1)} tilt=${deg(tr.tilt)} pitch=${deg(tr.pitch)} roll=${deg(tr.roll)} s=${Object.values(tr.travel).map(v=>v.toFixed(2))} air=${tr.airborne?1:0}`).join(' | '))}}
  return W;
}
const flat=()=>0;
const which=process.argv[2];
if(which==='rest') run('rest',()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A'});return W},3,null,0.5);
if(which==='drive') run('drive+turn',()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A'});return W},10,(t,T)=>{T[0].input={throttle:1,brake:0,steer:t>4?1:0}},0.5);
if(which==='slalom') run('slalom full lock',()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A'});return W},12,(t,T)=>{T[0].input={throttle:1,brake:0,steer:t>3?Math.sign(Math.sin(t*1.6)):0}},0.5);
const rampH=(z,z0,lip,H)=>{if(z<z0||z>lip+1.2)return 0;if(z<=lip){const t=(z-z0)/(lip-z0);return H*((t*t*(3-2*t))*0.55+0.45*t*t)}const t=(z-lip)/1.2;return H*(1-t)*(1-t)};
const ramp=(xc,z0,lip,H,tiltDeg)=>(x,z)=>{const dx=x-xc;if(Math.abs(dx)>7.5)return 0;const fx=Math.min(1,(7.5-Math.abs(dx)));const Hl=Math.max(0.2,H+dx*Math.tan(tiltDeg*Math.PI/180));return fx*rampH(z,z0,lip,Hl)};
const go=(t,T)=>{T[0].input={throttle:1,brake:0,steer:0}};
if(which==='jump') run('straight 2.8m ramp',()=>{const W=new TruckWorld({groundHeight:ramp(0,40,54,2.8,0)});W.addTruck({name:'A'});return W},9,go,0.5);
if(which==='tilt') run('tilted ramp '+(process.env.TILT||25),()=>{const W=new TruckWorld({groundHeight:ramp(0,40,54,2.6,+(process.env.TILT||25))});W.addTruck({name:'A'});return W},9,go,0.5);
if(which==='tilt12') run('tilted 12deg ramp',()=>{const W=new TruckWorld({groundHeight:ramp(0,40,54,2.6,12)});W.addTruck({name:'A'});return W},9,go,0.5);
if(which==='tbone') run('T-bone',()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A',x:0,z:0,yaw:0});W.addTruck({name:'B',x:-40,z:0,yaw:Math.PI/2});return W},6,(t,T)=>{T[0].input={throttle:0,brake:1,steer:0};T[1].input={throttle:1,brake:0,steer:0}},0.25);
if(which==='roof') {const W=run('roof rest',()=>{const W=new TruckWorld({groundHeight:flat});const tr=W.addTruck({name:'A'});tr.q=[0,0,1,0];tr.pos=[0,3.6,0];return W},4,null,0.5);
  W.trucks[0].recover();console.log('recovered ->',W.trucks[0].pos.map(v=>v.toFixed(2)),W.trucks[0].tilt.toFixed(2));
  for(let i=0;i<120;i++)W.step(1/60);console.log('after 2s',W.trucks[0].pos.map(v=>v.toFixed(2)),'tilt',W.trucks[0].tilt.toFixed(2));}
if(which==='drift') run('handbrake-ish drift: full lock at 20 m/s',()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A'});return W},10,(t,T)=>{T[0].input={throttle:1,brake:0,steer:t>4?1:0};if(t>4&&t<4.02){const tr=T[0];}},0.5);
if(which==='tbone2') run('T-bone fast '+(process.env.V||24),()=>{const W=new TruckWorld({groundHeight:flat});W.addTruck({name:'A',x:0,z:0,yaw:0});const B=W.addTruck({name:'B',x:-12,z:+(process.env.OFF||0),yaw:Math.PI/2});B.vel=[+(process.env.V||24),0,0];return W},4,(t,T)=>{T[0].input={throttle:0,brake:1,steer:0};T[1].input={throttle:1,brake:0,steer:0}},0.25);
if(which==='side') run('sideways slide '+(process.env.V||10),()=>{const W=new TruckWorld({groundHeight:flat});const A=W.addTruck({name:'A'});A.vel=[+(process.env.V||10),0,0];return W},2.5,(t,T)=>{T[0].input={throttle:0,brake:0,steer:0}},0.1);
