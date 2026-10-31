/** Asset-scale fixture. Uses the live sprite painter; no session or game mutations. */
import { drawLiveArtIso, hasLiveArt, loadLiveArt } from './live-art.ts';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const ctx = canvas.getContext('2d')!;
const zoom = document.querySelector<HTMLInputElement>('#zoom')!;
const fog = document.querySelector<HTMLInputElement>('#fog')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const objects = ['castle', 'commander', 'infantry', 'tree', 'rockPeak', 'rockRidge', 'iron', 'crystal', 'timber', 'ruins'];
const names = ['Замок', 'Командир', 'Пехота', 'Лес', 'Гора', 'Скалы', 'Железо', 'Кристаллы', 'Древесина', 'Руины'];
function draw() {
  const width = canvas.clientWidth, height = 720;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * dpr; canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#192820'; ctx.fillRect(0, 0, width, height);
  const size = Number(zoom.value), columns = width < 550 ? 2 : 5;
  const rowHeight = height / Math.ceil(objects.length / columns);
  objects.forEach((kind, i) => {
    const x = (i % columns + 0.5) * width / columns;
    const y = Math.floor(i / columns) * rowHeight + rowHeight - 34;
    ctx.fillStyle = '#84ac60'; ctx.beginPath();
    ctx.moveTo(x, y - size / 4); ctx.lineTo(x + size / 2, y);
    ctx.lineTo(x, y + size / 4); ctx.lineTo(x - size / 2, y); ctx.closePath(); ctx.fill();
    const alpha = fog.checked ? 0.55 : 1;
    if (!drawLiveArtIso(ctx, kind, x, y + size * 0.16, size, alpha)) {
      ctx.fillStyle = '#f6cf79'; ctx.fillRect(x - 4, y - 8, 8, 8);
    }
    ctx.fillStyle = '#e5e8da'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(names[i], x, y + 29);
  });
  status.value = `${size} px · ${objects.filter(hasLiveArt).length}/${objects.length} спрайтов`;
}
await loadLiveArt();
zoom.addEventListener('input', draw); fog.addEventListener('change', draw);
window.addEventListener('resize', draw); draw();
document.body.dataset.ready = 'true';
