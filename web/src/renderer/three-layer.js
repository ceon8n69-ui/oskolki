import {sceneModel,visibleChunks} from './scene-model.js';
/** Inject the application's THREE namespace; no second SDK, login or game state. */
export class KingdomLayer {
 constructor(THREE,host,{onTile=()=>{},atlasUrl=new URL('../../art/kingdom-atlas.png',import.meta.url)}={}){
  this.T=THREE;this.host=host;this.root=new THREE.Scene();this.root.background=new THREE.Color('#bacbbb');
  this.camera=new THREE.OrthographicCamera(-12,12,12,-12,.1,300);this.camera.position.set(30,35,30);this.camera.lookAt(0,0,0);
  this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.append(this.renderer.domElement);
  this.content=new THREE.Group();this.root.add(this.content);this.textures=[];
  const loader=new THREE.TextureLoader();this.ready=new Promise((resolve,reject)=>loader.load(String(atlasUrl),tex=>{tex.colorSpace=THREE.SRGBColorSpace;this.atlas=tex;resolve();},undefined,reject));
  this.ray=new THREE.Raycaster();this.plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
  this.click=e=>{const b=this.renderer.domElement.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1),this.camera);const p=new THREE.Vector3();if(this.ray.ray.intersectPlane(this.plane,p))onTile({x:Math.round(p.x),y:Math.round(p.z)});};
  this.renderer.domElement.addEventListener('click',this.click);this.resize=new ResizeObserver(()=>this.fit());this.resize.observe(host);this.fit();
 }
 fit(){const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h);const span=this.span??12;this.camera.left=-span*w/h;this.camera.right=span*w/h;this.camera.top=span;this.camera.bottom=-span;this.camera.updateProjectionMatrix();this.render();}
 setCamera(x,y,span=12){this.span=Math.max(3,Math.min(60,span));this.camera.position.set(x+30,35,y+30);this.camera.lookAt(x,0,y);this.fit();}
 bounds(){const T=this.T,points=[];for(const x of [-1,1])for(const y of [-1,1]){this.ray.setFromCamera(new T.Vector2(x,y),this.camera);const p=new T.Vector3();if(this.ray.ray.intersectPlane(this.plane,p))points.push(p);}
 return{minX:Math.floor(Math.min(...points.map(p=>p.x)))-3,maxX:Math.ceil(Math.max(...points.map(p=>p.x)))+3,minY:Math.floor(Math.min(...points.map(p=>p.z)))-3,maxY:Math.ceil(Math.max(...points.map(p=>p.z)))+3};}
 async sync(client){const request=this.request=(this.request??0)+1;const state=client.state;if(!state)return;const bounds=this.bounds();await Promise.all([this.ready,client.loadChunks(visibleChunks(bounds,state.view.map))]);if(request!==this.request||client.state!==state)return;this.tileSnapshot=new Map();for(let y=Math.max(0,bounds.minY);y<=Math.min(state.view.map.height-1,bounds.maxY);y++)for(let x=Math.max(0,bounds.minX);x<=Math.min(state.view.map.width-1,bounds.maxX);x++){const t=client.tile(x,y);this.tileSnapshot.set(x+','+y,t?{...t}:null);}this.lastBounds=bounds;this.setModel(sceneModel(state,(x,y)=>this.tileSnapshot.get(x+','+y)??null,bounds));}
 clear(){this.content.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});this.content.clear();for(const t of this.textures)t.dispose();this.textures=[];}
 sprite(kind,x,y,width,opacity=1){const T=this.T,rects={castle:[0,0,445,610],tree:[445,0,390,610],mountain:[835,0,419,610],shieldbearer:[0,620,440,570],archer:[445,620,365,570],bridge:[815,650,439,510]},r=rects[kind];if(!r)return false;
  const tex=this.atlas.clone();tex.repeat.set(r[2]/1254,r[3]/1254);tex.offset.set(r[0]/1254,1-(r[1]+r[3])/1254);tex.needsUpdate=true;this.textures.push(tex);
  const s=new T.Sprite(new T.SpriteMaterial({map:tex,transparent:true,opacity,depthWrite:false,alphaTest:.05}));s.center.set(.5,.08);s.scale.set(width,width*r[3]/r[2],1);s.position.set(x,.08,y);this.content.add(s);return true;
 }
 label(text,x,y,color='#20364e',opacity=1){const T=this.T,c=document.createElement('canvas');c.width=256;c.height=64;const g=c.getContext('2d');g.fillStyle='#f5efdf';g.fillRect(0,0,256,64);g.fillStyle=color;g.font='bold 28px sans-serif';g.textAlign='center';g.fillText(String(text).slice(0,16),128,42);const tex=new T.CanvasTexture(c);this.textures.push(tex);const s=new T.Sprite(new T.SpriteMaterial({map:tex,opacity,transparent:true,depthTest:false}));s.scale.set(1.8,.45,1);s.position.set(x,.15,y);this.content.add(s);}
 setModel(model){this.clear();this.unitNodes=new Map();this.modelSignature=this.signature(model);this.effectKey='';const T=this.T,far=this.span>24,colors={0:'#286779',1:'#4badb3',2:'#aabc77',3:'#91ab66',4:'#b6ad80',5:'#9b9d90',255:'#344653'};
  const batches=new Map();for(const t of model.tiles){const key=t.terrain+':'+t.visible;if(!batches.has(key))batches.set(key,[]);batches.get(key).push(t);}
  for(const ts of batches.values()){const first=ts[0],color=new T.Color(colors[first.terrain]??colors[255]);if(!first.visible&&first.terrain!==255)color.multiplyScalar(.5);const mesh=new T.InstancedMesh(new T.BoxGeometry(.99,.12,.99),new T.MeshBasicMaterial({color}),ts.length);ts.forEach((t,i)=>mesh.setMatrixAt(i,new T.Matrix4().makeTranslation(t.x,-.08,t.y)));this.content.add(mesh);}
  for(const t of model.tiles){if(t.terrain===255)continue;const a=t.visible?1:.4;
   if(!far&&t.terrain===3)this.sprite('tree',t.x,t.y,1.25,a);if(!far&&t.terrain===5)this.sprite('mountain',t.x,t.y,1.6,a);
   if(t.features&2)this.sprite('bridge',t.x,t.y,1.4,a);
   const marks=[];if(t.features&1)marks.push('━');if(t.features&4)marks.push(t.looted?'руины · пусто':'руины');if(t.features&8)marks.push('святилище');if(t.features&16)marks.push('лес');if(t.features&32)marks.push('Fe');if(t.features&64)marks.push('◆');if(t.features&128)marks.push('форт');if(marks.length)this.label(marks.join(' '),t.x,t.y,'#506553',a);
  }
  for(const c of model.cities){if(!far)this.sprite('castle',c.x,c.y,2.3,c.opacity);this.label(`${c.name} · ${c.level}`,c.x,c.y,c.color,c.opacity);}
  for(const u of model.units){const start=this.content.children.length;const drawn=!far&&this.sprite(u.type,u.x,u.y,.8,u.opacity);this.label(`${drawn?'':u.type+' '}${u.stale?'ход '+u.seenTurn:u.hp+' HP'}${u.cargo?' ⛵'+u.cargo:''}`,u.x,u.y,u.color,u.opacity);this.unitNodes.set(u.id,{x:u.x,y:u.y,nodes:this.content.children.slice(start).map(node=>({node,x:node.position.x-u.x,z:node.position.z-u.y}))});}
  for(const s of model.structures)this.label(s.linked?'◆ связь':'◆',s.x,s.y,s.color);
  for(const r of model.routes){if(r.points.length<2)continue;const g=new T.BufferGeometry().setFromPoints(r.points.map(p=>new T.Vector3(p.x,.06,p.y)));const m=r.dashed?new T.LineDashedMaterial({color:'#f1c963',dashSize:.15,gapSize:.12}):new T.LineBasicMaterial({color:'#85e0e8'});const line=new T.Line(g,m);line.computeLineDistances();this.content.add(line);}
  this.render();
 }
 signature(m){return JSON.stringify([m.units.map(u=>[u.id,u.hp,u.stale]),m.cities.map(c=>[c.id,c.owner,c.contestedBy])]);}
 present(state,effects=[]){
  if(!this.tileSnapshot||!this.lastBounds)return;
  const m=sceneModel(state,(x,y)=>this.tileSnapshot.get(x+','+y)??null,this.lastBounds);
  if(this.signature(m)!==this.modelSignature)this.setModel(m);
  for(const u of m.units){const entry=this.unitNodes.get(u.id);if(!entry)continue;for(const {node,x,z} of entry.nodes){node.position.x=u.x+x;node.position.z=u.y+z;node.material.opacity=u.opacity;}}
  const key=JSON.stringify(effects.map(e=>[e.kind,e.x,e.y,e.text]));
  if(key!==this.effectKey){for(const n of this.effectNodes??[]){this.content.remove(n);n.material.map?.dispose();n.material.dispose();}this.effectNodes=[];for(const e of effects){const i=this.content.children.length;this.label('-'+e.text,e.x,e.y,'#b54a35');this.effectNodes.push(...this.content.children.slice(i));}this.effectKey=key;}
  effects.forEach((e,i)=>{const n=this.effectNodes?.[i];if(n)n.position.y=1.2+e.progress*.3;});this.render();
 }
 render(){this.renderer.render(this.root,this.camera);}
 dispose(){this.request=(this.request??0)+1;this.resize.disconnect();this.renderer.domElement.removeEventListener('click',this.click);this.clear();this.atlas?.dispose();this.ready.then(()=>this.atlas?.dispose(),()=>{});this.renderer.dispose();this.renderer.domElement.remove();}
}
