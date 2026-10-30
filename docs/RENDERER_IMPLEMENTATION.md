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
