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

/** Спрайт постройки народа (готовая или стройка); null — ещё не загружен или файла нет. */
export function buildingImage(faction: string, id: string, state: 'ready' | 'construction'): HTMLImageElement | null {
  if (new URLSearchParams(location.search).get('graphics') === '0') return null;
  const url = buildingArtUrl(faction, id, state);
  if (failed.has(url)) return null;
  let image = images.get(url);
  if (!image) {
    image = new Image(); image.onerror = () => failed.add(url); image.src = url; images.set(url, image);
  }
  return image.complete && image.naturalWidth ? image : null;
}
