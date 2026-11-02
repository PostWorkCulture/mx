const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const PORT=+(process.env.PORT||8133);const mode=process.argv[2],glb=process.argv[3],out=process.argv[4];const W=1280,H=720;
const types={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.jpg':'image/jpeg','.png':'image/png'};
const srv=http.createServer((q,s)=>{const p=path.join(__dirname,decodeURIComponent(q.url.split('?')[0]));fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});s.end(d)})}).listen(PORT,async()=>{
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const pg=await b.newPage({viewport:{width:W,height:H}});pg.on('pageerror',e=>console.log('ERR',e.message));
await pg.goto(`http://localhost:${PORT}/mt_dirt.html?w=${W}&h=${H}&scene=${process.env.SCENE||'A'}${process.env.CLOSE?'&close='+process.env.CLOSE:''}`);await pg.waitForFunction('window.ready',null,{timeout:300000});
const N=+(process.env.N||255);const t0=Date.now();
if(mode==='sim'){ // physics only (no render) – print trajectory
  for(let f=0;f<N;f++){await pg.evaluate(f=>window.frame(f,true),f);const st=await pg.evaluate('window.state()');
   if(f%10==0)console.log(f,JSON.stringify(st))}
}
if(mode==='keys'){const K=process.env.K.split(',').map(Number);
  for(let f=0;f<=Math.max(...K);f++){const d=await pg.evaluate(([f,r])=>window.frame(f,!r),[f,K.includes(f)]);const st=await pg.evaluate('window.state()');
   
   if(K.includes(f))fs.writeFileSync(`key_${f}.jpg`,Buffer.from(d.split(',')[1],'base64'))}}
if(mode==='video'){const ff=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate','30','-c:v','mjpeg','-i','-','-c:v','libx264','-preset','slow','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart','tmp_'+out],{stdio:['pipe','inherit','inherit']});
  for(let f=0;f<N;f++){ff.stdin.write(Buffer.from((await pg.evaluate(f=>window.frame(f),f)).split(',')[1],'base64'));if(f%30==0)console.log('frame',f,((Date.now()-t0)/1000).toFixed(0)+'s')}
  ff.stdin.end();await new Promise(r=>ff.on('close',c=>{console.log('ffmpeg',c);if(c===0)fs.renameSync('tmp_'+out,out);r()}))}
await b.close();srv.close()});
