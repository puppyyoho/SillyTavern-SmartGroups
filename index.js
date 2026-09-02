import { familyKey, inferGroups, normalizeName } from './grouping.js';

const MODULE_NAME = 'smart_resource_groups';
const DISPLAY_NAME = '嘎嘎资源分组';
const VERSION = '2.1.27';
const LEGACY_STORAGE_KEY = 'preset-group-manager:state';
const ROOT_ID = 'srg-root';
const POPOVER_ID = 'srg-popover';
const MANAGER_ID = 'srg-manager-mask';
const MENU_ID = 'srg-menu-entry';
const SETTINGS_ID = 'srg-settings';
const RUNTIME_STYLE_ID = 'srg-runtime-mobile-fixes';
const RESOURCE_SELECT_SELECTOR = 'select[data-preset-manager-for], select#themes, select#world_info, select#world_editor_select';
const SCAN_DISCOVERY_SELECTOR = `${RESOURCE_SELECT_SELECTOR}, #extensionsMenu, #extensions_settings2, #${MENU_ID}, #${SETTINGS_ID}`;

const SOURCE_LABELS = {
    openai: 'Chat Completion 预设',
    textgenerationwebui: 'Text Completion 预设',
    kobold: 'KoboldAI 预设',
    koboldhorde: 'KoboldAI / Horde 预设',
    novel: 'NovelAI 预设',
    context: 'Context 模板',
    instruct: 'Instruct 模板',
    sysprompt: 'System Prompt 模板',
    reasoning: 'Reasoning 模板',
    themes: '美化 / UI 主题',
    worldInfoGlobal: '世界书（全局启用）',
    worldInfoEditor: '世界书（编辑）',
};

const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: 2,
    enabled: true,
    enhancePresets: true,
    enhanceThemes: true,
    enhanceWorldInfo: true,
    autoGroupOnDiscovery: true,
    minGroupSize: 2,
    compactRows: false,
    legacyMigrated: false,
    resources: {},
});

let context = null;
let settings = null;
let initialized = false;
let rootObserver = null;
let scanTimer = 0;
let saveTimer = 0;
let activeAdapterId = '';
let managerSearch = '';
let popoverSearch = '';
let activePopoverAdapterId = '';
let locateCurrentOnNextPopoverRender = false;
let locateCurrentOnNextManagerRender = false;
let managerAnchorRect = null;
const adapters = new Map();
const eventCleanup = [];

function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function uid(prefix = 'g') {
    try {
        if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    } catch {
        // Ignore and use the deterministic fallback shape below.
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
    try {
        const toaster = globalThis.toastr;
        if (toaster?.[type]) {
            toaster[type](message, DISPLAY_NAME, { timeOut: 2600, positionClass: 'toast-top-center' });
            return;
        }
    } catch {
        // Console fallback below.
    }
    console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function getContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function mergeDefaults(defaults, current) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return clone(defaults);
    const output = clone(defaults);
    for (const [key, value] of Object.entries(current)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
            output[key] = { ...output[key], ...value };
        } else {
            output[key] = value;
        }
    }
    return output;
}

function loadSettings() {
    const extensionSettings = context.extensionSettings || context.extension_settings;
    if (!extensionSettings || typeof extensionSettings !== 'object') {
        throw new Error('当前 SillyTavern 未提供 extensionSettings');
    }
    extensionSettings[MODULE_NAME] = mergeDefaults(DEFAULT_SETTINGS, extensionSettings[MODULE_NAME]);
    settings = extensionSettings[MODULE_NAME];
    if (!settings.resources || typeof settings.resources !== 'object' || Array.isArray(settings.resources)) settings.resources = {};
    settings.schemaVersion = 2;
    settings.minGroupSize = Math.max(2, Math.min(12, Number(settings.minGroupSize) || 2));
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = 0;
        try {
            context?.saveSettingsDebounced?.();
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 保存扩展设置失败`, error);
        }
    }, 80);
}

function normalizeResourceState(resource) {
    const output = resource && typeof resource === 'object' ? resource : {};
    if (!Array.isArray(output.groups)) output.groups = [];
    if (!output.assignments || typeof output.assignments !== 'object') output.assignments = {};
    if (!output.manualAssignments || typeof output.manualAssignments !== 'object') output.manualAssignments = {};
    if (!output.collapsed || typeof output.collapsed !== 'object') output.collapsed = {};
    if (!output.managerCollapsed || typeof output.managerCollapsed !== 'object') output.managerCollapsed = {};
    if (typeof output.fingerprint !== 'string') output.fingerprint = '';

    const ids = new Set();
    output.groups = output.groups
        .filter(group => group && typeof group === 'object')
        .map(group => ({
            id: String(group.id || uid()),
            name: normalizeName(group.name) || '未命名分组',
            auto: Boolean(group.auto),
        }))
        .filter(group => {
            if (ids.has(group.id)) return false;
            ids.add(group.id);
            return true;
        });

    for (const [name, groupId] of Object.entries(output.assignments)) {
        if (!ids.has(groupId)) {
            delete output.assignments[name];
            delete output.manualAssignments[name];
        }
    }
    return output;
}

function getResourceState(adapterId) {
    settings.resources[adapterId] = normalizeResourceState(settings.resources[adapterId]);
    return settings.resources[adapterId];
}

function resourceFingerprint(names) {
    return [...names].map(normalizeName).filter(Boolean).sort((a, b) => a.localeCompare(b)).join('\u0001');
}

function getOrCreateGroup(state, label, auto = true) {
    const key = familyKey(label);
    let group = state.groups.find(item => familyKey(item.name) === key);
    if (!group) {
        group = { id: uid('g'), name: normalizeName(label) || '未命名分组', auto };
        state.groups.push(group);
        state.collapsed[group.id] = true;
        state.managerCollapsed[group.id] = true;
    } else if (!auto) {
        group.auto = false;
    }
    return group;
}

function migrateLegacyState() {
    if (settings.legacyMigrated) return 0;
    let legacy = null;
    try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) legacy = JSON.parse(raw);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 旧版分组数据读取失败`, error);
    }

    let migrated = 0;
    if (legacy?.apis && typeof legacy.apis === 'object') {
        for (const [apiIdRaw, oldState] of Object.entries(legacy.apis)) {
            if (!oldState || typeof oldState !== 'object') continue;
            const apiId = apiIdRaw === 'koboldhorde' ? 'kobold' : apiIdRaw;
            const resourceId = `preset:${apiId}`;
            const next = getResourceState(resourceId);
            const idMap = new Map();

            for (const oldGroup of Array.isArray(oldState.groups) ? oldState.groups : []) {
                if (!oldGroup?.name) continue;
                const group = getOrCreateGroup(next, oldGroup.name, false);
                idMap.set(String(oldGroup.id), group.id);
                if (typeof oldState.collapsed?.[oldGroup.id] === 'boolean') {
                    next.collapsed[group.id] = oldState.collapsed[oldGroup.id];
                }
            }

            for (const [name, oldGroupId] of Object.entries(oldState.assignments || {})) {
                const groupId = idMap.get(String(oldGroupId));
                if (!groupId || !normalizeName(name)) continue;
                next.assignments[name] = groupId;
                if (oldState.manualAssignments?.[name]) next.manualAssignments[name] = true;
                migrated++;
            }
            next.fingerprint = '';
        }
    }

    settings.legacyMigrated = true;
    scheduleSave();
    return migrated;
}

function sourceIdForSelect(select) {
    if (select.id === 'themes') return 'themes';
    if (select.id === 'world_info') return 'world-info:global';
    if (select.id === 'world_editor_select') return 'world-info:editor';
    const apiIds = String(select.dataset.presetManagerFor || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    if (!apiIds.length) return '';
    const primary = apiIds[0] === 'koboldhorde' ? 'kobold' : apiIds[0];
    return `preset:${primary}`;
}

function stateIdForSelect(select) {
    if (select.id === 'world_info' || select.id === 'world_editor_select') return 'world-info';
    return sourceIdForSelect(select);
}

function sourceLabelForSelect(select) {
    if (select.id === 'themes') return SOURCE_LABELS.themes;
    if (select.id === 'world_info') return SOURCE_LABELS.worldInfoGlobal;
    if (select.id === 'world_editor_select') return SOURCE_LABELS.worldInfoEditor;
    const apiIds = String(select.dataset.presetManagerFor || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const primary = apiIds[0] || 'unknown';
    return SOURCE_LABELS[primary] || `${primary} 预设`;
}

class SelectAdapter {
    constructor(select) {
        this.select = select;
        this.id = sourceIdForSelect(select);
        this.stateId = stateIdForSelect(select);
        this.label = sourceLabelForSelect(select);
        this.managerLabel = this.stateId === 'world-info' ? '世界书' : this.label;
        this.managerPriority = select.id === 'world_editor_select' ? 20 : select.id === 'world_info' ? 10 : 0;
        this.kind = select.id === 'themes' ? 'theme' : this.stateId === 'world-info' ? 'world-info' : 'preset';
        this.multiple = Boolean(select.multiple);
        this.wrapper = null;
        this.trigger = null;
        this.hiddenCompanions = new Set();
        this.lastItemsFingerprint = '';
        this.lastSelectionFingerprint = '';
        this.changeHandler = () => {
            this.updateTrigger();
            if (activePopoverAdapterId === this.id) {
                locateCurrentOnNextPopoverRender = !this.multiple;
                renderPopover();
            }
            if (adapters.get(activeAdapterId)?.stateId === this.stateId && document.getElementById(MANAGER_ID)?.classList.contains('open')) {
                renderManager();
            }
        };
        this.mutationTimer = 0;
        this.observer = new MutationObserver(() => {
            if (this.mutationTimer) clearTimeout(this.mutationTimer);
            this.mutationTimer = window.setTimeout(() => {
                this.mutationTimer = 0;
                this.onItemsChanged();
            }, 140);
        });
        this.select.addEventListener('change', this.changeHandler);
        this.observer.observe(this.select, { childList: true, subtree: true, characterData: true, attributes: true });
        this.refreshMount();
        this.onItemsChanged();
    }

    isEnabled() {
        if (!settings.enabled) return false;
        if (this.kind === 'theme') return settings.enhanceThemes;
        if (this.kind === 'world-info') return settings.enhanceWorldInfo;
        return settings.enhancePresets;
    }

    getItems() {
        const seen = new Set();
        return [...this.select.querySelectorAll('option')]
            .map(option => ({
                key: normalizeName(option.textContent),
                label: normalizeName(option.textContent),
                value: String(option.value ?? ''),
                disabled: option.disabled,
            }))
            .filter(item => {
                if (!item.key || seen.has(item.key) || (this.kind === 'world-info' && !item.value)) return false;
                seen.add(item.key);
                return true;
            });
    }

    getSelectedKeys() {
        return [...(this.select.selectedOptions || [])]
            .filter(option => this.kind !== 'world-info' || String(option.value ?? '') !== '')
            .map(option => normalizeName(option.textContent))
            .filter(Boolean);
    }

    getSelectedKey() {
        return this.getSelectedKeys()[0] || '';
    }

    isItemSelected(key) {
        const normalized = normalizeName(key);
        return this.getSelectedKeys().some(item => item === normalized);
    }

    selectItem(key) {
        const option = [...this.select.querySelectorAll('option')].find(item => normalizeName(item.textContent) === normalizeName(key));
        if (!option || option.disabled) return false;
        if (this.multiple) {
            option.selected = !option.selected;
        } else {
            this.select.value = option.value;
            option.selected = true;
        }
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
        this.updateTrigger();
        return true;
    }

    refreshNativeCompanions() {
        const rendered = this.select.id ? document.getElementById(`select2-${this.select.id}-container`) : null;
        const container = rendered?.closest('.select2-container');
        if (container && container !== this.wrapper) this.hiddenCompanions.add(container);
        for (const element of this.hiddenCompanions) {
            if (element?.isConnected) element.classList.toggle('srg-native-widget-hidden', this.isEnabled());
        }
    }

    refreshMount() {
        if (this.isEnabled()) this.mount();
        else this.unmount();
    }

    mount() {
        if (this.wrapper?.isConnected && this.trigger?.isConnected) {
            this.select.classList.add('srg-native-select-hidden');
            this.refreshNativeCompanions();
            this.updateTrigger();
            return;
        }
        this.wrapper?.remove();
        const wrapper = document.createElement('div');
        wrapper.className = 'srg-select-shell';
        wrapper.dataset.srgSource = this.id;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'srg-select-trigger';
        trigger.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (activePopoverAdapterId === this.id && document.getElementById(POPOVER_ID)?.classList.contains('open')) {
                closePopover();
            } else {
                openPopover(this.id);
            }
        });
        wrapper.appendChild(trigger);
        this.select.insertAdjacentElement('afterend', wrapper);
        this.select.classList.add('srg-native-select-hidden');
        this.wrapper = wrapper;
        this.trigger = trigger;
        this.refreshNativeCompanions();
        this.updateTrigger();
    }

    unmount() {
        this.select.classList.remove('srg-native-select-hidden');
        for (const element of this.hiddenCompanions) element?.classList.remove('srg-native-widget-hidden');
        this.wrapper?.remove();
        this.wrapper = null;
        this.trigger = null;
        if (activePopoverAdapterId === this.id) closePopover();
    }

    updateTrigger() {
        if (!this.trigger) return;
        const selected = this.getSelectedKeys();
        const label = !selected.length
            ? `选择${this.label}`
            : this.multiple && selected.length > 1
                ? `已启用 ${selected.length} 本世界书`
                : selected[0];
        const title = selected.join('、') || label;
        if (this.trigger.title !== title) this.trigger.title = title;

        const labelNode = this.trigger.querySelector(':scope > .srg-select-label');
        const arrowNode = this.trigger.querySelector(':scope > .srg-select-arrow');
        const hasExpectedShape = this.trigger.childElementCount === 2 && labelNode && arrowNode;
        if (!hasExpectedShape) {
            const nextLabel = document.createElement('span');
            nextLabel.className = 'srg-select-label';
            nextLabel.textContent = label;
            const nextArrow = document.createElement('span');
            nextArrow.className = 'srg-select-arrow';
            nextArrow.textContent = '⌄';
            this.trigger.replaceChildren(nextLabel, nextArrow);
            return;
        }
        if (labelNode.textContent !== label) labelNode.textContent = label;
        if (arrowNode.textContent !== '⌄') arrowNode.textContent = '⌄';
    }

    onItemsChanged() {
        if (!this.select.isConnected) return;
        this.refreshMount();
        const items = getManagerItems(this);
        const state = getResourceState(this.stateId);
        const names = new Set(items.map(item => item.key));
        const fingerprint = resourceFingerprint(names);
        const itemListChanged = Boolean(this.lastItemsFingerprint && this.lastItemsFingerprint !== fingerprint);
        const selectionFingerprint = this.getSelectedKeys().join('\u0001');
        const selectionChanged = Boolean(this.lastSelectionFingerprint && this.lastSelectionFingerprint !== selectionFingerprint);
        this.lastItemsFingerprint = fingerprint;
        this.lastSelectionFingerprint = selectionFingerprint;
        let changed = false;
        for (const name of Object.keys(state.assignments)) {
            if (!names.has(name)) {
                delete state.assignments[name];
                delete state.manualAssignments[name];
                changed = true;
            }
        }
        if (settings.autoGroupOnDiscovery && state.fingerprint !== fingerprint) {
            applySmartGrouping(this, { announce: false, items });
        } else if (changed) {
            scheduleSave();
        }
        this.updateTrigger();
        if (activePopoverAdapterId === this.id && itemListChanged) {
            locateCurrentOnNextPopoverRender = true;
            renderPopover();
        }
        if ((itemListChanged || selectionChanged) && adapters.get(activeAdapterId)?.stateId === this.stateId && document.getElementById(MANAGER_ID)?.classList.contains('open')) renderManager();
        updateSettingsStatus();
    }

    destroy() {
        if (this.mutationTimer) clearTimeout(this.mutationTimer);
        this.observer.disconnect();
        this.select.removeEventListener('change', this.changeHandler);
        this.unmount();
    }
}

function applySmartGrouping(adapter, { announce = true, items = null } = {}) {
    const state = getResourceState(adapter.stateId);
    const names = (items || adapter.getItems()).map(item => item.key);
    const unlocked = names.filter(name => !state.manualAssignments[name]);

    for (const name of unlocked) delete state.assignments[name];
    const inferred = inferGroups(unlocked, { minGroupSize: settings.minGroupSize });
    const usedGroupIds = new Set();
    let assigned = 0;

    for (const cluster of inferred) {
        const group = getOrCreateGroup(state, cluster.label, true);
        usedGroupIds.add(group.id);
        for (const name of cluster.names) {
            if (state.manualAssignments[name]) continue;
            state.assignments[name] = group.id;
            assigned++;
        }
    }

    state.groups = state.groups.filter(group => {
        if (!group.auto) return true;
        return names.some(name => state.assignments[name] === group.id) || usedGroupIds.has(group.id);
    });
    const liveIds = new Set(state.groups.map(group => group.id));
    for (const [name, groupId] of Object.entries(state.assignments)) {
        if (!liveIds.has(groupId) || !names.includes(name)) {
            delete state.assignments[name];
            delete state.manualAssignments[name];
        }
    }
    state.fingerprint = resourceFingerprint(names);
    scheduleSave();

    if (announce) toast(`“${adapter.label}”已整理：${inferred.length} 个分组，${assigned} 个条目`, 'success');
    return { groups: inferred.length, assigned };
}

function assignItem(stateId, itemName, groupId, manual = true) {
    const state = getResourceState(stateId);
    if (groupId && !state.groups.some(group => group.id === groupId)) return;
    if (groupId) state.assignments[itemName] = groupId;
    else delete state.assignments[itemName];
    if (manual) state.manualAssignments[itemName] = true;
    else delete state.manualAssignments[itemName];
    state.fingerprint = '';
    scheduleSave();
}

function groupBuckets(adapter, search = '', sourceItems = null) {
    const state = getResourceState(adapter.stateId);
    const query = normalizeName(search).toLocaleLowerCase();
    const items = (sourceItems || adapter.getItems()).filter(item => !query || item.label.toLocaleLowerCase().includes(query));
    const buckets = new Map(state.groups.map(group => [group.id, []]));
    const loose = [];
    for (const item of items) {
        const groupId = state.assignments[item.key];
        if (groupId && buckets.has(groupId)) buckets.get(groupId).push(item);
        else loose.push(item);
    }
    return { state, buckets, loose, searching: Boolean(query) };
}

function ensureRoot() {
    ensureRuntimeStyles();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        document.body.appendChild(root);
    }
    return root;
}

function ensureRuntimeStyles() {
    let style = document.getElementById(RUNTIME_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = RUNTIME_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = `
        #${ROOT_ID} {
            position: fixed !important;
            inset: 0 !important;
            pointer-events: none !important;
        }
        #${ROOT_ID} > * {
            pointer-events: auto !important;
        }
        @media (max-width: 700px) {
            #${MANAGER_ID}.open {
                position: absolute !important;
                height: 100vh !important;
                height: 100dvh !important;
                align-items: flex-start !important;
                justify-content: center !important;
                padding: 7px !important;
            }
            #${MANAGER_ID} .srg-manager {
                width: 100% !important;
                height: auto !important;
                min-height: 0 !important;
                max-height: calc(100dvh - 14px) !important;
                border-radius: 12px !important;
            }
            #${MANAGER_ID} .srg-manager-backdrop {
                inset: 0 !important;
                height: 100% !important;
            }
            #${MANAGER_ID} .srg-manager-group-head {
                align-items: center !important;
                flex-wrap: nowrap !important;
                gap: 5px !important;
            }
            #${MANAGER_ID} .srg-group-heading {
                flex-basis: auto !important;
            }
            #${MANAGER_ID} .srg-group-actions {
                width: auto !important;
                gap: 2px !important;
                padding-left: 0 !important;
            }
            #${MANAGER_ID} .srg-group-actions .srg-icon-button {
                width: 26px !important;
                height: 28px !important;
            }
        }
        #${MANAGER_ID}.scoped.open {
            display: block !important;
            padding: 0 !important;
            background: transparent !important;
            backdrop-filter: none !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-backdrop {
            inset: 0 !important;
            width: 100% !important;
            height: 100% !important;
        }
        #${MANAGER_ID}.scoped .srg-manager {
            position: absolute !important;
            left: var(--srg-manager-x) !important;
            top: var(--srg-manager-y) !important;
            width: var(--srg-manager-width) !important;
            height: var(--srg-manager-height) !important;
            min-height: 0 !important;
            max-height: var(--srg-manager-height) !important;
            border-radius: 12px !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-header,
        #${MANAGER_ID}.scoped .srg-tabs,
        #${MANAGER_ID}.scoped .srg-manager-summary {
            display: none !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-toolbar {
            display: grid !important;
            grid-template-columns: minmax(0, 1fr) repeat(4, 34px) !important;
            gap: 5px !important;
            padding: 9px !important;
            flex-wrap: nowrap !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-toolbar .srg-search {
            min-width: 0 !important;
            width: 100% !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-toolbar .menu_button {
            display: inline-flex !important;
            justify-content: center !important;
            width: 34px !important;
            min-width: 34px !important;
            min-height: 34px !important;
            padding: 0 !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-toolbar .menu_button span {
            display: none !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-list {
            padding: 7px !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-group {
            margin-bottom: 6px !important;
            border-radius: 9px !important;
        }
        @media (max-width: 700px) {
            #${MANAGER_ID}.scoped .srg-manager {
                left: 7px !important;
                top: 7px !important;
                width: calc(100% - 14px) !important;
                height: calc(100% - 14px) !important;
                max-height: calc(100% - 14px) !important;
            }
            #${MANAGER_ID}.scoped .srg-scoped-header {
                display: flex !important;
            }
            #${MANAGER_ID}.scoped .srg-manager-toolbar {
                grid-template-columns: minmax(0, 1fr) repeat(3, 36px) !important;
            }
            #${MANAGER_ID}.scoped .srg-manager-toolbar .srg-scoped-close {
                display: none !important;
            }
        }
        #${MANAGER_ID} .srg-manager {
            background: var(--SmartThemeBlurTintColor, #f7f4ee) !important;
            color: var(--SmartThemeBodyColor, #46516a) !important;
            border-radius: 16px !important;
            box-shadow: 0 18px 60px rgba(0,0,0,.48) !important;
        }
        #${MANAGER_ID} .srg-manager-toolbar {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 6px !important;
            padding: 7px 9px !important;
        }
        #${MANAGER_ID}.scoped .srg-manager-toolbar {
            display: flex !important;
            grid-template-columns: none !important;
            flex-wrap: wrap !important;
            gap: 6px !important;
            padding: 7px 9px !important;
        }
        #${MANAGER_ID} .srg-manager-toolbar .srg-search {
            flex: 1 1 220px !important;
            min-width: 0 !important;
            width: auto !important;
        }
        #${MANAGER_ID} .srg-manager-toolbar .srg-action-button {
            flex: 0 0 auto !important;
            width: auto !important;
            min-width: 0 !important;
            padding: 0 9px !important;
            color: inherit !important;
            background: rgba(127,127,127,.08) !important;
            border-radius: 9px !important;
        }
        #${MANAGER_ID} .srg-manager-group {
            background: rgba(127,127,127,.035) !important;
            border-radius: 12px !important;
        }
        #${MANAGER_ID} .srg-row-button {
            width: 24px !important;
            height: 24px !important;
            padding: 0 !important;
            color: inherit !important;
            background: rgba(127,127,127,.08) !important;
            border: 1px solid var(--SmartThemeBorderColor, rgba(70,80,105,.16)) !important;
            border-radius: 7px !important;
            font: inherit !important;
        }
        #${MANAGER_ID} .srg-pin,
        #${MANAGER_ID} .srg-group-heading > i,
        #${MANAGER_ID} .srg-auto-badge {
            display: none !important;
        }
        @media (max-width: 700px) {
            #${MANAGER_ID} .srg-manager-toolbar .srg-action-button {
                flex: 0 0 auto !important;
            }
            #${MANAGER_ID} .srg-manager {
                border-radius: 12px !important;
                background: var(--SmartThemeBlurTintColor, #f7f4ee) !important;
            }
            #${POPOVER_ID} { background: var(--SmartThemeBlurTintColor, #f7f4ee) !important; }
        }
    `;
}

function ensurePopover() {
    let popover = document.getElementById(POPOVER_ID);
    if (!popover) {
        popover = document.createElement('div');
        popover.id = POPOVER_ID;
        let lastTouchX = null;
        let lastTouchY = null;
        // SillyTavern closes unpinned drawers from an `html` touchstart/mousedown
        // handler whenever the target is outside `.openDrawer`. This popover is
        // intentionally mounted at the document root, so keep its input events
        // from reaching that host handler while preserving native list scrolling.
        popover.addEventListener('touchstart', event => {
            event.stopPropagation();
            lastTouchX = event.touches?.[0]?.clientX ?? null;
            lastTouchY = event.touches?.[0]?.clientY ?? null;
        }, { passive: true });
        popover.addEventListener('touchmove', event => {
            event.stopPropagation();
            const nextTouchX = event.touches?.[0]?.clientX;
            const nextTouchY = event.touches?.[0]?.clientY;
            if (lastTouchX == null || lastTouchY == null || nextTouchX == null || nextTouchY == null) return;
            const list = event.target?.closest?.('.pgm-quick-list');
            if (!list) {
                event.preventDefault();
                lastTouchX = nextTouchX;
                lastTouchY = nextTouchY;
                return;
            }
            const deltaX = nextTouchX - lastTouchX;
            const deltaY = nextTouchY - lastTouchY;
            const atTop = list.scrollTop <= 0;
            const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
            const horizontalGesture = Math.abs(deltaX) > Math.abs(deltaY);
            if (horizontalGesture || (deltaY > 0 && atTop) || (deltaY < 0 && atBottom)) event.preventDefault();
            lastTouchX = nextTouchX;
            lastTouchY = nextTouchY;
        }, { passive: false });
        const resetTouch = event => {
            event.stopPropagation();
            lastTouchX = null;
            lastTouchY = null;
        };
        popover.addEventListener('touchend', resetTouch, { passive: true });
        popover.addEventListener('touchcancel', resetTouch, { passive: true });
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'wheel']) {
            popover.addEventListener(type, event => event.stopPropagation(), { passive: true });
        }
        ensureRoot().appendChild(popover);
    }
    return popover;
}

function positionPopover(adapter) {
    const popover = ensurePopover();
    if (!adapter?.trigger) return;
    const rect = adapter.trigger.getBoundingClientRect();
    const gap = 7;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(560, Math.max(280, viewportWidth - gap * 2));
    popover.style.width = `${width}px`;
    popover.style.left = '-9999px';
    popover.style.top = '-9999px';
    const height = Math.min(popover.offsetHeight || 440, viewportHeight - gap * 2);
    let left = rect.left;
    let top = rect.bottom + 5;
    if (left + width > viewportWidth - gap) left = viewportWidth - width - gap;
    if (left < gap) left = gap;
    if (top + height > viewportHeight - gap) top = Math.max(gap, rect.top - height - 5);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function openPopover(adapterId) {
    const adapter = adapters.get(adapterId);
    if (!adapter?.trigger) return;
    activePopoverAdapterId = adapterId;
    popoverSearch = '';
    locateCurrentOnNextPopoverRender = true;
    document.documentElement.classList.add('srg-popover-open');
    renderPopover();
    ensurePopover().classList.add('open');
    adapter.trigger.classList.add('open');
    requestAnimationFrame(() => positionPopover(adapter));
}

function closePopover() {
    document.getElementById(POPOVER_ID)?.classList.remove('open');
    if (activePopoverAdapterId) adapters.get(activePopoverAdapterId)?.trigger?.classList.remove('open');
    activePopoverAdapterId = '';
    popoverSearch = '';
    locateCurrentOnNextPopoverRender = false;
    document.documentElement.classList.remove('srg-popover-open');
}

function centerItemInScroller(scroller, item) {
    if (!scroller || !item) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const delta = (itemRect.top + itemRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop + delta, max));
}

function focusSearchAt(input, selectionStart, selectionEnd) {
    if (!input) return;
    try {
        input.focus({ preventScroll: true });
    } catch {
        input.focus();
    }
    const length = input.value.length;
    const start = Math.max(0, Math.min(Number.isInteger(selectionStart) ? selectionStart : length, length));
    const end = Math.max(start, Math.min(Number.isInteger(selectionEnd) ? selectionEnd : start, length));
    try {
        input.setSelectionRange(start, end);
    } catch {
        // Some embedded browsers do not expose selection APIs for search inputs.
    }
}

function bindSearchInput(input, onCommit) {
    if (!input) return;
    let composing = false;
    let compositionCommitTimer = 0;
    const snapshot = target => ({
        value: target.value || '',
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
    });
    const commit = target => onCommit(snapshot(target));

    input.addEventListener('compositionstart', () => {
        composing = true;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        compositionCommitTimer = 0;
    });
    input.addEventListener('compositionend', event => {
        composing = false;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        const committed = snapshot(event.currentTarget);
        compositionCommitTimer = window.setTimeout(() => {
            compositionCommitTimer = 0;
            onCommit(committed);
        }, 0);
    });
    input.addEventListener('input', event => {
        if (composing || event.isComposing) return;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        compositionCommitTimer = 0;
        commit(event.currentTarget);
    });
}

function renderPopover() {
    const adapter = adapters.get(activePopoverAdapterId);
    const popover = ensurePopover();
    if (!adapter?.trigger || !adapter.isEnabled()) {
        closePopover();
        return;
    }
    const currentKeys = new Set(adapter.getSelectedKeys());
    const current = adapter.getSelectedKey();
    const { state, buckets, loose, searching } = groupBuckets(adapter, popoverSearch);
    const currentGroupId = state.assignments[current] || '';
    const shouldLocateCurrent = locateCurrentOnNextPopoverRender && !searching;
    if (shouldLocateCurrent && adapter.multiple) {
        const focusedGroupId = currentGroupId || (current ? '__loose' : '');
        if (focusedGroupId && state.collapsed[focusedGroupId] !== false) {
            state.collapsed[focusedGroupId] = false;
            scheduleSave();
        }
    }

    const renderItems = items => items.map(item => `
        <button type="button" class="pgm-q-item srg-pop-item ${currentKeys.has(item.key) ? 'current' : ''}" data-srg-select="${escapeHtml(item.key)}" ${adapter.multiple ? `aria-pressed="${currentKeys.has(item.key) ? 'true' : 'false'}"` : ''}>
            <span class="pgm-current-dot srg-current-dot"></span><span>${escapeHtml(item.label)}</span>
        </button>
    `).join('');

    const sections = [];
    for (const group of state.groups) {
        const items = buckets.get(group.id) || [];
        if (!items.length) continue;
        const collapsed = searching || (shouldLocateCurrent && currentGroupId === group.id) ? false : state.collapsed[group.id] !== false;
        sections.push(`
            <section class="pgm-q-group srg-pop-group ${collapsed ? 'collapsed' : ''}">
                <button type="button" class="pgm-q-head srg-pop-head" data-srg-toggle="${escapeHtml(group.id)}">
                    <span class="pgm-q-chevron srg-chevron">▾</span><span class="pgm-q-title srg-pop-title">${escapeHtml(group.name)}</span><span class="pgm-q-count srg-count">${items.length}</span>
                </button>
                <div class="pgm-q-body srg-pop-body">${collapsed ? '' : renderItems(items)}</div>
            </section>
        `);
    }
    if (loose.length) {
        const collapsed = searching || (shouldLocateCurrent && !currentGroupId && loose.some(item => item.key === current)) ? false : state.collapsed.__loose !== false;
        sections.push(`
            <section class="pgm-q-group srg-pop-group ${collapsed ? 'collapsed' : ''}">
                <button type="button" class="pgm-q-head srg-pop-head" data-srg-toggle="__loose">
                    <span class="pgm-q-chevron srg-chevron">▾</span><span class="pgm-q-title srg-pop-title">未分组</span><span class="pgm-q-count srg-count">${loose.length}</span>
                </button>
                <div class="pgm-q-body srg-pop-body">${collapsed ? '' : renderItems(loose)}</div>
            </section>
        `);
    }

    popover.innerHTML = `
        <div class="pgm-quick-head srg-pop-toolbar">
            <input type="search" class="pgm-search srg-search" data-srg-pop-search placeholder="搜索${escapeHtml(adapter.label)}..." value="${escapeHtml(popoverSearch)}">
            <button type="button" class="pgm-icon-btn srg-icon-button" data-srg-open-manager title="管理分组"><i class="fa-solid fa-gear"></i></button>
        </div>
        <div class="pgm-quick-list srg-pop-list">${sections.join('') || '<div class="pgm-empty srg-empty">没有匹配的条目</div>'}</div>
    `;

    const searchInput = popover.querySelector('[data-srg-pop-search]');
    bindSearchInput(searchInput, ({ value, selectionStart, selectionEnd }) => {
        popoverSearch = value;
        renderPopover();
        const next = popover.querySelector('[data-srg-pop-search]');
        focusSearchAt(next, selectionStart, selectionEnd);
        positionPopover(adapter);
    });
    popover.querySelector('[data-srg-open-manager]')?.addEventListener('click', () => {
        closePopover();
        openManager(adapter.id);
    });
    popover.querySelectorAll('[data-srg-toggle]').forEach(button => {
        button.addEventListener('click', () => {
            if (searching) return;
            const groupId = button.dataset.srgToggle;
            const section = button.closest('.srg-pop-group');
            const isCurrentlyCollapsed = section?.classList.contains('collapsed') ?? true;
            state.collapsed[groupId] = !isCurrentlyCollapsed;
            locateCurrentOnNextPopoverRender = false;
            scheduleSave();
            renderPopover();
            positionPopover(adapter);
        });
    });
    popover.querySelectorAll('[data-srg-select]').forEach(button => {
        button.addEventListener('click', () => {
            if (adapter.selectItem(button.dataset.srgSelect || '') && !adapter.multiple) closePopover();
        });
    });
    if (shouldLocateCurrent) {
        locateCurrentOnNextPopoverRender = false;
        requestAnimationFrame(() => {
            const currentItem = popover.querySelector('.srg-pop-item.current');
            centerItemInScroller(popover.querySelector('.srg-pop-list'), currentItem);
            positionPopover(adapter);
        });
    } else {
        requestAnimationFrame(() => positionPopover(adapter));
    }
}

function ensureManager() {
    let mask = document.getElementById(MANAGER_ID);
    if (!mask) {
        mask = document.createElement('div');
        mask.id = MANAGER_ID;
        mask.innerHTML = '<button type="button" class="srg-manager-backdrop" data-srg-manager-backdrop aria-label="关闭分组管理器背景" tabindex="-1"></button><div class="srg-manager" role="dialog" aria-modal="true" aria-label="嘎嘎资源分组"></div>';
        const backdrop = mask.querySelector('[data-srg-manager-backdrop]');
        const panel = mask.querySelector('.srg-manager');
        if (backdrop) backdrop.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;';
        if (panel) {
            panel.style.position = 'relative';
            panel.style.zIndex = '1';
        }
        ensureRoot().appendChild(mask);
        backdrop?.addEventListener('click', closeManager);
        mask.addEventListener('click', event => {
            const clickedBlankListArea = event.target === panel?.querySelector('.srg-manager-list');
            if (event.target === mask || event.target === panel || clickedBlankListArea) closeManager();
        });
    }
    return mask;
}

function syncManagerViewport() {
    const mask = document.getElementById(MANAGER_ID);
    if (!mask?.classList.contains('open')) return;
    const viewport = window.visualViewport;
    const width = Math.max(1, Math.round(viewport?.width || window.innerWidth));
    const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
    const offsetLeft = Math.round(viewport?.offsetLeft || 0);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    const mobile = width <= 700;
    mask.style.inset = 'auto';
    mask.style.position = mobile ? 'absolute' : 'fixed';
    mask.style.top = '0';
    mask.style.left = '0';
    mask.style.right = 'auto';
    mask.style.bottom = 'auto';
    mask.style.width = `${width}px`;
    mask.style.height = `${height}px`;
    mask.style.transform = mobile ? 'none' : `translate(${offsetLeft}px, ${offsetTop}px)`;
    syncScopedManagerGeometry(width, height);
}

function syncScopedManagerGeometry(viewportWidth, viewportHeight) {
    const mask = document.getElementById(MANAGER_ID);
    if (!mask?.classList.contains('scoped') || !managerAnchorRect) return;
    const gap = 7;
    const width = Math.min(managerAnchorRect.width, viewportWidth - gap * 2);
    const height = Math.min(managerAnchorRect.height, viewportHeight - gap * 2);
    const left = Math.min(Math.max(managerAnchorRect.left, gap), viewportWidth - width - gap);
    const top = Math.min(Math.max(managerAnchorRect.top, gap), viewportHeight - height - gap);
    mask.style.setProperty('--srg-manager-x', `${left}px`);
    mask.style.setProperty('--srg-manager-y', `${top}px`);
    mask.style.setProperty('--srg-manager-width', `${width}px`);
    mask.style.setProperty('--srg-manager-height', `${height}px`);
}

function openManager(adapterId = '', { anchorRect = null } = {}) {
    activeAdapterId = resolveManagerAdapterId(adapterId);
    managerSearch = '';
    locateCurrentOnNextManagerRender = true;
    // The reference script always opens its manager as a full overlay. Keep the
    // argument for backwards compatibility with older callers, but do not anchor
    // the manager to the quick picker (that produced the bottom-offset mobile UI).
    managerAnchorRect = null;
    closePopover();
    document.documentElement.classList.add('srg-manager-open');
    const mask = ensureManager();
    mask.classList.remove('scoped');
    mask.classList.add('open');
    syncManagerViewport();
    renderManager();
    requestAnimationFrame(() => {
        syncManagerViewport();
    });
}

function closeManager() {
    const mask = document.getElementById(MANAGER_ID);
    mask?.classList.remove('open', 'scoped');
    mask?.style.removeProperty('--srg-manager-x');
    mask?.style.removeProperty('--srg-manager-y');
    mask?.style.removeProperty('--srg-manager-width');
    mask?.style.removeProperty('--srg-manager-height');
    managerAnchorRect = null;
    locateCurrentOnNextManagerRender = false;
    document.documentElement.classList.remove('srg-manager-open');
}

function getManagerAdapters() {
    const byState = new Map();
    for (const adapter of adapters.values()) {
        const existing = byState.get(adapter.stateId);
        const hasItems = adapter.getItems().length > 0;
        const existingHasItems = existing?.getItems().length > 0;
        if (!existing || (hasItems && !existingHasItems) || (hasItems === existingHasItems && adapter.managerPriority > existing.managerPriority)) {
            byState.set(adapter.stateId, adapter);
        }
    }
    return [...byState.values()];
}

function getManagerItems(adapter) {
    const candidates = [
        adapter,
        ...[...adapters.values()].filter(candidate => candidate !== adapter && candidate.stateId === adapter.stateId),
    ];
    const seen = new Set();
    const items = [];
    for (const candidate of candidates) {
        for (const item of candidate.getItems()) {
            if (seen.has(item.key)) continue;
            seen.add(item.key);
            items.push(item);
        }
    }
    return items;
}

function getManagerSelectionAdapter(adapter, itemKey) {
    return [...adapters.values()]
        .filter(candidate => candidate.stateId === adapter.stateId && candidate.getItems().some(item => item.key === itemKey))
        .sort((left, right) => right.managerPriority - left.managerPriority)[0] || adapter;
}

function isManagerItemSelected(adapter, itemKey) {
    return getManagerSelectionAdapter(adapter, itemKey).isItemSelected(itemKey);
}

function selectManagerItem(adapter, itemKey) {
    return getManagerSelectionAdapter(adapter, itemKey).selectItem(itemKey);
}

function resolveManagerAdapterId(adapterId = '') {
    const managerAdapters = getManagerAdapters();
    const requested = adapters.get(adapterId);
    if (requested) return managerAdapters.find(adapter => adapter.stateId === requested.stateId)?.id || '';
    if (managerAdapters.some(adapter => adapter.id === activeAdapterId)) return activeAdapterId;
    return managerAdapters[0]?.id || '';
}

async function promptText(title, message, initial = '') {
    try {
        if (context?.Popup?.show?.input) return await context.Popup.show.input(title, message, initial);
    } catch {
        // Native fallback below.
    }
    return window.prompt(`${title}\n${message}`, initial);
}

async function confirmAction(title, message) {
    try {
        if (context?.Popup?.show?.confirm) return Boolean(await context.Popup.show.confirm(title, message));
    } catch {
        // Native fallback below.
    }
    return window.confirm(`${title}\n${message}`);
}

function moveGroup(state, groupId, delta) {
    const index = state.groups.findIndex(group => group.id === groupId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= state.groups.length) return;
    [state.groups[index], state.groups[target]] = [state.groups[target], state.groups[index]];
    scheduleSave();
}

function reorderGroup(state, sourceId, targetId, placeAfter = false) {
    if (!sourceId || sourceId === targetId) return false;
    const sourceIndex = state.groups.findIndex(group => group.id === sourceId);
    if (sourceIndex < 0) return false;
    const [group] = state.groups.splice(sourceIndex, 1);
    if (!targetId) {
        state.groups.push(group);
    } else {
        const targetIndex = state.groups.findIndex(item => item.id === targetId);
        if (targetIndex < 0) {
            state.groups.splice(sourceIndex, 0, group);
            return false;
        }
        state.groups.splice(targetIndex + (placeAfter ? 1 : 0), 0, group);
    }
    scheduleSave();
    return true;
}

function renderManagerItem(adapter, item, state, dragEnabled = true) {
    const assigned = state.assignments[item.key] || '';
    const pinned = Boolean(state.manualAssignments[item.key]);
    const options = ['<option value="">未分组</option>', ...state.groups.map(group => (
        `<option value="${escapeHtml(group.id)}" ${group.id === assigned ? 'selected' : ''}>${escapeHtml(group.name)}</option>`
    ))].join('');
    return `
        <div class="pgm-preset srg-manager-item ${isManagerItemSelected(adapter, item.key) ? 'current' : ''}" draggable="${dragEnabled ? 'true' : 'false'}" data-srg-drag-item="${escapeHtml(item.key)}">
            <div class="pgm-preset-main">
                <span class="pgm-drag" title="拖动到其他分组">⠿</span>
                <button type="button" class="pgm-preset-name srg-item-name ${isManagerItemSelected(adapter, item.key) ? 'current' : ''}" data-srg-manager-select="${escapeHtml(item.key)}" title="切换到此条目">${escapeHtml(item.label)}</button>
            </div>
            <select class="pgm-move srg-group-select" data-srg-assign="${escapeHtml(item.key)}">${options}</select>
            <span class="srg-pin ${pinned ? 'active' : ''}" title="${pinned ? '手动位置：自动整理会保留' : '自动位置'}"><i class="fa-solid fa-thumbtack"></i></span>
        </div>
    `;
}

function renderManager() {
    const mask = ensureManager();
    const panel = mask.querySelector('.srg-manager');
    const previousBody = panel.querySelector('.pgm-body');
    const previousScrollTop = previousBody?.scrollTop || 0;
    const shouldRestoreScroll = Boolean(previousBody);
    const managerAdapters = getManagerAdapters();
    if (!managerAdapters.some(item => item.id === activeAdapterId)) activeAdapterId = managerAdapters[0]?.id || '';
    const adapter = adapters.get(activeAdapterId);
    const tabs = managerAdapters.map(item => `
        <button type="button" class="srg-tab ${item.id === activeAdapterId ? 'active' : ''}" data-srg-tab="${escapeHtml(item.id)}">${escapeHtml(item.managerLabel)}</button>
    `).join('');

    if (!adapter) {
        locateCurrentOnNextManagerRender = false;
        panel.innerHTML = `
            <header class="pgm-head srg-manager-header"><div class="pgm-head-main"><div class="pgm-title">${DISPLAY_NAME}</div><div class="pgm-sub">v${VERSION}</div></div><button type="button" class="pgm-icon-btn srg-close" data-srg-close>×</button></header>
            <div class="pgm-empty srg-empty srg-empty-large">尚未发现可管理的预设、主题或世界书选择器。</div>
        `;
        panel.querySelector('[data-srg-close]')?.addEventListener('click', closeManager);
        return;
    }

    const managerItems = getManagerItems(adapter);
    const { state, buckets, loose } = groupBuckets(adapter, managerSearch, managerItems);
    const searching = Boolean(normalizeName(managerSearch));
    const dragEnabled = !searching && !window.matchMedia?.('(pointer: coarse)')?.matches;
    const selectedKey = adapter.getSelectedKey();
    const selectedGroupId = selectedKey ? (state.assignments[selectedKey] || '') : '';
    const shouldLocateCurrent = locateCurrentOnNextManagerRender && !searching;
    if (shouldLocateCurrent && selectedKey) {
        const currentSectionId = selectedGroupId || '__loose';
        if (state.managerCollapsed[currentSectionId] !== false) {
            state.managerCollapsed[currentSectionId] = false;
            scheduleSave();
        }
    }
    const managerItemNoun = adapter.kind === 'preset' ? '预设' : '条目';
    const currentItem = managerItems.find(item => item.key === adapter.getSelectedKey());
    const managerSubtitle = `${adapter.kind === 'preset' ? adapter.label.replace(/\s*预设$/, '') : adapter.managerLabel} · ${managerItems.length} 个${managerItemNoun}${currentItem ? ` · 当前：${currentItem.label}` : ''}`;
    const sections = [];
    for (let index = 0; index < state.groups.length; index++) {
        const group = state.groups[index];
        const items = buckets.get(group.id) || [];
        if (searching && !items.length && !group.name.toLocaleLowerCase().includes(managerSearch.toLocaleLowerCase())) continue;
        const collapsed = searching ? false : (shouldLocateCurrent && selectedGroupId === group.id ? false : state.managerCollapsed[group.id] !== false);
        sections.push(`
            <section class="pgm-group srg-manager-group ${collapsed ? 'collapsed' : ''}" data-srg-drop-group="${escapeHtml(group.id)}">
                <div class="pgm-group-head srg-manager-group-head">
                    <span class="pgm-drag srg-group-drag" draggable="${dragEnabled ? 'true' : 'false'}" data-srg-drag-group="${escapeHtml(group.id)}" title="拖动分组排序">⠿</span>
                    <button type="button" class="pgm-group-toggle srg-group-heading" data-srg-manager-toggle="${escapeHtml(group.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                        <span class="pgm-chevron srg-chevron">▾</span><strong class="pgm-group-name">${escapeHtml(group.name)}</strong><span class="pgm-count srg-count">${items.length}</span>
                    </button>
                    <div class="pgm-group-actions srg-group-actions">
                        <button type="button" class="pgm-row-btn srg-row-button reorder" data-srg-up="${escapeHtml(group.id)}" ${index === 0 ? 'disabled' : ''} aria-label="上移分组" title="上移分组">↑</button>
                        <button type="button" class="pgm-row-btn srg-row-button reorder" data-srg-down="${escapeHtml(group.id)}" ${index === state.groups.length - 1 ? 'disabled' : ''} aria-label="下移分组" title="下移分组">↓</button>
                        <button type="button" class="pgm-row-btn srg-row-button" data-srg-rename="${escapeHtml(group.id)}" aria-label="重命名" title="重命名">✎</button>
                        <button type="button" class="pgm-row-btn srg-row-button danger" data-srg-delete-group="${escapeHtml(group.id)}" aria-label="删除分组（条目保留）" title="删除分组（条目保留）">×</button>
                    </div>
                </div>
                <div class="pgm-group-body srg-manager-group-body">${collapsed ? '' : (items.map(item => renderManagerItem(adapter, item, state, dragEnabled)).join('') || '<div class="pgm-empty srg-empty">把条目拖到这里，或使用右侧“移动到”</div>')}</div>
            </section>
        `);
    }
    if (loose.length || !state.groups.length) {
        const collapsed = searching ? false : (shouldLocateCurrent && !selectedGroupId ? false : state.managerCollapsed.__loose !== false);
        sections.push(`
            <section class="pgm-group srg-manager-group loose ${collapsed ? 'collapsed' : ''}" data-srg-drop-group="">
                <div class="pgm-group-head srg-manager-group-head">
                    <button type="button" class="pgm-group-toggle srg-group-heading" data-srg-manager-toggle="__loose" aria-expanded="${collapsed ? 'false' : 'true'}">
                        <span class="pgm-chevron srg-chevron">▾</span><strong class="pgm-group-name">未分组</strong><span class="pgm-count srg-count">${loose.length}</span>
                    </button>
                </div>
                <div class="pgm-group-body srg-manager-group-body">${collapsed ? '' : (loose.map(item => renderManagerItem(adapter, item, state, dragEnabled)).join('') || '<div class="pgm-empty srg-empty">暂无未分组条目</div>')}</div>
            </section>
        `);
    }

    panel.classList.toggle('compact', Boolean(settings.compactRows));
    panel.innerHTML = `
        <header class="pgm-head srg-manager-header">
            <div class="pgm-head-main"><div class="pgm-title">${DISPLAY_NAME}</div><div class="pgm-sub">${escapeHtml(managerSubtitle)} · v${VERSION}</div></div>
            <button type="button" class="pgm-icon-btn srg-close" data-srg-close aria-label="关闭">×</button>
        </header>
        <nav class="srg-tabs">${tabs}</nav>
        <div class="pgm-tools srg-manager-toolbar">
            <input type="search" class="pgm-search srg-search" data-srg-manager-search placeholder="搜索${escapeHtml(adapter.label)}..." value="${escapeHtml(managerSearch)}">
            <button type="button" class="pgm-btn primary srg-action-button" data-srg-smart>智能整理并合并</button>
            <button type="button" class="pgm-btn srg-action-button" data-srg-add-group>＋ 新建分组</button>
        </div>
        <div class="pgm-hint srg-manager-hint">桌面端可拖动分组调整顺序，也可把条目拖到其他分组；手机端使用每行右侧的“移动到”。手动调整后的分组会保留，条目本体不会被修改。</div>
        <div class="pgm-body srg-manager-list">${sections.join('') || '<div class="pgm-empty srg-empty srg-empty-large">没有匹配的条目</div>'}</div>
    `;

    panel.querySelector('[data-srg-close]')?.addEventListener('click', closeManager);
    panel.querySelectorAll('[data-srg-tab]').forEach(button => {
        button.addEventListener('click', () => {
            activeAdapterId = button.dataset.srgTab || '';
            managerSearch = '';
            renderManager();
        });
    });
    panel.querySelectorAll('[data-srg-manager-toggle]').forEach(button => {
        button.addEventListener('click', () => {
            if (searching) return;
            const groupId = button.dataset.srgManagerToggle || '';
            const section = button.closest('.srg-manager-group');
            const isCurrentlyCollapsed = section?.classList.contains('collapsed') ?? true;
            state.managerCollapsed[groupId] = !isCurrentlyCollapsed;
            scheduleSave();
            renderManager();
        });
    });
    const searchInput = panel.querySelector('[data-srg-manager-search]');
    bindSearchInput(searchInput, ({ value, selectionStart, selectionEnd }) => {
        managerSearch = value;
        renderManager();
        focusSearchAt(panel.querySelector('[data-srg-manager-search]'), selectionStart, selectionEnd);
    });
    panel.querySelector('[data-srg-smart]')?.addEventListener('click', () => {
        applySmartGrouping(adapter, { items: managerItems });
        renderManager();
    });
    panel.querySelector('[data-srg-add-group]')?.addEventListener('click', async () => {
        const name = normalizeName(await promptText('新建分组', '请输入分组名称：', ''));
        if (!name) return;
        if (state.groups.some(group => familyKey(group.name) === familyKey(name))) {
            toast('已有同名分组', 'warning');
            return;
        }
        getOrCreateGroup(state, name, false);
        scheduleSave();
        renderManager();
    });
    panel.querySelector('[data-srg-reset-source]')?.addEventListener('click', async () => {
        if (!await confirmAction('清除分组', `清除“${adapter.managerLabel}”的全部分组？资源本体不会被删除。`)) return;
        settings.resources[adapter.stateId] = normalizeResourceState({});
        scheduleSave();
        renderManager();
        toast('分组已清除，条目本体未改动', 'success');
    });
    panel.querySelectorAll('[data-srg-manager-select]').forEach(button => {
        button.addEventListener('click', () => {
            selectManagerItem(adapter, button.dataset.srgManagerSelect || '');
            renderManager();
        });
    });
    panel.querySelectorAll('[data-srg-assign]').forEach(select => {
        select.addEventListener('change', () => {
            assignItem(adapter.stateId, select.dataset.srgAssign || '', select.value, true);
            renderManager();
        });
    });
    let draggingItemKey = '';
    let draggingGroupId = '';
    const clearDragState = () => {
        draggingItemKey = '';
        draggingGroupId = '';
        panel.querySelectorAll('.dragging, .drag-over').forEach(element => element.classList.remove('dragging', 'drag-over'));
    };
    const rerenderAtCurrentScroll = () => {
        const scrollTop = panel.querySelector('.pgm-body')?.scrollTop || 0;
        renderManager();
        requestAnimationFrame(() => {
            const body = panel.querySelector('.pgm-body');
            if (body) body.scrollTop = Math.min(scrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
        });
    };
    panel.querySelectorAll('[data-srg-drag-item][draggable="true"]').forEach(row => {
        row.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingItemKey = row.dataset.srgDragItem || '';
            draggingGroupId = '';
            row.classList.add('dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', draggingItemKey);
            } catch {
                // Drag state above is enough for same-panel moves.
            }
        });
        row.addEventListener('dragend', clearDragState);
    });
    panel.querySelectorAll('[data-srg-drag-group][draggable="true"]').forEach(handle => {
        handle.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingGroupId = handle.dataset.srgDragGroup || '';
            draggingItemKey = '';
            handle.closest('.srg-manager-group')?.classList.add('dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-srg-group', draggingGroupId);
            } catch {
                // Drag state above is enough for same-panel moves.
            }
        });
        handle.addEventListener('dragend', clearDragState);
    });
    panel.querySelectorAll('[data-srg-drop-group]').forEach(section => {
        section.addEventListener('dragover', event => {
            if (!draggingItemKey && !draggingGroupId) return;
            event.preventDefault();
            section.classList.add('drag-over');
            try { event.dataTransfer.dropEffect = 'move'; } catch { /* Browser fallback. */ }
        });
        section.addEventListener('dragleave', event => {
            if (!section.contains(event.relatedTarget)) section.classList.remove('drag-over');
        });
        section.addEventListener('drop', event => {
            if (!draggingItemKey && !draggingGroupId) return;
            event.preventDefault();
            event.stopPropagation();
            const targetGroupId = section.dataset.srgDropGroup || '';
            if (draggingItemKey) {
                assignItem(adapter.stateId, draggingItemKey, targetGroupId, true);
                clearDragState();
                rerenderAtCurrentScroll();
                return;
            }
            const bounds = section.getBoundingClientRect();
            const placeAfter = event.clientY > bounds.top + bounds.height / 2;
            const changed = reorderGroup(state, draggingGroupId, targetGroupId, placeAfter);
            clearDragState();
            if (changed) rerenderAtCurrentScroll();
        });
    });
    panel.querySelectorAll('[data-srg-up]').forEach(button => button.addEventListener('click', () => {
        moveGroup(state, button.dataset.srgUp || '', -1);
        renderManager();
    }));
    panel.querySelectorAll('[data-srg-down]').forEach(button => button.addEventListener('click', () => {
        moveGroup(state, button.dataset.srgDown || '', 1);
        renderManager();
    }));
    panel.querySelectorAll('[data-srg-rename]').forEach(button => button.addEventListener('click', async () => {
        const group = state.groups.find(item => item.id === button.dataset.srgRename);
        if (!group) return;
        const name = normalizeName(await promptText('重命名分组', '请输入新的分组名称：', group.name));
        if (!name || name === group.name) return;
        if (state.groups.some(item => item.id !== group.id && familyKey(item.name) === familyKey(name))) {
            toast('已有同名分组', 'warning');
            return;
        }
        group.name = name;
        group.auto = false;
        scheduleSave();
        renderManager();
    }));
    panel.querySelectorAll('[data-srg-delete-group]').forEach(button => button.addEventListener('click', async () => {
        const group = state.groups.find(item => item.id === button.dataset.srgDeleteGroup);
        if (!group || !await confirmAction('删除分组', `删除“${group.name}”？其中的条目会回到未分组，条目本体不会被删除。`)) return;
        state.groups = state.groups.filter(item => item.id !== group.id);
        for (const [name, groupId] of Object.entries(state.assignments)) {
            if (groupId === group.id) {
                delete state.assignments[name];
                state.manualAssignments[name] = true;
            }
        }
        delete state.collapsed[group.id];
        delete state.managerCollapsed[group.id];
        scheduleSave();
        renderManager();
    }));
    if (shouldLocateCurrent) {
        locateCurrentOnNextManagerRender = false;
        requestAnimationFrame(() => {
            const currentItem = panel.querySelector('.pgm-preset.current');
            centerItemInScroller(panel.querySelector('.pgm-body'), currentItem);
        });
    } else if (shouldRestoreScroll) {
        requestAnimationFrame(() => {
            const body = panel.querySelector('.pgm-body');
            if (body) body.scrollTop = Math.min(previousScrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
        });
    }
}

function createSettingsPanel() {
    const host = document.getElementById('extensions_settings2');
    if (!host || document.getElementById(SETTINGS_ID)) return false;
    const panel = document.createElement('div');
    panel.id = SETTINGS_ID;
    panel.className = 'srg-settings extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${DISPLAY_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="srg-settings-note">自动发现 SillyTavern 的预设、UI 主题（美化）和世界书选择器。只改变列表呈现与分组记录，不改写任何资源本体。</p>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enabled"><span>启用插件</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhancePresets"><span>接管全部预设 / 模板下拉框</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhanceThemes"><span>接管美化 / UI 主题下拉框</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhanceWorldInfo"><span>接管世界书选择器</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="autoGroupOnDiscovery"><span>发现新增条目时自动整理</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="compactRows"><span>管理器使用紧凑行高</span></label>
                <label class="srg-number-setting"><span>自动成组所需的最少条目数</span><input type="number" min="2" max="12" step="1" data-srg-setting="minGroupSize"></label>
                <div class="srg-settings-actions">
                    <button type="button" class="menu_button" data-srg-settings-open><span>打开管理器</span></button>
                    <button type="button" class="menu_button" data-srg-settings-all><span>整理全部</span></button>
                    <button type="button" class="menu_button" data-srg-export><span>导出分组</span></button>
                    <button type="button" class="menu_button" data-srg-import><span>导入分组</span></button>
                    <input type="file" accept="application/json,.json" data-srg-import-file hidden>
                </div>
                <div class="srg-settings-status" data-srg-status></div>
            </div>
        </div>
    `;
    host.appendChild(panel);

    for (const input of panel.querySelectorAll('[data-srg-setting]')) {
        const key = input.dataset.srgSetting;
        if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
        else input.value = String(settings[key]);
        input.addEventListener('change', () => {
            settings[key] = input.type === 'checkbox' ? input.checked : Math.max(2, Math.min(12, Number(input.value) || 2));
            if (key === 'minGroupSize') input.value = String(settings[key]);
            for (const adapter of adapters.values()) adapter.refreshMount();
            scheduleSave();
            updateSettingsStatus();
        });
    }
    panel.querySelector('[data-srg-settings-open]')?.addEventListener('click', () => openManager());
    panel.querySelector('[data-srg-settings-all]')?.addEventListener('click', () => {
        let groups = 0;
        let assigned = 0;
        for (const adapter of getManagerAdapters()) {
            const result = applySmartGrouping(adapter, { announce: false, items: getManagerItems(adapter) });
            groups += result.groups;
            assigned += result.assigned;
        }
        toast(`全部整理完成：${groups} 个分组，${assigned} 个条目`, 'success');
        renderManager();
    });
    panel.querySelector('[data-srg-export]')?.addEventListener('click', exportGroupingData);
    const fileInput = panel.querySelector('[data-srg-import-file]');
    panel.querySelector('[data-srg-import]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) await importGroupingData(file);
    });
    updateSettingsStatus();
    return true;
}

function updateSettingsStatus() {
    const status = document.querySelector('[data-srg-status]');
    if (!status || !settings) return;
    const resourceAdapters = getManagerAdapters();
    const itemCount = resourceAdapters.reduce((sum, adapter) => sum + getManagerItems(adapter).length, 0);
    const groupCount = Object.values(settings.resources).reduce((sum, resource) => sum + (Array.isArray(resource?.groups) ? resource.groups.length : 0), 0);
    const nextText = `已发现 ${resourceAdapters.length} 类资源、${itemCount} 个条目；当前保存 ${groupCount} 个分组。`;
    if (status.textContent !== nextText) status.textContent = nextText;
}

function exportGroupingData() {
    const data = {
        type: 'sillytavern-smart-resource-groups',
        version: 2,
        exportedAt: new Date().toISOString(),
        resources: settings.resources,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `smart-resource-groups-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

async function importGroupingData(file) {
    try {
        const data = JSON.parse(await file.text());
        if (data?.type !== 'sillytavern-smart-resource-groups' || !data.resources || typeof data.resources !== 'object') {
            throw new Error('文件不是嘎嘎资源分组导出格式');
        }
        if (!await confirmAction('导入分组', '导入会覆盖当前分组记录，但不会修改或删除任何预设、模板、主题或世界书。继续吗？')) return;
        settings.resources = {};
        for (const [id, resource] of Object.entries(data.resources)) settings.resources[id] = normalizeResourceState(clone(resource));
        scheduleSave();
        for (const adapter of adapters.values()) adapter.onItemsChanged();
        renderManager();
        toast('分组数据导入完成', 'success');
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 导入失败`, error);
        toast(`导入失败：${error.message || error}`, 'error');
    }
}

function scrubMenuEntryIcon(item) {
    if (!item) return;
    let label = item.querySelector(':scope > .srg-menu-label');
    if (!label) {
        label = document.createElement('span');
        label.className = 'srg-menu-label';
        item.replaceChildren(label);
    } else {
        for (const child of [...item.children]) {
            if (child !== label) child.remove();
        }
    }
    if (label.textContent !== DISPLAY_NAME) label.textContent = DISPLAY_NAME;
}

function injectMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    const existing = document.getElementById(MENU_ID);
    if (!menu) return Boolean(existing);
    if (existing) {
        scrubMenuEntryIcon(existing);
        return true;
    }
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<span class="srg-menu-label">嘎嘎资源分组</span>';
    item.setAttribute('role', 'button');
    item.addEventListener('click', () => openManager());
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openManager();
        }
    });
    menu.appendChild(item);
    scrubMenuEntryIcon(item);
    return true;
}

function scanAdapters() {
    if (!settings) return;
    const found = new Map();
    for (const select of document.querySelectorAll(RESOURCE_SELECT_SELECTOR)) {
        const id = sourceIdForSelect(select);
        if (!id || found.has(id)) continue;
        found.set(id, select);
        const existing = adapters.get(id);
        if (existing?.select === select) {
            existing.refreshMount();
            continue;
        }
        existing?.destroy();
        adapters.set(id, new SelectAdapter(select));
    }
    for (const [id, adapter] of adapters) {
        if (!adapter.select.isConnected || (found.has(id) && found.get(id) !== adapter.select)) {
            adapter.destroy();
            adapters.delete(id);
        }
    }
    injectMenuEntry();
    createSettingsPanel();
    updateSettingsStatus();
}

function elementMatchesOrContains(node, selector) {
    if (!(node instanceof Element)) return false;
    return node.matches(selector) || Boolean(node.querySelector(selector));
}

function mutationNeedsScan(mutation) {
    if (mutation.type !== 'childList') return false;
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (elementMatchesOrContains(node, SCAN_DISCOVERY_SELECTOR)) return true;
    }
    return false;
}

function handleRootMutations(mutations) {
    if (mutations.some(mutationNeedsScan)) scheduleScan();
}

function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        scanAdapters();
    }, 180);
}

function migrateRenamedPreset(data) {
    if (!data) return;
    const apiId = String(data.apiId || '').trim();
    const oldName = normalizeName(data.oldName);
    const newName = normalizeName(data.newName);
    if (!apiId || !oldName || !newName) return;
    const id = `preset:${apiId === 'koboldhorde' ? 'kobold' : apiId}`;
    const state = getResourceState(id);
    if (state.assignments[oldName]) state.assignments[newName] = state.assignments[oldName];
    if (state.manualAssignments[oldName]) state.manualAssignments[newName] = true;
    delete state.assignments[oldName];
    delete state.manualAssignments[oldName];
    state.fingerprint = '';
    scheduleSave();
    scheduleScan();
}

function removeDeletedPreset(data) {
    if (!data) return;
    const apiId = String(data.apiId || '').trim();
    const name = normalizeName(data.name);
    if (!apiId || !name) return;
    const id = `preset:${apiId === 'koboldhorde' ? 'kobold' : apiId}`;
    const state = getResourceState(id);
    delete state.assignments[name];
    delete state.manualAssignments[name];
    state.fingerprint = '';
    scheduleSave();
    scheduleScan();
}

function bindAppEvents() {
    const eventSource = context.eventSource || context.event_source || globalThis.eventSource;
    const eventTypes = context.event_types || context.eventTypes || globalThis.event_types || {};
    if (!eventSource?.on) return;

    const bind = (name, handler) => {
        const type = eventTypes[name];
        if (!type) return;
        eventSource.on(type, handler);
        eventCleanup.push(() => {
            try {
                eventSource.removeListener?.(type, handler);
                eventSource.off?.(type, handler);
            } catch {
                // Best-effort cleanup on page unload.
            }
        });
    };
    bind('PRESET_CHANGED', () => {
        for (const adapter of adapters.values()) adapter.updateTrigger();
    });
    bind('MAIN_API_CHANGED', scheduleScan);
    bind('PRESET_RENAMED', migrateRenamedPreset);
    bind('PRESET_DELETED', removeDeletedPreset);
    bind('WORLDINFO_SETTINGS_UPDATED', scheduleScan);
    bind('APP_READY', scheduleScan);
}

function stopLegacyUiIfPresent() {
    try {
        if (typeof globalThis.__presetGroupManagerCleanup === 'function') {
            globalThis.__presetGroupManagerCleanup();
            toast('检测到旧版“预设分组”脚本，本次页面已停用旧界面；请在酒馆助手中关闭旧脚本，避免下次重复加载。', 'warning');
        }
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 旧版界面清理失败`, error);
    }
}

function bindGlobalUiEvents() {
    const handleDocumentPointerDown = event => {
        const manager = document.getElementById(MANAGER_ID);
        if (manager?.classList.contains('open')) {
            const panel = manager.querySelector('.srg-manager');
            if (!panel?.contains(event.target)) {
                closeManager();
                return;
            }
        }
        const popover = document.getElementById(POPOVER_ID);
        if (!popover?.classList.contains('open')) return;
        const adapter = adapters.get(activePopoverAdapterId);
        if (!popover.contains(event.target) && !adapter?.trigger?.contains(event.target)) closePopover();
    };
    const handleDocumentKeydown = event => {
        if (event.key !== 'Escape') return;
        if (document.getElementById(MANAGER_ID)?.classList.contains('open')) closeManager();
        else closePopover();
    };
    const handleWindowResize = () => {
        syncManagerViewport();
        if (activePopoverAdapterId) positionPopover(adapters.get(activePopoverAdapterId));
    };
    const handleWindowScroll = event => {
        const popover = document.getElementById(POPOVER_ID);
        const manager = document.getElementById(MANAGER_ID);
        if (popover?.contains(event.target) || manager?.contains(event.target)) return;
        if (activePopoverAdapterId) positionPopover(adapters.get(activePopoverAdapterId));
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleDocumentKeydown);
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('scroll', handleWindowScroll, true);
    eventCleanup.push(() => {
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', handleWindowResize);
        window.removeEventListener('scroll', handleWindowScroll, true);
    });

    if (window.visualViewport) {
        const syncViewport = () => syncManagerViewport();
        window.visualViewport.addEventListener('resize', syncViewport);
        eventCleanup.push(() => {
            window.visualViewport?.removeEventListener('resize', syncViewport);
        });
    }
}

async function boot() {
    if (initialized) return;
    context = getContext();
    if (!context) {
        window.setTimeout(boot, 300);
        return;
    }
    try {
        loadSettings();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 初始化失败`, error);
        return;
    }
    initialized = true;
    ensureRoot();
    const migrated = migrateLegacyState();
    stopLegacyUiIfPresent();
    bindAppEvents();
    bindGlobalUiEvents();
    rootObserver = new MutationObserver(handleRootMutations);
    rootObserver.observe(document.body, { childList: true, subtree: true });
    scanAdapters();
    if (migrated) toast(`已迁移旧版 v1.5.5 的 ${migrated} 条手动分组记录`, 'success');
    console.log(`[${DISPLAY_NAME}] v${VERSION} loaded`);
}

function cleanup() {
    if (scanTimer) clearTimeout(scanTimer);
    if (saveTimer) clearTimeout(saveTimer);
    rootObserver?.disconnect();
    for (const adapter of adapters.values()) adapter.destroy();
    adapters.clear();
    eventCleanup.splice(0).forEach(fn => fn());
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(SETTINGS_ID)?.remove();
    document.getElementById(RUNTIME_STYLE_ID)?.remove();
    document.documentElement.classList.remove('srg-manager-open');
    document.documentElement.classList.remove('srg-popover-open');
}

window.addEventListener('pagehide', cleanup, { once: true });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.setTimeout(boot, 0), { once: true });
else window.setTimeout(boot, 0);

export { boot as init, cleanup };
