/** Presentation-only Canvas 2.5D kit. Coordinates and animation progress come from the game. */
export const PALETTE = Object.freeze({blue:'#326cbd',green:'#43834e',gold:'#efba56',stone:'#eddfbb',ink:'#20364e',water:'#47acb6'});
export const clamp = n=>Math.max(0,Math.min(1,n));
export function project(x,y,z,c){return {x:c.width/2+(x-y-c.x+c.y)*c.size,y:c.height*.46+(x+y-c.x-c.y)*c.size*.5-z*c.size}}
export function unproject(x,y,c){const a=(x-c.width/2)/c.size,b=(y-c.height*.46)/(c.size*.5);return{x:c.x+(a+b)/2,y:c.y+(b-a)/2}}
function tone(hex,f){const n=parseInt(hex.slice(1),16);return '#'+[n>>16,(n>>8)&255,n&255].map(v=>Math.round(Math.min(255,v*f)).toString(16).padStart(2,'0')).join('')}
export function makePainter(ctx,c,atlas=null){
 function polygon(points,color,stroke){ctx.beginPath();points.forEach(([x,y,z=0],i)=>{let p=project(x,y,z,c);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});ctx.closePath();ctx.fillStyle=color;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke()}}
 function box(x,y,z,w,d,h,col){polygon([[x,y+d,z],[x+w,y+d,z],[x+w,y+d,z+h],[x,y+d,z+h]],tone(col,.88));polygon([[x+w,y,z],[x+w,y+d,z],[x+w,y+d,z+h],[x+w,y,z+h]],tone(col,.7));polygon([[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]],col)}
 function pyramid(x,y,z,w,h,col){polygon([[x-w,y-w,z],[x+w,y-w,z],[x,y,z+h]],tone(col,.94));polygon([[x+w,y-w,z],[x+w,y+w,z],[x,y,z+h]],tone(col,.72));polygon([[x+w,y+w,z],[x-w,y+w,z],[x,y,z+h]],col)}
 function line(a,b,col,width=2){let p=project(...a,c),q=project(...b,c);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.strokeStyle=col;ctx.lineWidth=width;ctx.lineCap='round';ctx.stroke()}
 function ellipse(x,y,z,rx,ry,col){let p=project(x,y,z,c);ctx.beginPath();ctx.ellipse(p.x,p.y,rx*c.size,ry*c.size,0,0,Math.PI*2);ctx.fillStyle=col;ctx.fill()}
 function label(x,y,z,text,col='#20364e'){let p=project(x,y,z,c);ctx.font=`600 ${Math.max(10,Math.min(14,c.size*.18))}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=4;ctx.strokeStyle='#f4eddd';ctx.strokeText(text,p.x,p.y);ctx.fillStyle=col;ctx.fillText(text,p.x,p.y)}
 function sprite(kind,x,y,opts={}){return atlas?atlas(ctx,kind,project(x,y,0,c),c.size,opts):false}return{polygon,box,pyramid,line,ellipse,label,sprite};
}
export function drawTile(p,x,y,type,variation=0,time=0){let col=type==='water'?PALETTE.water:type==='road'?'#c9b98a':variation>.5?'#a8bf72':'#b2c77d';p.box(x-.5,y-.5,-.2,1,1,.2,col);if(type==='water'){for(let i=0;i<2;i++){let f=(time*.00015+i*.4+x*.07)%1;p.line([x-.3+f*.15,y-.2+i*.4,.015],[x+.06+f*.15,y-.2+i*.4,.015],'#a5e2df',1)}}else if(type==='road'){for(let i=0;i<3;i++)p.box(x-.32+i*.22,y-.14,.005,.17,.24,.015,'#ded0a6')}}
export function drawBank(p,x,y){
 for(let i=0;i<3;i++){let yy=y-.32+i*.3;p.pyramid(x+(i%2)*.04,yy,-.12,.12+(i%2)*.025,.16+(i%2)*.05,i%2?'#989e8a':'#b1b49b')}
}
export function drawShrub(p,x,y){p.ellipse(x,y,.02,.13,.045,'#41634333');p.pyramid(x,y,.025,.12,.17,'#78984c');p.pyramid(x+.1,y+.04,.02,.08,.12,'#91aa56')}
export function drawSmoke(p,x,y,time=0,reducedMotion=false){for(let i=0;i<3;i++){let t=reducedMotion?i/3:(time/2400+i/3)%1;p.ellipse(x+t*.16,y, .75+t*.7,.04+t*.09,.035+t*.07,`rgba(236,230,209,${(1-t)*.35})`)}}
export function drawTree(p,x,y,size=1,variant=0){if(p.sprite?.('tree',x,y))return;p.ellipse(x+.15,y+.12,.015,.38*size,.12*size,'#254c3a28');p.box(x-.045,y-.045,0,.09,.09,.28*size,'#795637');if(variant){for(let [dx,dy,z]of [[0,0,.35],[-.12,.05,.48],[.1,-.05,.63]])p.pyramid(x+dx,y+dy,z*size,.28*size,.35*size,'#6e9b45')}else for(let i=0;i<3;i++)p.pyramid(x,y,(.18+i*.19)*size,(.31-i*.065)*size,.51*size,i===2?'#639650':'#3d7951')}
export function drawMountain(p,x,y,size=1){if(p.sprite?.('mountain',x,y))return;p.pyramid(x,y,.02,.49,size*1.3,'#a8aaa1');p.pyramid(x-.04,y+.03,size*.82,.18,size*.43,'#d7d5c4');p.pyramid(x+.24,y+.24,0,.23,size*.65,'#8d9891')}
export function drawBridge(p,x,y){if(p.sprite?.('bridge',x,y))return;for(let i=0;i<8;i++)p.box(x-.5+i*.125,y-.32,.045,.115,.64,.08,i%2?'#bc9564':'#caab77');for(let dy of [-.3,.3]){for(let dx of [-.45,0,.45])p.box(x+dx,y+dy,.08,.035,.035,.3,'#866441');p.line([x-.48,y+dy,.34],[x+.48,y+dy,.34],'#a57e4d',3)}}
export function drawCastle(p,x,y,{color=PALETTE.blue,time=0,progress=1,reducedMotion=false}={}){
 if(p.sprite?.('castle',x,y)){p.line([x+.5,y,0],[x+.5,y,1.1],'#9b7848',2);p.polygon([[x+.5,y,1.1],[x+.8,y,1.05],[x+.8,y,.83],[x+.5,y,.88]],color);if(progress<1)p.label(x,y,-.2,Math.round(progress*100)+'%');return;}
 // Build stages are purely visual, driven by confirmed construction progress.
 p.box(x-.46,y-.46,0,.92,.92,.1,'#b5ac8e');if(progress<.2)return;
 p.box(x-.3,y-.3,.1,.6,.6,.47,PALETTE.stone);p.pyramid(x,y,.57,.39,.33,color);
 if(progress>.5){for(let [dx,dy]of [[-.34,-.34],[.24,-.34],[-.34,.24],[.24,.24]]){p.box(x+dx,y+dy,.1,.22,.22,.73,PALETTE.stone);p.pyramid(x+dx+.11,y+dy+.11,.83,.17,.34,color);p.box(x+dx+.06,y+dy+.221,.6,.06,.012,.12,'#566568')}
 for(let dy of [-.34,.35])p.box(x-.2,y+dy,.1,.44,.09,.34,'#dfd0ac');for(let dx of [-.34,.35])p.box(x+dx,y-.2,.1,.09,.44,.34,'#dfd0ac');for(let i=0;i<4;i++)p.box(x-.2+i*.13,y+.35,.44,.07,.09,.09,PALETTE.stone);
 p.box(x-.09,y+.355,.1,.18,.03,.25,'#615444');p.box(x-.065,y+.39,.1,.13,.012,.2,'#9d7546');
 for(let row=0;row<3;row++)for(let k=0;k<4;k++){let xx=x-.2+k*.12;p.line([xx,y+.446,.17+row*.09],[xx+.085,y+.446,.17+row*.09],'#bcaf91',1)}
 for(let dx of [-.3,.3]){p.line([x+dx,y+.46,.16],[x+dx,y+.46,.3],'#80663f',2);p.ellipse(x+dx,y+.46,.31,.035,.05,'#f3b94c')}
 p.box(x-.14,y+.44,.01,.28,.18,.07,'#d3c5a4')}
 if(progress>.8){p.line([x,y,1],[x,y,1.7],'#ad8850',2);let wave=reducedMotion?0:Math.sin(time/550)*.035;p.polygon([[x,y,1.66],[x+.36,y+wave,1.58],[x+.36,y+wave,1.33],[x,y,1.41]],color);p.line([x+.15,y+.005,1.52],[x+.15,y+.005,1.42],'#f4e2b2',2)}
}
export function drawFarm(p,x,y,time=0){p.box(x-.4,y-.38,0,.8,.76,.03,'#967245');for(let a=0;a<5;a++)for(let b=0;b<5;b++){let dx=x-.32+a*.15,dy=y-.3+b*.14;p.line([dx,dy,.04],[dx+.015*Math.sin(time/1200+a),dy,.24],'#dcc267',2)}}
export function drawUnit(p,x,y,{type='shieldbearer',color=PALETTE.blue,time=0,state='idle',progress=0,direction=1,reducedMotion=false,hp=1,selected=false}={}){
 const t=reducedMotion?0:time/130,walk=state==='walk'?Math.sin(t)*.09:0,attack=state==='attack'&&!reducedMotion?Math.sin(clamp(progress)*Math.PI)*.2:0;
 if(state==='defend')p.ellipse(x,y,.015,.36,.18,'#7ad4e340');
 if(selected)p.polygon([[x-.45,y-.45,.02],[x+.45,y-.45,.02],[x+.45,y+.45,.02],[x-.45,y+.45,.02]],'#efc35435','#ffe19b');
 if(p.sprite?.(type==='archer'||type==='ranger'?'archer':'guard',x,y,{time,state,progress,reducedMotion})){for(let i=0;i<5;i++)p.ellipse(x-.17+i*.085,y,1.12,.028,.025,i<Math.ceil(clamp(hp)*5)?color:'#d4d2bf');return;}
 p.ellipse(x+.06,y+.08,.02,.24,.09,'#1d38483b');if(state==='defeat'){p.box(x-.22,y-.08,.02,.4,.15,.12,color);return}
 if(state==='hit'&&!reducedMotion)x-=Math.sin(clamp(progress)*Math.PI)*.08;
 const z=reducedMotion?0:state==='walk'?Math.abs(Math.sin(t))*.025:Math.sin(time/900)*.006;x+=attack*direction;
 p.box(x-.13,y-.07+walk,.02,.09,.15,.2,'#515c63');p.box(x+.035,y-.07-walk,.02,.09,.15,.2,'#515c63');
 p.polygon([[x-.14,y-.12,.4+z],[x+.14,y-.12,.4+z],[x+.17,y-.19,.13+z],[x-.17,y-.19,.13+z]],tone(color,.65));p.box(x-.13,y-.09,.2+z,.26,.18,.23,color);p.box(x-.135,y-.095,.23+z,.27,.19,.035,'#bfa16b');p.box(x-.15,y-.11,.39+z,.3,.22,.06,'#aab9ba');
 p.box(x-.085,y-.075,.45+z,.17,.15,.13,'#d5b78d');p.box(x-.11,y-.1,.55+z,.22,.2,.07,'#d0dadd');p.pyramid(x,y,.62+z,.11,.09,'#dbe1db');p.box(x-.08,y+.078,.52+z,.16,.01,.025,'#334853');
 if(type==='archer'||type==='ranger'){p.line([x-.2,y,.25+z],[x-.27-attack,y,.6+z],'#86633f',2);p.line([x-.27-attack,y,.6+z],[x-.36-attack,y,.43+z],'#b9975f',3);p.line([x-.36-attack,y,.43+z],[x-.2,y,.25+z],'#b9975f',3);p.line([x-.27-attack,y,.6+z],[x-.2,y,.25+z],'#e7d6a9',1);p.box(x+.14,y-.04,.26+z,.06,.12,.13,color)}else{p.box(x+.12,y-.02,.21+z,.06,.13,.24,'#e7d9b2');p.box(x+.181,y-.01,.24+z,.01,.11,.18,color);p.line([x-.2,y,.08],[x-.2+attack*1.8,y,.79],'#8c704c',2);p.pyramid(x-.2+attack*1.8,y,.79,.035,.13,'#d6dfe0')}
 if(state==='hit')p.ellipse(x,y,.39,.1,.09,'#fff0b766');
 let hpColor=hp<.3?'#cb7159':color;for(let i=0;i<5;i++)p.ellipse(x-.17+i*.085,y,.89+z,.028,.025,i<Math.ceil(clamp(hp)*5)?hpColor:'#d4d2bf');
}
export function drawProjectile(p,from,to,progress,{reducedMotion=false}={}){let t=clamp(progress),z=.55+(reducedMotion?0:Math.sin(t*Math.PI)*.7),x=from.x+(to.x-from.x)*t,y=from.y+(to.y-from.y)*t;p.line([x-(to.x-from.x)*.05,y-(to.y-from.y)*.05,z],[x,y,z],'#715139',2);p.pyramid(x,y,z,.025,.055,'#f8e6ae')}
export function drawImpact(p,x,y,progress,{reducedMotion=false}={}){let t=clamp(progress);if(reducedMotion){p.ellipse(x,y,.3,.08,.08,'#fff0ac');return}for(let i=0;i<6;i++){let a=i*Math.PI/3,r=t*.4;p.line([x+Math.cos(a)*r,y+Math.sin(a)*r,.35],[x+Math.cos(a)*(r+.07),y+Math.sin(a)*(r+.07),.4],'#f7d985',2)}}
