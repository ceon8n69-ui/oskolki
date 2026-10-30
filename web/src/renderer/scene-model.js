/** Presentation projection only. Never accepts engine GameState, only server StateResponse. */
export function visibleChunks(bounds,map){
 const s=map.chunkSize, list=[];
 for(let cy=Math.max(0,Math.floor(bounds.minY/s));cy<=Math.min(Math.ceil(map.height/s)-1,Math.floor(bounds.maxY/s));cy++)
 for(let cx=Math.max(0,Math.floor(bounds.minX/s));cx<=Math.min(Math.ceil(map.width/s)-1,Math.floor(bounds.maxX/s));cx++)list.push([cx,cy]);
 return list;
}
export function sceneModel(state,tile,bounds){
 const v=state.view,players=new Map(v.players.map(p=>[p.id,p]));
 const inside=o=>o.x>=bounds.minX&&o.x<=bounds.maxX&&o.y>=bounds.minY&&o.y<=bounds.maxY;
 const style=owner=>({color:players.get(owner)?.color??'#a6a091',faction:players.get(owner)?.faction??'neutral'});
 const tiles=[];
 for(let y=Math.max(0,Math.floor(bounds.minY));y<=Math.min(v.map.height-1,Math.ceil(bounds.maxY));y++)
 for(let x=Math.max(0,Math.floor(bounds.minX));x<=Math.min(v.map.width-1,Math.ceil(bounds.maxX));x++){
  const t=tile(x,y);if(!t||t.terrain===255){tiles.push({x,y,terrain:255,features:0,visible:false});continue;}
  tiles.push({x,y,terrain:t.terrain,features:t.features,visible:t.visible,looted:(v.lootedRuins??[]).includes(y*v.map.width+x)});
 }
 const liveIds=new Set(v.units.map(u=>u.id));
 const units=[...v.units.filter(u=>!u.carriedBy).map(u=>({...u,...style(u.owner),opacity:u.renderOpacity??1})),
 ...v.staleUnits.filter(u=>!liveIds.has(u.id)).map(u=>({...u,...style(u.owner),opacity:.35}))].filter(inside);
 const cities=v.cities.filter(inside).map(c=>({...c,...style(c.owner),opacity:c.visibleNow?1:.45}));
 const routes=[];
 for(const u of v.units)if(u.owner===v.me.id&&!u.carriedBy&&u.route?.path.length)routes.push({unitId:u.id,points:[{x:u.x,y:u.y},...u.route.path.map(p=>({...p}))],dashed:true});
 for(const rec of state.orders){const o=rec.order;if(o.kind!=='unit')continue;const u=v.units.find(u=>u.id===o.unitId&&!u.carriedBy);if(!u)continue;
 routes.push({unitId:u.id,mode:o.mode,targetUnitId:o.targetUnitId,points:[{x:u.x,y:u.y},...o.path.map(p=>({...p}))],dashed:false});}
 return{turn:v.turn,tiles,units,cities,routes,structures:(v.structures??[]).filter(inside).map(s=>({...s,...style(s.owner)})),worldEvents:structuredClone(v.worldEvents??[])};
}
