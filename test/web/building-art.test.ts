import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { BUILDING_IDS, buildingArtUrl, cityBuildingSprites } from '../../web/src/building-art.ts';
test('all factions have both building states', () => {
  for (const faction of ['union','forest','mountain','tide','ash','ruins'])
    for (const id of BUILDING_IDS) for (const state of ['ready','construction'])
      assert.ok(existsSync(new URL('../../web/' + buildingArtUrl(faction,id,state), import.meta.url)));
});
test('only active construction appears; completion keeps the slot', () => {
  const queue = [{kind:'building' as const,unitType:'farm',progress:1,paid:true,orderId:'a'}, {kind:'building' as const,unitType:'mine',progress:0,paid:true,orderId:'b'}];
  const before = cityBuildingSprites({buildings:[],queue});
  assert.deepEqual(before,[{id:'farm',slot:0,state:'construction'}]);
  assert.deepEqual(cityBuildingSprites({buildings:['farm'],queue:[]}),[{id:'farm',slot:0,state:'ready'}]);
  assert.deepEqual(cityBuildingSprites({buildings:['walls'],queue:[]}).map(x=>x.id),['walls']);
});
