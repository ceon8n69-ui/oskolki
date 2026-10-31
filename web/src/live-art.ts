/** First live art pass. Existing canvas owns camera, picking and event playback. */
const rects = {
  castle: [0, 0, 445, 610], tree: [445, 0, 390, 610], mountain: [835, 0, 419, 610],
  shieldbearer: [0, 620, 440, 570], archer: [445, 620, 365, 570], bridge: [815, 650, 439, 510],
} as const;
type Sprite = keyof typeof rects;
const starters = { infantry: [0,0,724,724], commander: [724,0,724,724], scout: [1448,0,724,724] } as const;
const terrainRects = {
  rockPeak: [0, 0, 512, 512], rockRidge: [512, 0, 512, 512],
  iron: [1024, 0, 512, 512], crystal: [0, 512, 512, 512],
  timber: [512, 512, 512, 512], ruins: [1024, 512, 512, 512],
} as const;
let terrainImage: HTMLImageElement | null = null;
let starterImage: HTMLImageElement | null = null;
let image: HTMLImageElement | null = null;
export async function loadLiveArt(): Promise<void> {
  if (new URLSearchParams(location.search).get('graphics') === '0') return;
  await Promise.all([
    ['terrain-props-v2.png', (asset: HTMLImageElement) => { terrainImage = asset; }],
    ['kingdom-atlas.png', (asset: HTMLImageElement) => { image = asset; }],
    ['starter-units-v1.png', (asset: HTMLImageElement) => { starterImage = asset; }],
  ].map(async ([file, accept]) => {
    try { const asset = new Image(); asset.src = new URL('./art/' + file, location.href).href; await asset.decode(); (accept as (a: HTMLImageElement) => void)(asset); }
    catch (error) { console.warn('Art unavailable:', file, error); }
  }));
}
export function drawLiveArt(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, size: number, opacity = 1): boolean {
  const isStarter = Object.hasOwn(starters, kind);
  const source = isStarter ? starterImage : image;
  if (!source || size < 16 || (!isStarter && !Object.hasOwn(rects, kind))) return false;
  const [sx, sy, sw, sh] = isStarter ? starters[kind as keyof typeof starters] : rects[kind as Sprite];
  // Keep the first live pass inside its logical tile so adjacent units remain selectable.
  const h = size * (kind === 'castle' ? 1.65 : .94), w = h * sw / sh;
  if (kind === 'castle') y -= size * .48;
  ctx.save(); ctx.globalAlpha *= opacity;
  ctx.drawImage(source, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
  ctx.restore(); return true;
}

/** Высота спрайта в долях ширины ромба клетки (2.5D): нижний край ставится на точку земли. */
const ISO_HEIGHT: Record<string, number> = { castle: 1.95, rockPeak: 1.08, rockRidge: 0.78, iron: 0.54, crystal: 0.6, timber: 0.52, ruins: 0.78, tree: 0.8, mountain: 1.05, bridge: 0.6, shieldbearer: 0.95, archer: 0.95, infantry: 0.95, commander: 1.05, scout: 0.92 };
export function hasLiveArt(kind: string): boolean {
  if (Object.hasOwn(terrainRects, kind)) return !!terrainImage;
  const isStarter = Object.hasOwn(starters, kind);
  return !!(isStarter ? starterImage : image) && (isStarter || Object.hasOwn(rects, kind));
}
/** 2.5D: спрайт стоит на земле в точке (x, groundY); size — ширина ромба клетки. */
export function drawLiveArtIso(ctx: CanvasRenderingContext2D, kind: string, x: number, groundY: number, size: number, opacity = 1, scale = 1): boolean {
  const isTerrain = Object.hasOwn(terrainRects, kind);
  const isStarter = Object.hasOwn(starters, kind);
  const source = isTerrain ? terrainImage : isStarter ? starterImage : image;
  if (!source || size < 14 || (!isTerrain && !isStarter && !Object.hasOwn(rects, kind))) return false;
  const [sx, sy, sw, sh] = isTerrain ? terrainRects[kind as keyof typeof terrainRects] : isStarter ? starters[kind as keyof typeof starters] : rects[kind as Sprite];
  const h = size * (ISO_HEIGHT[kind] ?? 0.9) * scale, w = h * sw / sh;
  ctx.save(); ctx.globalAlpha *= opacity;
  ctx.drawImage(source, sx, sy, sw, sh, x - w / 2, groundY - h * 0.97, w, h);
  ctx.restore(); return true;
}
