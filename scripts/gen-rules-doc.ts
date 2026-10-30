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
L.push('## Флот и перевозка', '',
  `Корабли (класс «${b.classes.naval}») ходят только по воде (1 очко за клетку), в города не входят и их не захватывают. Нанимаются в городе с портом (порт — только в прибрежном городе) и появляются на соседней воде. Корабли не страдают от нехватки снабжения, но лечатся только в зоне снабжения.`,
  `Погрузка: сухопутный отряд последним шагом пути входит на клетку своего транспорта (стоимость шага ${b.naval.embarkCost}; только приказ «движение»; транспорт в этом такте должен стоять). Вместимость транспорта — ${b.naval.transportCapacity}. Груз движется с транспортом, не атакует, не может быть атакован, противнику виден только счётчик на транспорте. Гибель транспорта топит груз.`,
  'Высадка: груз получает приказ на один шаг на соседнюю сушу; высадка занимает весь ход (можно атаковать после неё, если отряд стреляет после движения). Обычные правила конфликтов клеток действуют.', '');
L.push('## Выжженная земля, обелиски, руины', '',
  `- Выжигание (Пепельные орды): отряд сжигает клетку под собой — исчезают дорога, укрепление и древесина, лес становится равниной; вражеский город в ${b.scorch.radius} клетках теряет ${b.scorch.foodLoss} еды; +${b.scorch.gold} золота. В городе выжигать нельзя.`,
  `- Обелиск (Хранители руин): строитель ставит обелиск за ${b.obelisks.goldCost} золота вне города, не ближе ${b.obelisks.minSpacing} клеток к другому своему. Связан, если от своего города по цепочке обелисков каждое звено не дальше ${b.obelisks.linkRange} клеток. Связанный обелиск: обзор ${b.obelisks.visionRadius}, снабжение ${b.obelisks.supplyRadius}, поле резонанса радиусом ${b.obelisks.fieldRadius}; на руинах — +${b.obelisks.ruinsKnowledge} знания в ход. Разрушается, если на нём закончил ход противник.`,
  `- Руины: первый отряд, закончивший ход на неразграбленных руинах, приносит награду (${b.ruinsLoot.rewards.map(r => `${r.amount} ${r.kind}`).join(' / ')} — выбор детерминирован по карте и клетке). Хранители руин получают вдвое больше, «Археология» — ещё +50%.`, '');
L.push('## Мировые события', '',
  `С хода ${b.worldEvents.firstTurn} каждые ${b.worldEvents.interval} ходов с вероятностью ${Math.round(b.worldEvents.chance * 100)}% начинается событие на ${b.worldEvents.duration} хода. Выбор детерминирован по seed карты и номеру хода; событие объявляется всем игрокам в конце хода и действует со следующего.`, '');
row('Событие', 'Вес', 'Действие');
row('---', '---', '---');
for (const [, e] of Object.entries(b.worldEvents.list)) row(e.name, e.weight, e.description);
L.push('', '## Карты', '');
row('Карта', 'Размер', 'Игроков', 'Нейтральных городов', 'Мин. расстояние столиц', 'Форма');
row(...Array(6).fill('---'));
for (const [id, m] of Object.entries(b.map.presets)) row(id, `${m.width}×${m.height}`, m.players, m.neutralCities, m.minCapitalDistance, m.shape === 'islands' ? 'архипелаг (остров на игрока, переправа флотом)' : 'материки');
L.push('');
L.push('## Дипломатия', '', `По умолчанию — ${b.diplomacy.statuses[b.diplomacy.default].name.toLowerCase()}. Разрыв договора вступает в силу через ${b.diplomacy.breakWarningTurns} хода; предложения действуют ${b.diplomacy.proposalTtl} хода.`, '');
for (const [, d] of Object.entries(b.diplomacy.statuses)) L.push(`- **${d.name}** — ${d.description}`);
L.push('', '## Условия победы', '');
for (const [, v] of Object.entries(b.victoryModes)) L.push(`- **${v.name}** — ${v.description}`);
L.push('', `Цели влияния: святилище ${b.influence.shrinePoints} очк./ход, стратегический город ${b.influence.cityPoints} очк./ход; не менее ${b.influence.minObjectives} целей, ${b.influence.objectivesPerPlayer} на игрока.`, '');
L.push('## Пресеты партий', '');
row('Пресет', 'Карта', 'Время хода', 'Победа', 'Лимит ходов', 'Союзы', 'Бот замещает после');
row(...Array(7).fill('---'));
for (const [id, t] of Object.entries(b.turnPresets)) row(id, t.mapPreset, t.planningSeconds ? `${t.planningSeconds} с` : 'по готовности', b.victoryModes[t.victory].name, t.turnLimit ?? '—', t.alliances ? 'да' : 'нет', t.botTakeoverAfter ? `${t.botTakeoverAfter} пропусков` : '—');
L.push('');
writeFileSync(new URL('../docs/RULES.md', import.meta.url), L.join('\n'));
console.log('docs/RULES.md обновлён');
