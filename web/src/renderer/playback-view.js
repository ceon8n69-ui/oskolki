/** Rebuild a presentation snapshot from immutable before + elapsed server events. */
export function playbackView(before,after,timeline,time,{reducedMotion=false}={}){
 const state=structuredClone(before),v=state.view,effects=[];
 const find=id=>v.units.find(u=>u.id===id);
 for(const s of timeline.steps){if(time<s.start)continue;const e=s.event,p=s.duration?Math.min(1,(time-s.start)/s.duration):1,active=p<1;
  if(['move','knockback','embark','disembark'].includes(s.kind)){
   let u=find(e.unitId);if(!u)continue;
   if(s.kind==='disembark')delete u.carriedBy;
   const q=reducedMotion?(p===1?1:0):p;u.x=e.from.x+(e.to.x-e.from.x)*q;u.y=e.from.y+(e.to.y-e.from.y)*q;
   if(s.kind==='embark'&&p===1)u.carriedBy=e.transportId;
  }
  if(s.kind==='impact'){
   // This is the server's damage, never a locally calculated combat result.
   const u=find(e.targetId);if(u)u.hp=Math.max(0,u.hp-(s.damage??e.damage));
   if(active)effects.push({kind:'damage',x:e.to.x,y:e.to.y,text:String(s.damage??e.damage),progress:p});
  }
  if((s.kind==='attack'||s.kind==='counter')&&active&&!reducedMotion){
   const u=find(e.attackerId);if(u){const dx=e.to.x-e.from.x,dy=e.to.y-e.from.y,len=Math.hypot(dx,dy)||1;u.x+=dx/len*Math.sin(p*Math.PI)*.12;u.y+=dy/len*Math.sin(p*Math.PI)*.12;}
  }
  if(s.kind==='destroy'){
   if(p===1)v.units=v.units.filter(u=>u.id!==e.unitId);
   else{const u=find(e.unitId);if(u)u.renderOpacity=reducedMotion?1:1-p;}
  }
  if(s.kind==='recruit'||s.kind==='commander_respawned'){
   if(!find(e.unitId)){const u=after.view.units.find(u=>u.id===e.unitId);if(u)v.units.push({...structuredClone(u),x:e.at.x,y:e.at.y});}
  }
  if(s.kind==='capture'){const c=v.cities.find(c=>c.id===e.cityId);if(c){c.owner=e.to;c.contestedBy=null;}}
  if(s.kind==='contest'){const c=v.cities.find(c=>c.id===e.cityId);if(c)c.contestedBy=e.by;}
  if(s.kind==='contest_cleared'){const c=v.cities.find(c=>c.id===e.cityId);if(c)c.contestedBy=null;}
  if(s.kind==='healed'){const u=find(e.unitId);if(u)u.hp=Math.min(u.maxHp,u.hp+e.amount);}
 }
 return{state,effects};
}

/** One coordinator owns presentation time; SDK remains the state authority. */
export class PlaybackCoordinator {
 constructor(client,sdk,{present,settle,onError=console.error,reducedMotion=false,raf=requestAnimationFrame,caf=cancelAnimationFrame,now=()=>performance.now()}={}){
  Object.assign(this,{client,sdk,present,settle,onError,reducedMotion,raf,caf,now});this.current=client.state;this.speed=1;this.disposed=false;
  this.off=[client.on('state',s=>{if(this.disposed||this.run)return;if(!this.current||s.view.turn<=this.current.view.turn){this.current=s;this.safeSettle(s);}}),client.on('turnResolved',r=>this.begin(r))];
 }
 safeSettle(s){Promise.resolve().then(()=>{if(!this.disposed)return this.settle(s);}).catch(this.onError);}
 begin({turn,before,after,events}){
  if(this.disposed)return;this.cancel();const match=after.view.matchId;
  if(!before||this.sdk.lastPlayedTurn(match)>=turn){this.current=after;this.safeSettle(after);return;}
  const timeline=this.sdk.buildTimeline(events,after.view.me.id,{reducedMotion:this.reducedMotion});
  // Some SDK tail effects exceed timeline.total; retain them in presentation time only.
  const full={...timeline,total:Math.max(timeline.total,...timeline.steps.map(s=>s.start+s.duration))};
  const player=new this.sdk.TimelinePlayer(full);player.setSpeed(this.speed);this.run={turn,before,after,timeline:full,player};this.tick(this.now());
 }
 tick(now){if(this.disposed||!this.run)return;const r=this.run;try{const f=r.player.frame(now);if(r.player.done){this.finish();return;}const view=playbackView(r.before,r.after,r.timeline,f.time,{reducedMotion:this.reducedMotion});this.present(view.state,view.effects);this.handle=this.raf(t=>this.tick(t));}catch(e){this.onError(e);this.finish();}}
 setSpeed(speed){if(speed!==1&&speed!==2)throw new Error('speed must be 1 or 2');if(this.run)this.run.player.frame(this.now());this.speed=speed;this.run?.player.setSpeed(speed);}
 skip(){if(this.run){this.run.player.skip();this.finish();}}
 finish(){const r=this.run;if(!r)return;this.cancel();this.sdk.markPlayed(r.after.view.matchId,r.turn);this.current=this.client.state??r.after;this.safeSettle(this.current);}
 /** Call when returning from background / reconnect, to display the current snapshot. */
 resume(){this.skip();if(this.client.state){this.current=this.client.state;this.safeSettle(this.current);}}
 cancel(){if(this.handle!==undefined)this.caf(this.handle);this.handle=undefined;this.run=null;}
 dispose(){this.disposed=true;this.cancel();for(const f of this.off)f();}
}
