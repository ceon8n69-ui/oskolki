import type { ViewCity } from '../../src/shared/protocol.ts';
export const BUILDING_IDS = ['farm', 'lumber_mill', 'mine', 'market', 'barracks', 'forge', 'academy', 'walls', 'supply_depot', 'port'] as const;
const factions = new Set(['union', 'forest', 'mountain', 'tide', 'ash', 'ruins']);
export function cityBuildingSprites(city: Pick<ViewCity, 'buildings' | 'queue'>) {
  // Only the active production item is being built. Later queued items have no footprint yet.
  const head = city.queue[0];
  return BUILDING_IDS.flatMap<{ id: string; slot: number; state: 'ready' | 'construction' }>((id, slot) => city.buildings.includes(id)
    ? [{ id, slot, state: 'ready' as const }]
    : head?.kind === 'building' && head.unitType === id
      ? [{ id, slot, state: 'construction' as const }]
      : []);
}
export function buildingArtUrl(faction: string, id: string, state: string): string {
  return `./art/buildings/${factions.has(faction) ? faction : 'union'}/${id}-${state}.webp`;
}
const images = new Map<string, HTMLImageElement>();
const failed = new Set<string>();
export function drawCityBuildings(ctx: CanvasRenderingContext2D, city: ViewCity, faction: string, x: number, y: number, size: number, front: boolean) {
  if (size < 22 || new URLSearchParams(location.search).get('graphics') === '0') return;
  for (const item of cityBuildingSprites(city)) {
    // Fixed slots prevent buildings moving when another construction finishes.
    const angle = (item.slot / 10) * Math.PI * 2;
    const dy = Math.sin(angle) * size * .42;
    if ((dy >= 0) !== front) continue;
    const url = buildingArtUrl(faction, item.id, item.state);
    if (failed.has(url)) continue;
    let image = images.get(url);
    if (!image) {
      image = new Image(); image.onerror = () => failed.add(url); image.src = url; images.set(url, image);
    }
    if (!image.complete || !image.naturalWidth) continue;
    const h = size * .57, w = h * image.naturalWidth / image.naturalHeight;
    ctx.save(); ctx.globalAlpha *= city.visibleNow ? 1 : .5;
    ctx.drawImage(image, x + Math.cos(angle) * size * .77 - w / 2, y + dy - h, w, h);
    ctx.restore();
  }
}
