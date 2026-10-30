# Контракт для графики (Three.js / React)

Документ для разработчика графики. Правила, сеть и состояние уже реализованы; графика — отдельный слой, который **только показывает** данные сервера.

## Что запрещено в графическом слое

- Считать урон, стоимость, результат захвата, доступность хода. Для этого есть сервер и `client.previewMoves / previewAttack`.
- Менять состояние по окончании анимации. Ход уже сохранён до того, как клиент получил события.
- Показывать то, чего нет в `view` / событиях. Скрытые отряды клиент не получает вообще.

## Точка входа

```ts
import { OskolkiClient, buildTimeline, TimelinePlayer } from '../src/client-sdk/index.ts';

const client = new OskolkiClient('');           // тот же домен
await client.loginTelegram(Telegram.WebApp.initData);
const st = await client.open(matchId);          // StateResponse
await client.loadChunks([[0, 0], [1, 0]]);      // местность по чанкам 16×16
client.tile(x, y);                              // { terrain, features, visible } | null
client.on('state', s => ...);                   // любое изменение (приказы, готовность)
client.on('turnResolved', ({ events, before, after }) => ...); // новый ход
```

Пример полного использования — отладочный клиент `web/src/main.ts` (вид сверху). Его функции `frame`, `drawUnit`, `tileToScreen`, `screenToTile`, `displayUnits` — то, что заменяется изометрической сценой.

## Данные

- Сетка квадратная, координаты `x` вправо, `y` вниз, целые. Город и отряд занимают одну логическую клетку (`x,y` города — точка захвата). Модель города может визуально перекрывать соседние клетки.
- `terrain`: 0 глубокая вода, 1 мелководье, 2 равнина, 3 лес, 4 холмы, 5 горы, **255 — неизвестно** (не исследовано).
- `features` (битовая маска): 1 дорога, 2 мост, 4 руины, 8 святилище, 16 древесина, 32 железо, 64 кристаллы, 128 укрепление (форт).
- `visible=false` при известной клетке — туман («исследована, сейчас не видна»).
- `view.units` — видимые сейчас отряды; `view.staleUnits` — последние известные положения (рисовать полупрозрачно, с меткой хода `seenTurn`).
- `view.cities[].visibleNow=false` — сведения устарели.
- Статусы отряда (`statuses[].id`): `fortified` → значок укрепления.
- `view.players[].color` — цвет игрока.
- `state.orders` — уже отданные приказы: путь (`path`), режим (`move | attack | hold`), цель (`targetUnitId`). Показывать маршрут и цель.

## Этап 2: маршруты, дороги, мини-карта

- `client.longRoute(unitId, path, stopOnThreat)` — путь длиннее хода (только по исследованным клеткам). У своих отрядов `unit.route.path` — оставшиеся шаги: рисовать пунктиром.
- `client.buildRoad(unitId)` — дорога на клетке отряда; появляется в `features` (бит 1) после хода. Дороги соединяются визуально между соседними клетками с битом 1.
- `client.minimap()` — `terrain` (Uint8Array, 255 — неизвестно), `cities`, `units` для мини-карты; обновлять после каждого хода.
- Новые шаги шкалы: `build_start`, `road`, `route_paused`.

## Этап 3: народы, отряды, эффекты, командир

- Отряды (`unit.type`): разведчик, пехотинец, щитоносец, копейщик, лучник, всадник, катапульта, инженер, командир и по два уникальных на народ — полный список с классами в docs/RULES.md и `client.rules()`. Каждому нужен свой силуэт; уникальным — в стиле народа.
- Народ игрока — `view.players[].faction`; архитектура городов и палитра зависят от народа.
- `unit.statuses[].id` и `modifiers[].id` прогноза → `rules.effects[id].icon` (значок) и `.name`. Значки: shield, cover, formation, suppress, zoc, height, ambush, push, supply_low, supply_none, fort, banner, commander, siege, wave, dry.
- `features` бит 128 — укрепление (форт) на клетке.
- Город: `buildings` (свои — все, чужие — только стены), `specialization` (fortress / trade / industrial / science) и `level` меняют внешний вид.
- Слой снабжения: `chunk.supply` (1 — своя зона); включается отдельной кнопкой.
- Повышение ранга: `unit.pendingPerks > 0` — показать знак и предложить выбор (`client.promote`).
- Командир: `view.me.commander` (очки, перезарядки, направления, `pendingChoices`), способности — `client.commanderAbility`, направление — `client.commanderDirection`. «Разведывательный импульс» требует выбора клетки.
- Новые шаги шкалы: `zoc_stop`, `suppressed`, `knockback` (сдвиг цели `from → to`), `fort`, `forest` (клетка меняет рельеф на лес), `commander_ability`, `commander_fallen`, `commander_respawned`, `healed`, `city_grew`, `building`, `supply_warning`.

## Этап 4: дипломатия, цели, метки

- `view.diplomacy` — пары с договорами (`status`: war / truce / alliance, `pending` — объявленный разрыв, `proposal` — только для сторон). Цвет границ/флажков может показывать статус.
- `view.mode` — режим победы, лимит ходов, `objectives` (святилища и стратегические города с `holder`), `scores`, `finished`.
- Метки: `client.markers()`, `addMarker(x, y, label, shared)`, `deleteMarker(id)` — флажки с текстом на клетках.
- Новые шаги шкалы: `diplomacy`, `objective`, `influence`, `match_finished` (финальный экран).

## Этап 5: флот, обелиски, события

- Новые отряды: Налётчик, Метатель огня (Пепельные орды), Рунный мастер, Пробуждённый страж (Хранители руин), Транспорт и Боевой корабль (класс `naval`, только на воде). Народы `ash` и `ruins` — своя палитра и архитектура.
- Груз: свой отряд на борту — `unit.carriedBy` (координаты = транспорт); **не рисовать отдельной моделью** на карте, показывать в панели транспорта. У транспорта `unit.cargo` — число отрядов на борту (видно и противнику).
- Погрузка/высадка: `previewMoves` возвращает клетки с флагами `embark` (клетка транспорта) и `disembark` (соседняя суша для отряда на борту). Приказы — `client.embark(unitId, pathДоТранспортаВключительно)` и `client.disembark(unitId, tile)`.
- `view.structures` — обелиски (`owner`, `linked`: свой подключён к сети или нет; у чужих `null`). Поле резонанса — радиус `rules.obelisks.fieldRadius` вокруг своего связанного обелиска (подсветка по желанию).
- `view.worldEvents` — активные мировые события (`name`, `description`, `endTurn`): баннер/значок в интерфейсе.
- `view.lootedRuins` — индексы клеток (`y*width+x`) разграбленных руин: руины на них показывать «пустыми».
- Действия: `client.scorch(unitId)` (Пепельные орды), `client.obelisk(unitId)` (Хранители руин).
- Новые значки эффектов: momentum, horn, fire, obelisk, broken, ship, anchor.
- Новые шаги шкалы: `embark`, `disembark` (переход отряда на/с транспорта), `scorch` (клетка выгорает: лес → равнина, дорога исчезает), `obelisk`, `structure_destroyed`, `ruins_looted`, `world_event` (баннер), `momentum`, `plunder`.

## Предпросмотр (для подсветки)

- `client.previewMoves(unitId)` → клетки, куда можно дойти в этот ход, со стоимостью.
- `client.previewAttack(unitId, targetId, path)` → урон, возможная контратака, модификаторы, причина отказа, **предупреждение об одновременных приказах** (показывать всегда).
- Путь для приказа строится `findPath` из `src/engine/path.ts` по загруженным клеткам (см. `localMap()` в отладочном клиенте).

## Воспроизведение хода

```ts
const tl = buildTimeline(events, myPlayerId, { reducedMotion });
const player = new TimelinePlayer(tl);   // setSpeed(1|2), skip()
// каждый кадр:
const { active, finished } = player.frame(performance.now());
```

Шаг шкалы (`PlaybackStep`): `kind`, `start`, `duration` (мс при ×1), исходное событие `event`, `focus` (куда навести камеру), `important`, `damage` (для `impact`).

| kind | событие | анимация |
|---|---|---|
| `fortify` | `fortify` | поднять щит / значок |
| `move` | `move {from,to}` | шаг с поворотом в сторону движения; все шаги одного такта идут параллельно |
| `blocked` | `move_blocked` | остановка, значок «препятствие» |
| `attack` / `counter` | `attack {from,to,kind}` | ближний — короткий выпад в пределах клетки; дальний — снаряд от оружия до цели |
| `impact` | то же | реакция цели и число урона ровно в момент попадания |
| `destroy` | `unit_destroyed` | эффект гибели, затем удаление модели |
| `contest` / `capture` / `contest_cleared` | события городов | флаг оспаривания / смена знамени |
| `recruit` | `unit_recruited` | появление у города |
| `rank_up` | `xp {rankUp}` | знак ранга |
| `research` | `research_completed` | уведомление |

Обязательно: ×1/×2, «Пропустить», режим уменьшенного движения (`prefers-reduced-motion`), восстановление после сворачивания (`lastPlayedTurn / markPlayed` — если ход уже показан, сразу рисовать `after`).

Отряды на шкале берутся из `before.view.units`, новые — из `after.view.units`. После окончания показа рисуется `client.state` (= `after`).

## Нагрузка

Карта до 256×256 (позже 512×512): грузить только видимые чанки (`loadChunks`), чанки кешируются в пределах хода. На дальнем масштабе — значки вместо моделей, без мелкой растительности. Instancing для деревьев и типовых объектов.
