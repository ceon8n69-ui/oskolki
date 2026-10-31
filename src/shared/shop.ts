// Каталог лавки: только внешний вид. Цены — в Telegram Stars (XTR).
export interface ShopItem {
  id: string;
  kind: 'color' | 'badge';
  name: string;
  description: string;
  /** Цена в Stars; 0 — не продаётся, выдаётся наградой. */
  stars: number;
  color?: string;
  /** Как получить наградной предмет. */
  reward?: string;
}

export const SHOP: ShopItem[] = [
  { id: 'color_gold', kind: 'color', name: 'Золотое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#d4a017' },
  { id: 'color_crimson', kind: 'color', name: 'Багряное знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#b3122e' },
  { id: 'color_emerald', kind: 'color', name: 'Изумрудное знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#0f8a5f' },
  { id: 'color_violet', kind: 'color', name: 'Аметистовое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#6d3fc0' },
  { id: 'color_obsidian', kind: 'color', name: 'Обсидиановое знамя', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 25, color: '#2b2b33' },
  { id: 'badge_crown', kind: 'badge', name: 'Корона', description: 'Знак короны рядом с именем в рейтинге', stars: 50 },
  // Награды: не продаются.
  { id: 'color_ally', kind: 'color', name: 'Знамя побратимов', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 0, color: '#1f8fb8', reward: 'Друг по вашей ссылке доиграл первую партию (награда обоим)' },
  { id: 'badge_herald', kind: 'badge', name: 'Глашатай', description: 'Знак рога рядом с именем в рейтинге', stars: 0, reward: 'Три друга по вашей ссылке доиграли первую партию' },
  { id: 'color_veteran', kind: 'color', name: 'Серебряное знамя ветерана', description: 'Цвет ваших отрядов и городов в новых партиях', stars: 0, color: '#8e9aa8', reward: '5 рейтинговых партий за сезон' },
  { id: 'badge_laurel', kind: 'badge', name: 'Лавровый венок', description: 'Знак венка рядом с именем в рейтинге', stars: 0, reward: 'Десятка лучших по итогам сезона' },
  { id: 'badge_champion', kind: 'badge', name: 'Кубок чемпиона', description: 'Знак кубка рядом с именем в рейтинге', stars: 0, reward: 'Первое место по итогам сезона' },
];

/** Знаки в рейтинге в порядке показа. */
export const BADGES = ['badge_champion', 'badge_laurel', 'badge_crown', 'badge_herald'] as const;

export const shopItem = (id: string) => SHOP.find(i => i.id === id);
