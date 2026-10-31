# Terrain art pass v2

Visual-only changes based on the current Canvas isometric renderer. No map, resource, combat, picking or networking rules changed.

- `web/art/terrain-props-v2.png`: transparent 1536×1024 atlas, 3×2 cells of 512 px.
- Row 1: rock peak, rock ridge, iron deposit.
- Row 2: crystal deposit, timber, ruins.
- Visible terrain features retain their server coordinates and fog opacity. Looted ruins are faded.
- Mountains use deterministic coordinate-based silhouette and scale variation.
- Castle height increases from 1.35 to 1.95 tile widths; city still occupies one logical cell.
- Terrain has sparse clipped surface details and a softer grid.

Generation: built-in Imagegen, transparent output. Prompt: production fantasy strategy atlas, 3 columns × 2 rows, isolated broad slate peak, asymmetrical rocky ridge, silver-veined iron ore, cyan crystals, cut timber, ruined mossy stone arch; orthographic isometric camera, upper-left light, softly faceted style, transparent margins, no labels, no square pedestals. Generated alpha preserved unchanged.

This is an environment pass, not final reference-quality art. Faction architecture, shore transitions, shrine art and frame animations remain separate work.

## Continuation and verification

Rebased onto main at `49f79e3` (rooms UI, tutorial, history and Stars cosmetics preserved).
Resource sprite heights increased after reviewing the mobile fixture: iron 0.54, crystal 0.60 and timber 0.52 tile widths.

`npm run build:web` also builds `/art-preview.html`. This standalone, session-free fixture imports the live sprite painter. It compares castle, units, trees and the six terrain sprites at 18–64 px, with a fog-opacity toggle. It does not reproduce map placement, selection or gameplay.

Verified in headless Chromium at 320, 390, 430 and 1000 CSS px: 10/10 sprites decoded, no page errors or horizontal overflow; zoom 18/48/64; fog toggle; `?graphics=0` fallback. Mobile screenshots visually inspected for transparency, cropping and relative scale.

Build, TypeScript, module boundaries and 74 engine/world-generation tests pass. Full server suite could not run: PostgreSQL on localhost:5432 is unavailable (ECONNREFUSED). No production deploy or authenticated Telegram game verification performed.
