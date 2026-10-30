/** First live art pass. Existing canvas owns camera, picking and event playback. */
const rects = {
  castle: [0, 0, 445, 610], tree: [445, 0, 390, 610], mountain: [835, 0, 419, 610],
  shieldbearer: [0, 620, 440, 570], archer: [445, 620, 365, 570], bridge: [815, 650, 439, 510],
} as const;
type Sprite = keyof typeof rects;
const starters = { infantry: [0,0,724,724], commander: [724,0,724,724], scout: [1448,0,724,724] } as const;
let starterImage: HTMLImageElement | null = null;
let image: HTMLImageElement | null = null;
export async function loadLiveArt(): Promise<void> {
  if (new URLSearchParams(location.search).get('graphics') === '0') return;
  await Promise.all([
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
