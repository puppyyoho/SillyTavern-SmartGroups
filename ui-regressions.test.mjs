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
assert.match(styleSource, /#srg-manager-mask \.srg-manager \{[\s\S]*?font-size:\s*13px;/, 'manager density must not inherit an oversized theme font');
assert.match(styleSource, /#srg-manager-mask \.pgm-preset \{[\s\S]*?min-height:\s*34px;/, 'manager rows must keep compact height');
assert.doesNotMatch(indexSource, /<b><i class="fa-solid fa-layer-group"><\/i>/, 'settings title must not restore the removed icon');
assert.match(indexSource, /function scrubMenuEntryIcon\(item\)/, 'menu icon cleanup must survive host-side reinjection');
assert.match(styleSource, /#srg-menu-entry > :not\(\.srg-menu-label\)/, 'menu entry must hide host-injected children');
assert.match(indexSource, /classList\.add\('srg-popover-open'\)/, 'opening the quick picker must lock background scrolling');
assert.match(indexSource, /classList\.remove\('srg-popover-open'\)/, 'closing the quick picker must unlock background scrolling');
assert.match(styleSource, /#srg-popover \.pgm-quick-list \{[^\n]*overscroll-behavior-y:\s*contain;/, 'quick picker scrolling must not leak to the page');
assert.match(indexSource, /popover\.addEventListener\('touchmove',[\s\S]*?passive:\s*false/, 'touch boundary handling must be able to cancel scroll chaining');
assert.match(indexSource, /popover\.addEventListener\('touchstart',[\s\S]*?event\.stopPropagation\(\)/, 'touching the picker must not trigger SillyTavern drawer autoclose');
assert.match(indexSource, /touchmove'[\s\S]*?event\.stopPropagation\(\)/, 'quick picker touch movement must not reach host swipe handlers');
assert.match(indexSource, /horizontalGesture[\s\S]*?event\.preventDefault\(\)/, 'horizontal gestures inside the picker must be blocked');
assert.match(indexSource, /\['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'wheel'\]/, 'pointer and synthetic mouse gestures must stay inside the quick picker');
assert.doesNotMatch(indexSource, /\['pointerdown'[^]]*'click'\]/, 'picker clicks must still bubble to its delegated selection handlers');
assert.match(indexSource, /function handleRootMutations\(mutations\)[\s\S]*?mutations\.some\(mutationNeedsScan\)/, 'the document observer must filter unrelated host mutations');
assert.doesNotMatch(indexSource, /new MutationObserver\(scheduleScan\)/, 'every page mutation must not trigger a full adapter scan');
assert.match(indexSource, /if \(this\.trigger\.title !== title\) this\.trigger\.title = title;/, 'unchanged trigger titles must not be rewritten');
assert.match(indexSource, /if \(labelNode\.textContent !== label\) labelNode\.textContent = label;/, 'unchanged trigger labels must not be rewritten');
assert.doesNotMatch(indexSource, /this\.trigger\.innerHTML\s*=/, 'trigger refreshes must not recreate their DOM on every scan');
assert.match(indexSource, /function bindSearchInput\(input, onCommit\)/, 'search fields must share IME-safe input handling');
assert.match(indexSource, /addEventListener\('compositionstart'/, 'search must preserve Chinese IME composition');
assert.match(indexSource, /addEventListener\('compositionend'/, 'search must commit completed Chinese IME text');
assert.match(indexSource, /if \(composing \|\| event\.isComposing\) return;/, 'search must not rerender during composition');
assert.match(indexSource, /setSelectionRange\(start, end\)/, 'search must restore its caret after rerendering');
assert.doesNotMatch(indexSource, /querySelector\('\[data-srg-(?:pop|manager)-search\]'\)\?\.focus\(\)/, 'search must not reset the caret to the start');
assert.match(indexSource, /let hostModalDepth = 0;/, 'host popup interactions must be tracked');
assert.match(indexSource, /if \(hostModalDepth > 0 \|\| event\.target\?\.closest\?\.\('\.popup, dialog\[open\]'\)\) return;/, 'host popups must not trigger manager outside-click closing');
assert.match(indexSource, /const liveState = getResourceState\(adapter\.stateId\);/, 'rename must resolve the latest group state after awaiting input');
assert.match(indexSource, /toast\('分组名称已更新', 'success'\);/, 'successful rename must give explicit feedback');
assert.match(indexSource, /function isTauriRuntime\(\)/, 'Tauri runtime detection must be explicit');
assert.match(indexSource, /getTauriTopInset\(viewportWidth\)/, 'Tauri titlebar inset must be applied to manager positioning');
assert.match(indexSource, /mask\.style\.setProperty\('height', `\$\{Math\.max\(1, height - topInset\)\}px`, 'important'\)/, 'manager height must account for the Tauri top inset');
assert.match(indexSource, /mask\.style\.setProperty\('top', `\$\{topInset\}px`, 'important'\)/, 'Tauri top inset must survive responsive !important rules');
assert.doesNotMatch(indexSource, /viewportWidth <= 700\) return 0/, 'Tauri safe area must also apply to narrow CSS viewports');
assert.match(styleSource, /--srg-tauri-titlebar-height:\s*36px;/, 'Tauri titlebar guard must have a safe default');
assert.match(indexSource, /height: calc\(100dvh - var\(--srg-tauri-top-inset, 0px\)\) !important;/, 'mobile manager height must reserve the Tauri safe area');
assert.match(indexSource, /max-height: calc\(100dvh - 14px - var\(--srg-tauri-top-inset, 0px\)\) !important;/, 'mobile manager content must fit below the Tauri safe area');

console.log('ui-regressions.test.mjs: mobile manager regressions verified');
