// Генерирует docs/RULES.md из config/balance.json, чтобы справочник правил не расходился с конфигурацией.
import { writeFileSync } from 'node:fs';
import { BALANCE as b } from '../src/shared/balance.ts';

const L: string[] = [];
const row = (...c: (string | number)[]) => L.push(`| ${c.join(' | ')} |`);
L.push(`# Справочник правил (${b.version})`, '', 'Файл сгенерирован `node scripts/gen-rules-doc.ts` из `config/balance.json`. Не править вручную.', '');
L.push('## Народы', '');
for (const [id, f] of Object.entries(b.factions)) {
  L.push(`### ${f.name} (\`${id}\`)`, '', `- Механика: ${f.mechanic}`, `- Противодействие: ${f.weakness}`, `- Командир: ${f.commander.name}; способности: ${f.commander.abilities.map(a => b.commander.abilities[a].name).join(', ')}`);
  const units = Object.entries(b.units).filter(([, u]) => u.faction === id).map(([, u]) => u.name);
  const techs = Object.entries(b.techs).filter(([, t]) => t.faction === id).map(([, t]) => t.name);
  L.push(`- Уникальные отряды: ${units.join(', ')}`, `- Ветка наследия: ${techs.join(', ')}`, '');
}
L.push('## Отряды', '');
row('Отряд', 'Класс', 'Народ', 'HP', 'Атака', 'Защита', 'Ход', 'Дальность', 'Обзор', 'Иниц.', 'Цена', 'Содержание', 'Требует', 'Способности');
row(...Array(14).fill('---'));
for (const [, u] of Object.entries(b.units)) {
  const cost = Object.entries(u.cost).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  row(u.name, b.classes[u.class], u.faction ? b.factions[u.faction].name : '—', u.hp, u.attack, u.defense, u.move, u.range, u.vision, u.initiative, cost, u.upkeep, u.requires ? b.techs[u.requires].name : '—', u.abilities.map(a => b.effects[a]?.name ?? a).join(', '));
}
L.push('', '## Эффекты и модификаторы', '');
row('Эффект', 'Источник', 'Длительность', 'Накопление', 'Снятие', 'Значок', 'Действие');
row(...Array(7).fill('---'));
for (const [, e] of Object.entries(b.effects)) row(e.name, e.source, e.duration, e.stacking ? 'да' : 'нет', e.removal, e.icon, e.description);
L.push('', '## Технологии', '');
row('Технология', 'Ветка', 'Народ', 'Стоимость', 'Требует', 'Исключает', 'Открывает', 'Эффект');
row(...Array(8).fill('---'));
for (const [, t] of Object.entries(b.techs)) {
  row(t.name, t.branch, t.faction ? b.factions[t.faction].name : 'все', t.cost, t.requires.map(r => b.techs[r].name).join(', ') || '—', (t.excludes ?? []).map(r => b.techs[r].name).join(', ') || '—',
    [...t.unlocksUnits.map(u => b.units[u].name), ...t.unlocksBuildings.map(x => b.buildings[x].name)].join(', ') || '—', Object.keys(t.modifiers).length ? '`' + JSON.stringify(t.modifiers) + '`' : '—');
}
L.push('', '## Постройки', '');
row('Постройка', 'Цена', 'Требует', 'Эффект');
row('---', '---', '---', '---');
for (const [, x] of Object.entries(b.buildings)) row(x.name, Object.entries(x.cost).map(([k, v]) => `${v} ${k}`).join(', '), x.requires ? b.techs[x.requires].name : '—', '`' + JSON.stringify(x.effects) + '`');
L.push('', '## Специализации городов (с уровня ' + b.cities.specializeMinLevel + ')', '');
for (const [, s] of Object.entries(b.specializations)) L.push(`- **${s.name}**: \`${JSON.stringify(s.effects)}\``);
L.push('', '## Улучшения при повышении ранга', '');
for (const [, p] of Object.entries(b.perks)) L.push(`- **${p.name}** — ${p.description}`);
L.push('', `Ранги: пороги опыта ${b.ranks.thresholds.join(' / ')}, бонус здоровья ${b.ranks.hpBonus.join(' / ')}, множитель атаки ${b.ranks.attackMultiplier.join(' / ')}.`);
L.push('', '## Командир', '', `Очки: старт ${b.commander.startPoints}, +${b.commander.pointsPerTurn}/ход, максимум ${b.commander.maxPoints}. После гибели — возвращение через ${b.commander.respawnTurns} хода за ${b.commander.respawnGold} золота; направления развития сохраняются.`, '');
for (const [, a] of Object.entries(b.commander.abilities)) L.push(`- **${a.name}** (${a.cost} очк., перезарядка ${a.cooldown}) — ${a.description}`);
for (const [, d] of Object.entries(b.commander.directions)) L.push(`- Направление **${d.name}** — ${d.description}`);
L.push('', '## Снабжение', '', `Радиус от города по уровню: ${b.supply.cityRadius.slice(1).join(', ')}. Вне зоны: через ${b.supply.lowSupplyAfter} ход — «под угрозой» (нет лечения), через ${b.supply.unsuppliedAfter} — «без снабжения» (атака и защита ×${b.combat.unsuppliedMultiplier}). Отряды не гибнут от отсутствия снабжения.`);
L.push(`Лечение не действовавших отрядов в зоне: +${b.healing.inSupply}, в своём городе ещё +${b.healing.inOwnCity}.`, '');
writeFileSync(new URL('../docs/RULES.md', import.meta.url), L.join('\n'));
console.log('docs/RULES.md обновлён');
