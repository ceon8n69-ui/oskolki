/** First live art pass. Existing canvas owns camera, picking and event playback. */
const rects = {
  castle: [0, 0, 445, 610], tree: [445, 0, 390, 610], mountain: [835, 0, 419, 610],
  shieldbearer: [0, 620, 440, 570], archer: [445, 620, 365, 570], bridge: [815, 650, 439, 510],
} as const;
type Sprite = keyof typeof rects;
let image: HTMLImageElement | null = null;
export async function loadLiveArt(): Promise<void> {
  if (new URLSearchParams(location.search).get('graphics') === '0') return;
  try { const asset = new Image(); asset.src = new URL('./art/kingdom-atlas.png', location.href).href; await asset.decode(); image = asset; }
  catch (error) { console.warn('Art unavailable; using tactical markers', error); }
}
export function drawLiveArt(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, size: number, opacity = 1): boolean {
  if (!image || size < 22 || !(kind in rects)) return false;
  const [sx, sy, sw, sh] = rects[kind as Sprite];
  // Keep the first live pass inside its logical tile so adjacent units remain selectable.
  const h = size * .94, w = h * sw / sh;
  ctx.save(); ctx.globalAlpha *= opacity;
  ctx.drawImage(image, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
  ctx.restore(); return true;
}
