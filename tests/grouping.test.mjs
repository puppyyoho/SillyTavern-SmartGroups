import assert from 'node:assert/strict';
import { familyKey, inferGroups, normalizeSeriesBase } from '../grouping.js';

const names = [
    '照见A版',
    '照见B版',
    '照见C版',
    '[The Little Library]小图书馆-1.11',
    '[The Little Library]小图书馆-1.2',
    '[The Little Library]小图书馆-1.3',
    '完全无关的独立预设',
];

const groups = inferGroups(names, { minGroupSize: 2 });
const byKey = new Map(groups.map(group => [familyKey(group.label), group]));

assert.equal(normalizeSeriesBase('照见A版').label, '照见');
assert.equal(normalizeSeriesBase('[The Little Library]小图书馆-1.11').label, '[The Little Library]小图书馆');
assert.deepEqual(new Set(byKey.get(familyKey('照见'))?.names), new Set(['照见A版', '照见B版', '照见C版']));
assert.deepEqual(
    new Set(byKey.get(familyKey('[The Little Library]小图书馆'))?.names),
    new Set([
        '[The Little Library]小图书馆-1.11',
        '[The Little Library]小图书馆-1.2',
        '[The Little Library]小图书馆-1.3',
    ]),
);
assert.equal(groups.flatMap(group => group.names).includes('完全无关的独立预设'), false);

const manualLike = inferGroups(['Dark Glass 1.0', 'Dark Glass 1.1', 'Light Paper'], { minGroupSize: 2 });
assert.equal(manualLike.length, 1);
assert.equal(familyKey(manualLike[0].label), familyKey('Dark Glass'));

const worldBooks = inferGroups([
    '【灰烬之桥】世界书-v1.0',
    '【灰烬之桥】世界书-v2.0',
    '星海纪事-角色设定-v1.0',
    '星海纪事-角色设定-v2.0',
    '独立百科',
], { minGroupSize: 2 });
const worldBookKeys = new Set(worldBooks.map(group => familyKey(group.label)));
assert.equal(worldBookKeys.has(familyKey('【灰烬之桥】世界书')), true);
assert.equal(worldBookKeys.has(familyKey('星海纪事-角色设定')), true);
assert.equal(worldBooks.flatMap(group => group.names).includes('独立百科'), false);

console.log(`grouping.test.mjs: ${groups.length + manualLike.length + worldBooks.length} inferred groups verified`);

const largePresetList = Array.from(
    { length: 716 },
    (_, index) => `【系列${Math.floor(index / 8)}】预设-v${index}.${index % 8}`,
);
const benchmarkStart = performance.now();
inferGroups(largePresetList, { minGroupSize: 2 });
const benchmarkDuration = performance.now() - benchmarkStart;
assert.ok(benchmarkDuration < 2000, `716-item grouping took ${Math.round(benchmarkDuration)}ms`);
