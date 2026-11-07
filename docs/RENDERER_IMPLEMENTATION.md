# Renderer contract: first implementation increment

Source of requirements: docs/RENDERER_CONTRACT.md on main, read 2026-10-30. No changes to server, balance, SDK, entry point or dependency lockfile.

## Modules

- `web/src/renderer/scene-model.js`: pure StateResponse -> presentation data. Unknown/unloaded terrain hides feature flags; carried units omitted; stale units faded with seenTurn; visible records supersede stale duplicates. Player faction/color, city metadata, structure ownership and long routes preserved. No combat calculations.
- `web/src/renderer/three-layer.js`: injectable Three.js layer; orthographic camera, tile picking, viewport chunk list, instanced terrain, atlas billboards, fog, route lines, far-distance labels. `sync(client)` uses the existing authenticated SDK. `dispose()` releases GPU resources and observers.
- `test/renderer/scene-model.test.mjs`: four checks for fog privacy, transport visibility, source immutability, routes and clipped chunk requests. Run explicitly with `node --test test/renderer/scene-model.test.mjs` (existing test glob covers .ts only).

## Integration sketch

Application must supply its chosen Three.js dependency and bundle/serve the atlas URL. Three.js and React are not currently installed by this patch. Host requires non-zero height.

```js
import * as THREE from 'three';
import { KingdomLayer } from './renderer/three-layer.js';
const layer = new KingdomLayer(THREE, host, {
  onTile: tile => selectTile(tile), // route to existing selection/preview UI
  atlasUrl: '/art/kingdom-atlas.png', // configure static asset copying
});
layer.setCamera(startX, startY, 12);
await layer.sync(client);
const unsubscribe = client.on('state', () => {
  void layer.sync(client).catch(showError);
});
// React effect cleanup:
// unsubscribe(); layer.dispose();
```

This sketch is for settled-state rendering only. Do NOT use it unchanged while playing a timeline: SDK emits state(after) before turnResolved. Integration must hold before during playback and only reveal after when finished/skipped. The debug renderer remains the live entry point until that coordinator is implemented.

## Explicit limits

Not full contract compliance yet. Three layer has syntax validation, but no WebGL/browser runtime validation in this increment. Existing canvas art showcase is separate. No React wrapper, pan/pinch event handling, or timeline coordinator yet. Trees use individual sprites (terrain uses InstancedMesh); tree batching and GPU budgets remain. Atlas only provides castle, trees, mountains, bridge, shieldbearer and archer; other units use honest text markers rather than wrong silhouettes. Faction art, building variations, roads connected to neighbors, supply overlay, minimap, command panels, effect icons and animation frames are still outstanding. Faction/color data is available but shared blue artwork is not recolored. Routes currently render as supplied and are not segmented to viewport. No 256×256 performance certification. No live deployment.

## Playback increment

Added `playback-view.js` and `bind-playback.js`. `PlaybackCoordinator` takes the existing SDK exports as an argument, uses its buildTimeline/TimelinePlayer and lastPlayedTurn/markPlayed. It suppresses the early state(after) refresh, projects moves/knockback/embark/disembark, server impact damage, destruction, recruitment, healing and city ownership into cloned before data. Skip and resume settle to the current SDK snapshot. Playback total is extended to include tail effects whose end exceeds the SDK total. No game-state writes or combat formulas.

`KingdomLayer.present()` repositions existing unit sprites between topology/HP changes. It holds the previously loaded terrain snapshot during playback, so newly explored terrain is not revealed early. Initial atlas loading and layer.sync must finish before starting playback. Unsupported event kinds remain visually unchanged until settle; this includes terrain changes, commander effects and world-event notifications. Attack currently has a short lunge for every type; ranged projectile classification/animation is not yet connected to rules. These are implementation limits, not finished art.

Mount after opening match and after creating layer:

```js
import * as sdk from '../../src/client-sdk/index.ts'; // adjust relative to caller
import { bindPlayback } from './renderer/bind-playback.js';
const unbind = await bindPlayback(client, sdk, layer, playbackControls, { onError: showError });
// Remove the simple client.on('state', layer.sync) listener from the earlier sketch.
// On unmount: unbind(); layer.dispose();
```

The binding provides ×1, ×2, Skip, reduced-motion preference changes and resume-on-visibility. New turns received during playback replace that playback. Background reconnect with only a state event requires resume() or visibility return; the coordinator intentionally does not reveal an advanced turn before turnResolved.

Validation: eight Node tests (pure view projection and coordinator ordering), plus syntax checks. Three.js runtime integration and real device performance remain unverified. This patch still does not replace web/src/main.ts or install Three.js/React.
