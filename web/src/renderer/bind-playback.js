import {PlaybackCoordinator} from './playback-view.js';
/** Mount once after client.open(). Return cleanup for a React useEffect. */
export async function bindPlayback(client,sdk,layer,controls,{onError=console.error}={}){
 await layer.sync(client);
 const media=matchMedia('(prefers-reduced-motion: reduce)');
 const c=new PlaybackCoordinator(client,sdk,{reducedMotion:media.matches,present:(s,e)=>layer.present(s,e),settle:()=>layer.sync(client),onError});
 const buttons=[];
 for(const [text,action]of [['×1',()=>c.setSpeed(1)],['×2',()=>c.setSpeed(2)],['Пропустить',()=>c.skip()]]){const b=document.createElement('button');b.type='button';b.textContent=text;b.style.cssText='min-height:44px;padding:10px 16px;border-radius:10px;border:1px solid #697b8b;background:#20364e;color:#f5eddd';b.addEventListener('click',action);controls.append(b);buttons.push(b);}
 const visibility=()=>{if(!document.hidden)c.resume();};document.addEventListener('visibilitychange',visibility);
 const motion=()=>{c.reducedMotion=media.matches;c.skip();};media.addEventListener('change',motion);
 return()=>{document.removeEventListener('visibilitychange',visibility);media.removeEventListener('change',motion);c.dispose();buttons.forEach(b=>b.remove());};
}
