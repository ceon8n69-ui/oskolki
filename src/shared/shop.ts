// Каталог лавки: только внешний вид. Цены — в Telegram Stars (XTR).
export interface ShopItem {
  id: string;
  kind: 'color' | 'badge';
  name: string;
  description: string;
  stars: number;
  color?: string;
}

export const SHOP: ShopItem[] = [
  { id: 'color_gold', kind: 'color', name: 'Золотое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#d4a017' },
  { id: 'color_crimson', kind: 'color', name: 'Багряное знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#b3122e' },
  { id: 'color_emerald', kind: 'color', name: 'Изумрудное знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#0f8a5f' },
  { id: 'color_violet', kind: 'color', name: 'Аметистовое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#6d3fc0' },
  { id: 'color_obsidian', kind: 'color', name: 'Обсидиановое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#2b2b33' },
  { id: 'badge_crown', kind: 'badge', name: 'Корона', description: 'Знак короны рядом с именем в рейтинге', stars: 50 },
];

export const shopItem = (id: string) => SHOP.find(i => i.id === id);
