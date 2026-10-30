import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const routes={'/':'index.html','/index.html':'index.html','/game.js':'game.js','/style.css':'style.css'};
const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,version:'0.1.0'}));}
 const file=routes[path];if(!file){res.writeHead(404);return res.end('Not found');}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
 try{const data=await readFile(new URL('./public/'+file,import.meta.url));res.writeHead(200,{'Content-Type':mime[file.split('.').pop()],'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);}catch{res.writeHead(500);res.end('Server error');}
}).listen(Number(process.env.PORT||3000),'0.0.0.0');
