// Hand-checked source rectangles; no runtime background removal or filters.
export async function loadAtlas(url=new URL('./kingdom-atlas.png',import.meta.url)){
 const image=new Image();image.src=url;await image.decode();
 const rects={castle:[0,0,445,610],tree:[445,0,390,610],mountain:[835,0,419,610],guard:[0,620,440,570],archer:[445,620,365,570],bridge:[815,650,439,510]};
 return function draw(ctx,kind,point,size,{time=0,state='idle',progress=0,reducedMotion=false}={}){
  const r=rects[kind];if(!r)return false;
  const scale={castle:2.55,tree:1.35,mountain:1.8,guard:.83,archer:.83,bridge:1.65}[kind];
  const w=size*scale,h=w*r[3]/r[2];
  const moving=!reducedMotion&&state==='walk',hit=!reducedMotion&&state==='hit';
  const bob=moving?Math.abs(Math.sin(time/130))*size*.035:0;
  const lunge=!reducedMotion&&state==='attack'?Math.sin(Math.min(1,Math.max(0,progress))*Math.PI)*size*.12:0;
  ctx.save();ctx.translate(point.x-lunge,point.y-bob);if(kind==='bridge')ctx.scale(-1,1);if(hit)ctx.translate(Math.sin(progress*Math.PI)*size*.05,0);
  if(state==='defeat'){ctx.rotate(-1.15);ctx.globalAlpha=.5;}
  ctx.drawImage(image,...r,-w/2,-h*.92,w,h);ctx.restore();return true;
 };
}
