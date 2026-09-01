import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const sourceVersion = indexSource.match(/const VERSION = '([^']+)'/)?.[1];
assert.equal(sourceVersion, manifest.version, 'index and manifest versions must match');
assert.equal(sourceVersion, packageJson.version, 'index and package versions must match');

const openManagerSource = indexSource.match(/function openManager[\s\S]*?\n}\n\nfunction closeManager/)?.[0] || '';
assert.ok(openManagerSource, 'openManager source was not found');
assert.doesNotMatch(openManagerSource, /scrollTop\s*=\s*0/, 'opening the manager must not override current-item positioning');

assert.match(indexSource, /mask\.addEventListener\('click'/, 'blank-area closing must wait for a completed click');
assert.doesNotMatch(indexSource, /mask\.addEventListener\('pointerdown'/, 'blank-area closing must not intercept a touch scroll');
assert.match(indexSource, /removeEventListener\('pointerdown', handleDocumentPointerDown, true\)/, 'global UI listeners must be cleaned up');

assert.match(styleSource, /#srg-manager-mask \.pgm-body \{[\s\S]*?touch-action:\s*pan-y;/, 'manager body must own vertical touch scrolling');
assert.match(styleSource, /#srg-manager-mask \.srg-pin \{\s*display:\s*none;/, 'hidden pin column must stay hidden');
assert.match(styleSource, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(126px, 180px\);/, 'desktop rows must not reserve a ghost pin column');
assert.match(styleSource, /#srg-manager-mask \.pgm-move \{[^\n]*text-align:\s*center !important;/, 'move selectors must keep centered labels');
assert.doesNotMatch(indexSource, /<b><i class="fa-solid fa-layer-group"><\/i>/, 'settings title must not restore the removed icon');

console.log('ui-regressions.test.mjs: mobile manager regressions verified');

