import { familyKey, inferGroups, normalizeName } from './grouping.js';

const MODULE_NAME = 'smart_resource_groups';
const DISPLAY_NAME = '嘎嘎资源分组';
const VERSION = '2.1.5';
const LEGACY_STORAGE_KEY = 'preset-group-manager:state';
const ROOT_ID = 'srg-root';
const POPOVER_ID = 'srg-popover';
const MANAGER_ID = 'srg-manager-mask';
const MENU_ID = 'srg-menu-entry';
const SETTINGS_ID = 'srg-settings';

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
        this.changeHandler = () => {
            this.updateTrigger();
            if (activePopoverAdapterId === this.id) {
                locateCurrentOnNextPopoverRender = !this.multiple;
                renderPopover();
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
        this.trigger.title = selected.join('、') || label;
        this.trigger.innerHTML = `<span class="srg-select-label">${escapeHtml(label)}</span><span class="srg-select-arrow">⌄</span>`;
    }

    onItemsChanged() {
        if (!this.select.isConnected) return;
        this.refreshMount();
        const items = getManagerItems(this);
        const state = getResourceState(this.stateId);
        const names = new Set(items.map(item => item.key));
        const fingerprint = resourceFingerprint(names);
        const itemListChanged = Boolean(this.lastItemsFingerprint && this.lastItemsFingerprint !== fingerprint);
        this.lastItemsFingerprint = fingerprint;
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
        if (activeAdapterId === this.id && document.getElementById(MANAGER_ID)?.classList.contains('open')) renderManager();
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
    let root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        document.body.appendChild(root);
    }
    return root;
}

function ensurePopover() {
    let popover = document.getElementById(POPOVER_ID);
    if (!popover) {
        popover = document.createElement('div');
        popover.id = POPOVER_ID;
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
        <button type="button" class="srg-pop-item ${currentKeys.has(item.key) ? 'current' : ''}" data-srg-select="${escapeHtml(item.key)}" ${adapter.multiple ? `aria-pressed="${currentKeys.has(item.key) ? 'true' : 'false'}"` : ''}>
            <span class="srg-current-dot"></span><span>${escapeHtml(item.label)}</span>
        </button>
    `).join('');

    const sections = [];
    for (const group of state.groups) {
        const items = buckets.get(group.id) || [];
        if (!items.length) continue;
        const collapsed = searching || (shouldLocateCurrent && currentGroupId === group.id) ? false : state.collapsed[group.id] !== false;
        sections.push(`
            <section class="srg-pop-group ${collapsed ? 'collapsed' : ''}">
                <button type="button" class="srg-pop-head" data-srg-toggle="${escapeHtml(group.id)}">
                    <span class="srg-chevron">▾</span><span class="srg-pop-title">${escapeHtml(group.name)}</span><span class="srg-count">${items.length}</span>
                </button>
                <div class="srg-pop-body">${collapsed ? '' : renderItems(items)}</div>
            </section>
        `);
    }
    if (loose.length) {
        const collapsed = searching || (shouldLocateCurrent && !currentGroupId && loose.some(item => item.key === current)) ? false : state.collapsed.__loose !== false;
        sections.push(`
            <section class="srg-pop-group ${collapsed ? 'collapsed' : ''}">
                <button type="button" class="srg-pop-head" data-srg-toggle="__loose">
                    <span class="srg-chevron">▾</span><span class="srg-pop-title">未分组</span><span class="srg-count">${loose.length}</span>
                </button>
                <div class="srg-pop-body">${collapsed ? '' : renderItems(loose)}</div>
            </section>
        `);
    }

    popover.innerHTML = `
        <div class="srg-pop-toolbar">
            <input type="search" class="srg-search" data-srg-pop-search placeholder="搜索${escapeHtml(adapter.label)}..." value="${escapeHtml(popoverSearch)}">
            <button type="button" class="srg-icon-button" data-srg-open-manager title="管理分组"><i class="fa-solid fa-layer-group"></i></button>
        </div>
        <div class="srg-pop-list">${sections.join('') || '<div class="srg-empty">没有匹配的条目</div>'}</div>
    `;

    const searchInput = popover.querySelector('[data-srg-pop-search]');
    searchInput?.addEventListener('input', event => {
        popoverSearch = event.target.value || '';
        renderPopover();
        const next = popover.querySelector('[data-srg-pop-search]');
        next?.focus();
        positionPopover(adapter);
    });
    popover.querySelector('[data-srg-open-manager]')?.addEventListener('click', () => {
        const id = adapter.id;
        closePopover();
        openManager(id);
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
            currentItem?.scrollIntoView({ block: 'center', inline: 'nearest' });
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
        mask.innerHTML = '<div class="srg-manager" role="dialog" aria-modal="true" aria-label="嘎嘎资源分组"></div>';
        ensureRoot().appendChild(mask);
        mask.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const panel = mask.querySelector('.srg-manager');
            const clickedBlankListArea = event.target === panel?.querySelector('.srg-manager-list');
            if (event.target === mask || event.target === panel || clickedBlankListArea) closeManager();
        });
    }
    return mask;
}

function openManager(adapterId = '') {
    activeAdapterId = resolveManagerAdapterId(adapterId);
    managerSearch = '';
    document.documentElement.classList.add('srg-manager-open');
    ensureManager().classList.add('open');
    renderManager();
}

function closeManager() {
    document.getElementById(MANAGER_ID)?.classList.remove('open');
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

function renderManagerItem(adapter, item, state) {
    const assigned = state.assignments[item.key] || '';
    const pinned = Boolean(state.manualAssignments[item.key]);
    const options = ['<option value="">未分组</option>', ...state.groups.map(group => (
        `<option value="${escapeHtml(group.id)}" ${group.id === assigned ? 'selected' : ''}>${escapeHtml(group.name)}</option>`
    ))].join('');
    return `
        <div class="srg-manager-item ${isManagerItemSelected(adapter, item.key) ? 'current' : ''}">
            <button type="button" class="srg-item-name" data-srg-manager-select="${escapeHtml(item.key)}" title="切换到此条目">${escapeHtml(item.label)}</button>
            <select class="srg-group-select" data-srg-assign="${escapeHtml(item.key)}">${options}</select>
            <span class="srg-pin ${pinned ? 'active' : ''}" title="${pinned ? '手动位置：自动整理会保留' : '自动位置'}"><i class="fa-solid fa-thumbtack"></i></span>
        </div>
    `;
}

function renderManager() {
    const mask = ensureManager();
    const panel = mask.querySelector('.srg-manager');
    const managerAdapters = getManagerAdapters();
    if (!managerAdapters.some(item => item.id === activeAdapterId)) activeAdapterId = managerAdapters[0]?.id || '';
    const adapter = adapters.get(activeAdapterId);
    const tabs = managerAdapters.map(item => `
        <button type="button" class="srg-tab ${item.id === activeAdapterId ? 'active' : ''}" data-srg-tab="${escapeHtml(item.id)}">${escapeHtml(item.managerLabel)}</button>
    `).join('');

    if (!adapter) {
        panel.innerHTML = `
            <header class="srg-manager-header"><div><h2>${DISPLAY_NAME}</h2><small>v${VERSION}</small></div><button type="button" class="srg-close" data-srg-close>×</button></header>
            <div class="srg-empty srg-empty-large">尚未发现可管理的预设、主题或世界书选择器。</div>
        `;
        panel.querySelector('[data-srg-close]')?.addEventListener('click', closeManager);
        return;
    }

    const managerItems = getManagerItems(adapter);
    const { state, buckets, loose } = groupBuckets(adapter, managerSearch, managerItems);
    const searching = Boolean(normalizeName(managerSearch));
    const sections = [];
    for (let index = 0; index < state.groups.length; index++) {
        const group = state.groups[index];
        const items = buckets.get(group.id) || [];
        if (searching && !items.length && !group.name.toLocaleLowerCase().includes(managerSearch.toLocaleLowerCase())) continue;
        const collapsed = searching ? false : state.managerCollapsed[group.id] !== false;
        sections.push(`
            <section class="srg-manager-group ${collapsed ? 'collapsed' : ''}">
                <div class="srg-manager-group-head">
                    <button type="button" class="srg-group-heading" data-srg-manager-toggle="${escapeHtml(group.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                        <span class="srg-chevron">▾</span><i class="fa-solid fa-folder"></i><strong>${escapeHtml(group.name)}</strong><span class="srg-count">${items.length}</span>${group.auto ? '<span class="srg-auto-badge">自动</span>' : ''}
                    </button>
                    <div class="srg-group-actions">
                        <button type="button" class="srg-icon-button" data-srg-up="${escapeHtml(group.id)}" ${index === 0 ? 'disabled' : ''} title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                        <button type="button" class="srg-icon-button" data-srg-down="${escapeHtml(group.id)}" ${index === state.groups.length - 1 ? 'disabled' : ''} title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                        <button type="button" class="srg-icon-button" data-srg-rename="${escapeHtml(group.id)}" title="重命名"><i class="fa-solid fa-pencil"></i></button>
                        <button type="button" class="srg-icon-button danger" data-srg-delete-group="${escapeHtml(group.id)}" title="删除分组（条目保留）"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div class="srg-manager-group-body">${collapsed ? '' : (items.map(item => renderManagerItem(adapter, item, state)).join('') || '<div class="srg-empty">此分组暂无条目</div>')}</div>
            </section>
        `);
    }
    if (loose.length || !state.groups.length) {
        const collapsed = searching ? false : state.managerCollapsed.__loose !== false;
        sections.push(`
            <section class="srg-manager-group loose ${collapsed ? 'collapsed' : ''}">
                <div class="srg-manager-group-head">
                    <button type="button" class="srg-group-heading" data-srg-manager-toggle="__loose" aria-expanded="${collapsed ? 'false' : 'true'}">
                        <span class="srg-chevron">▾</span><i class="fa-solid fa-inbox"></i><strong>未分组</strong><span class="srg-count">${loose.length}</span>
                    </button>
                </div>
                <div class="srg-manager-group-body">${collapsed ? '' : (loose.map(item => renderManagerItem(adapter, item, state)).join('') || '<div class="srg-empty">暂无未分组条目</div>')}</div>
            </section>
        `);
    }

    panel.classList.toggle('compact', Boolean(settings.compactRows));
    panel.innerHTML = `
        <header class="srg-manager-header">
            <div><h2>${DISPLAY_NAME}</h2><small>预设、美化与世界书统一整理 · v${VERSION}</small></div>
            <button type="button" class="srg-close" data-srg-close aria-label="关闭">×</button>
        </header>
        <nav class="srg-tabs">${tabs}</nav>
        <div class="srg-manager-toolbar">
            <input type="search" class="srg-search" data-srg-manager-search placeholder="搜索${escapeHtml(adapter.label)}..." value="${escapeHtml(managerSearch)}">
            <button type="button" class="menu_button" data-srg-smart><i class="fa-solid fa-wand-magic-sparkles"></i><span>智能整理</span></button>
            <button type="button" class="menu_button" data-srg-add-group><i class="fa-solid fa-folder-plus"></i><span>新建分组</span></button>
            <button type="button" class="menu_button danger" data-srg-reset-source title="只清除分组，不删除预设或主题"><i class="fa-solid fa-rotate-left"></i><span>清除分组</span></button>
        </div>
        <div class="srg-manager-summary"><strong>${escapeHtml(adapter.managerLabel)}</strong><span>${managerItems.length} 个条目 · ${state.groups.length} 个分组</span></div>
        <div class="srg-manager-list">${sections.join('') || '<div class="srg-empty srg-empty-large">没有匹配的条目</div>'}</div>
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
    searchInput?.addEventListener('input', event => {
        managerSearch = event.target.value || '';
        renderManager();
        panel.querySelector('[data-srg-manager-search]')?.focus();
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
                <b><i class="fa-solid fa-layer-group"></i> ${DISPLAY_NAME}</b>
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
                    <button type="button" class="menu_button" data-srg-settings-open><i class="fa-solid fa-layer-group"></i><span>打开管理器</span></button>
                    <button type="button" class="menu_button" data-srg-settings-all><i class="fa-solid fa-wand-magic-sparkles"></i><span>整理全部</span></button>
                    <button type="button" class="menu_button" data-srg-export><i class="fa-solid fa-file-export"></i><span>导出分组</span></button>
                    <button type="button" class="menu_button" data-srg-import><i class="fa-solid fa-file-import"></i><span>导入分组</span></button>
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

function injectMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(MENU_ID)) return Boolean(document.getElementById(MENU_ID));
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.textContent = '嘎嘎资源分组';
    item.addEventListener('click', () => openManager());
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') openManager();
    });
    menu.appendChild(item);
    return true;
}

function scanAdapters() {
    if (!settings) return;
    const found = new Map();
    for (const select of document.querySelectorAll('select[data-preset-manager-for], select#themes, select#world_info, select#world_editor_select')) {
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
    document.addEventListener('pointerdown', event => {
        const popover = document.getElementById(POPOVER_ID);
        if (!popover?.classList.contains('open')) return;
        const adapter = adapters.get(activePopoverAdapterId);
        if (!popover.contains(event.target) && !adapter?.trigger?.contains(event.target)) closePopover();
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (document.getElementById(MANAGER_ID)?.classList.contains('open')) closeManager();
        else closePopover();
    });
    window.addEventListener('resize', () => {
        if (activePopoverAdapterId) positionPopover(adapters.get(activePopoverAdapterId));
    });
    window.addEventListener('scroll', event => {
        const popover = document.getElementById(POPOVER_ID);
        const manager = document.getElementById(MANAGER_ID);
        if (popover?.contains(event.target) || manager?.contains(event.target)) return;
        if (activePopoverAdapterId) positionPopover(adapters.get(activePopoverAdapterId));
    }, true);
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
    rootObserver = new MutationObserver(scheduleScan);
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
    document.documentElement.classList.remove('srg-manager-open');
}

window.addEventListener('pagehide', cleanup, { once: true });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.setTimeout(boot, 0), { once: true });
else window.setTimeout(boot, 0);

export { boot as init, cleanup };
