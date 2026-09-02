const STOP_KEYS = new Set([
    'preset', 'presets', '预设', '配置', 'config', 'configs', '版本', 'version',
    '新版', '旧版', '最终版', 'final', 'copy', '副本', '备份', 'backup',
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by',
    'template', 'templates', '模板', 'theme', 'themes', '主题', '美化',
]);

const TRAILING_VARIANT_PATTERNS = [
    /\s*[（(\[【]\s*(?:半成品|试吃|测试|试用|草稿|预览|实验|beta|alpha|preview|draft|test|final|stable|nightly|rc\d*|dev)\s*[）)\]】]\s*$/i,
    /(?:\s*[-—–_|｜/／:：]\s*|\s+)(?:半成品|试吃|测试版?|试用版?|草稿版?|预览版?|实验版?|beta|alpha|preview|draft|test|final|stable|nightly|rc\d*|dev)\s*$/i,
    /(?:\s*[-—–_|｜/／:：]?\s*)[（(\[【]?\s*(?:[A-Z]|[甲乙丙丁戊己庚辛壬癸]|第一|第二|第三|第四|第五|第六|第七|第八|第九|第十|一|二|三|四|五|六|七|八|九|十)\s*(?:版|版本)\s*[）)\]】]?\s*$/i,
    /(?:\s*[-—–_|｜/／:：]\s*|\s+)(?:pro|lite|plus|mini|max|standard|classic|experimental|fast|creative|precise)\s*$/i,
    /(?:\s*[-—–_|｜/／:：]\s*|\s+)?(?:v(?:er(?:sion)?)?\.?\s*)?\d+(?:[._-]\d+)+(?:[a-zA-Z]*)\s*$/i,
    /(?:\s*[-—–_|｜/／:：]\s*|\s+)(?:v(?:er(?:sion)?)?\.?\s*)?\d+[a-zA-Z]?\s*$/i,
    /(?:\s*[-—–_|｜/／:：]\s*|\s+)(?:19|20)\d{2}(?:[-._]\d{1,2}){0,2}\s*$/i,
    /\s*[（(\[【]\s*(?:copy|副本|备份)(?:\s*\d+)?\s*[）)\]】]\s*$/i,
];

const BRACKET_PAIRS = {
    '【': '】',
    '[': ']',
    '(': ')',
    '（': '）',
    '{': '}',
    '《': '》',
    '「': '」',
    '『': '』',
    '<': '>',
};

export function normalizeName(value) {
    return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function familyKey(value) {
    return normalizeName(value)
        .toLocaleLowerCase()
        .replace(/[\s【】\[\]()（）{}<>《》「」『』|｜/／\\:_：—–\-·•+]+/g, '')
        .trim();
}

export function closeUnmatchedBrackets(value) {
    const text = String(value ?? '');
    const reverse = Object.fromEntries(Object.entries(BRACKET_PAIRS).map(([open, close]) => [close, open]));
    const stack = [];
    for (const char of text) {
        if (BRACKET_PAIRS[char]) stack.push(char);
        else if (reverse[char] && stack.at(-1) === reverse[char]) stack.pop();
    }
    let result = text;
    while (stack.length) result += BRACKET_PAIRS[stack.pop()];
    return result;
}

function trimTail(value) {
    return String(value ?? '').replace(/[\s\-—–_|｜/／:：·•+]+$/g, '').trim();
}

export function normalizeSeriesBase(value) {
    const original = normalizeName(value);
    if (!original) return { label: '', key: '', units: [], changed: false };

    let text = original;
    let changed = false;
    for (let pass = 0; pass < 10; pass++) {
        let next = text;
        for (const pattern of TRAILING_VARIANT_PATTERNS) next = next.replace(pattern, '');
        next = trimTail(next);
        if (!next || next === text) break;
        text = next;
        changed = true;
    }

    const label = closeUnmatchedBrackets(trimTail(text) || original);
    const comparable = label
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .replace(/[【】\[\]()（）{}<>《》「」『』|｜/／\\:_：—–\-·•+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const units = comparable.match(/[A-Za-z]+|\d+(?:\.\d+)*|[\u3400-\u9fff]/g) || [];

    return {
        label,
        key: familyKey(label),
        units: units.map(unit => unit.toLocaleLowerCase()),
        changed: changed || label !== original,
    };
}

function meaningfulLabel(label) {
    const key = familyKey(label);
    if (!key || STOP_KEYS.has(key) || /^\d+$/.test(key)) return false;
    const cjk = (key.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (key.match(/[a-z]/gi) || []).length;
    return cjk >= 2 || latin >= 4 || (cjk >= 1 && latin >= 2 && key.length >= 4);
}

function labelForUnitPrefix(baseLabel, prefixUnits) {
    if (!prefixUnits.length) return '';
    const wanted = prefixUnits.join('').toLocaleLowerCase();
    let built = '';
    let visibleEnd = 0;
    const source = normalizeName(baseLabel);

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (/[A-Za-z0-9\u3400-\u9fff]/.test(char)) built += char.toLocaleLowerCase();
        visibleEnd = i + 1;
        if (built === wanted) break;
        if (!wanted.startsWith(built)) return prefixUnits.join(' ');
    }

    return closeUnmatchedBrackets(trimTail(source.slice(0, visibleEnd)));
}

function unitsStartWith(units, prefix) {
    if (!prefix.length || units.length < prefix.length) return false;
    return prefix.every((unit, index) => units[index] === unit);
}

function commonUnitPrefix(left, right) {
    const result = [];
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
        if (left[index] !== right[index]) break;
        result.push(left[index]);
    }
    return result;
}

function candidateParts(value) {
    const original = normalizeName(value);
    if (!original) return [];
    const output = [];

    const push = (raw, priority) => {
        const label = closeUnmatchedBrackets(
            String(raw ?? '')
                .replace(/^[\s\-—–_|｜/／:：·•+]+|[\s\-—–_|｜/／:：·•+]+$/g, '')
                .trim(),
        );
        const key = familyKey(label);
        if (!label || label.length > 64 || !meaningfulLabel(label)) return;
        if (/^(?:v?\d+(?:[._-]\d+)*|\d+(?:\.\d+)*)$/i.test(key)) return;
        const existing = output.find(item => item.key === key);
        const candidate = { key, label, priority };
        if (!existing) output.push(candidate);
        else if (priority > existing.priority || (priority === existing.priority && label.length > existing.label.length)) {
            Object.assign(existing, candidate);
        }
    };

    const base = normalizeSeriesBase(original);
    if (base.changed) push(base.label, 240);

    const leadingBracket = original.match(/^\s*([【\[《「『][^】\]》」』]{2,48}[】\]》」』])/);
    if (leadingBracket) push(leadingBracket[1], 195);

    const bracketPatterns = [/【([^】]{2,48})】/g, /\[([^\]]{2,48})\]/g, /《([^》]{2,48})》/g, /「([^」]{2,48})」/g];
    for (const pattern of bracketPatterns) {
        let match;
        while ((match = pattern.exec(original)) !== null) push(match[1], 180);
    }

    const delimiterMatch = original.match(/^(.{2,48}?)(?:\s*[-—–_|｜/／:：]\s*)(.+)$/);
    if (delimiterMatch) push(delimiterMatch[1], 165);

    const prepared = original
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .replace(/[【】\[\]()（）{}<>《》「」『』]/g, ' ')
        .replace(/[|｜/／\\:_：—–\-·•+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = prepared.split(/\s+/).filter(Boolean);
    if (words.length > 1) push(words[0], 115);
    if (words.length > 2) push(words.slice(0, 2).join(' '), 125);

    return output;
}

function addCandidate(candidateMap, label, priority, memberNames) {
    const safeLabel = closeUnmatchedBrackets(trimTail(label));
    const key = familyKey(safeLabel);
    if (!key || !meaningfulLabel(safeLabel)) return;
    let record = candidateMap.get(key);
    if (!record) {
        record = { key, label: safeLabel, priority, names: new Set() };
        candidateMap.set(key, record);
    }
    if (priority > record.priority) record.priority = priority;
    if (safeLabel.length > record.label.length && safeLabel.length <= 64) record.label = safeLabel;
    for (const name of memberNames) record.names.add(name);
}

/**
 * Infer non-overlapping name families.
 * @param {string[]} values visible item names
 * @param {{minGroupSize?: number}} options grouping options
 * @returns {{label: string, key: string, names: string[], confidence: number}[]}
 */
export function inferGroups(values, options = {}) {
    const minGroupSize = Math.max(2, Number(options.minGroupSize) || 2);
    const names = [...new Set(values.map(normalizeName).filter(Boolean))];
    const profiles = names.map(name => {
        const base = normalizeSeriesBase(name);
        return { name, label: base.label || name, units: base.units, candidates: candidateParts(name) };
    });
    const candidateMap = new Map();
    const indexedCandidates = new Map();

    for (const profile of profiles) {
        for (const candidate of profile.candidates) {
            let indexed = indexedCandidates.get(candidate.key);
            if (!indexed) {
                indexed = { label: candidate.label, priority: candidate.priority, names: new Set() };
                indexedCandidates.set(candidate.key, indexed);
            }
            indexed.names.add(profile.name);
            if (candidate.priority > indexed.priority) indexed.priority = candidate.priority;
            if (candidate.label.length > indexed.label.length && candidate.label.length <= 64) indexed.label = candidate.label;
        }
    }
    for (const indexed of indexedCandidates.values()) {
        addCandidate(candidateMap, indexed.label, indexed.priority, indexed.names);
    }

    const sharedPrefixes = new Map();
    for (let leftIndex = 0; leftIndex < profiles.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex++) {
            const prefix = commonUnitPrefix(profiles[leftIndex].units, profiles[rightIndex].units);
            if (!prefix.length) continue;
            const prefixKey = prefix.join('\u0001');
            let shared = sharedPrefixes.get(prefixKey);
            if (!shared) {
                shared = { prefix, leftIndices: new Set() };
                sharedPrefixes.set(prefixKey, shared);
            }
            shared.leftIndices.add(leftIndex);
        }
    }
    for (const { prefix, leftIndices } of sharedPrefixes.values()) {
        const matching = profiles.filter(profile => unitsStartWith(profile.units, prefix)).map(profile => profile.name);
        const labels = new Map();
        for (const leftIndex of leftIndices) {
            const label = labelForUnitPrefix(profiles[leftIndex].label, prefix);
            const key = familyKey(label);
            const current = labels.get(key);
            if (!current || label.length > current.length) labels.set(key, label);
        }
        for (const label of labels.values()) {
            addCandidate(candidateMap, label, 150 + Math.min(prefix.length, 20), matching);
        }
    }

    const candidates = [...candidateMap.values()]
        .filter(record => record.names.size >= minGroupSize)
        .sort((left, right) => {
            const sizeDelta = right.names.size - left.names.size;
            if (sizeDelta) return sizeDelta;
            const priorityDelta = right.priority - left.priority;
            if (priorityDelta) return priorityDelta;
            return familyKey(right.label).length - familyKey(left.label).length;
        });

    const remaining = new Set(names);
    const result = [];
    for (const candidate of candidates) {
        const members = [...candidate.names].filter(name => remaining.has(name));
        if (members.length < minGroupSize) continue;
        result.push({
            label: candidate.label,
            key: candidate.key,
            names: members,
            confidence: Math.min(1, 0.5 + candidate.priority / 500 + members.length / 50),
        });
        for (const member of members) remaining.delete(member);
    }

    return result;
}

export function groupMapFromInference(values, options = {}) {
    const mapping = new Map();
    for (const group of inferGroups(values, options)) {
        for (const name of group.names) mapping.set(name, group.label);
    }
    return mapping;
}
