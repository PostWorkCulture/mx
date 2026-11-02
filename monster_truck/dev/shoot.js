const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const jobs=JSON.parse(fs.readFileSync(process.argv[2]));const W=+process.argv[3]||1600,H=+process.argv[4]||900;const glb=process.argv[5]||'monster_truck_lime_black.glb';
const types={'.js':'text/javascript','.html':'text/html','.jpg':'image/jpeg','.png':'image/png'};
const srv=http.createServer((q,s)=>{const p=path.join(__dirname,decodeURIComponent(q.url.split('?')[0]));fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});s.end(d)})}).listen(8129,async()=>{
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const pg=await b.newPage({viewport:{width:W,height:H}});pg.on('pageerror',e=>console.log('ERR',e.message));pg.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text())});
await pg.goto(`http://localhost:8129/mt_view.html?w=${W}&h=${H}&f=${glb}`);await pg.waitForFunction('window.ready',null,{timeout:300000});
console.log(JSON.stringify(await pg.evaluate('window.info')));
for(const j of jobs){const d=await pg.evaluate(o=>window.pose(o),j);fs.writeFileSync(j.out,Buffer.from(d.split(',')[1],'base64'));console.log('done',j.out)}
await b.close();srv.close()});
