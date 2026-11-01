// Central state with undo/redo, a persistent local draft and save tracking.
//
// Draft safety rules (the old version lost edits here):
//  - every change is written to localStorage immediately, together with the
//    sha of the server version it was based on;
//  - the draft is removed ONLY after a confirmed save or an explicit discard.

const DRAFT_KEY = 'jadwal_draft_v2';
const CACHE_KEY = 'jadwal_cache_v2';
const HISTORY_LIMIT = 50;

const listeners = new Set();

export const store = {
    state: null,        // current (possibly edited) state
    savedJson: null,    // JSON of the last version known to be on the server
    baseSha: null,      // GitHub sha of that version (null = unknown, e.g. loaded from Pages)
    undoStack: [],
    redoStack: [],
    saving: false,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason) { listeners.forEach(fn => { try { fn(reason); } catch (e) { console.error(e); } }); }

// Load a server version as the new baseline (drops undo history)
export function setBaseline(data, sha) {
    store.state = clone(data);
    store.savedJson = JSON.stringify(data);
    store.baseSha = sha || null;
    store.undoStack = [];
    store.redoStack = [];
    emit('load');
}

export function isDirty() {
    return !!store.state && JSON.stringify(store.state) !== store.savedJson;
}

// Run fn(state). If it returns {error}, the state is rolled back and the error returned.
export function mutate(fn, label) {
    const before = JSON.stringify(store.state);
    let result;
    try {
        result = fn(store.state) || { success: true };
    } catch (e) {
        console.error(e);
        result = { error: 'حدث خطأ غير متوقع' };
    }
    if (result && result.error) {
        store.state = JSON.parse(before);
        return result;
    }
    if (JSON.stringify(store.state) === before) return result; // no-op
    store.undoStack.push({ json: before, label: label || '' });
    if (store.undoStack.length > HISTORY_LIMIT) store.undoStack.shift();
    store.redoStack = [];
    saveDraft();
    emit('change');
    return result;
}

export function canUndo() { return store.undoStack.length > 0; }
export function canRedo() { return store.redoStack.length > 0; }

export function undo() {
    const entry = store.undoStack.pop();
    if (!entry) return null;
    store.redoStack.push({ json: JSON.stringify(store.state), label: entry.label });
    store.state = JSON.parse(entry.json);
    saveDraft();
    emit('change');
    return entry.label;
}

export function redo() {
    const entry = store.redoStack.pop();
    if (!entry) return null;
    store.undoStack.push({ json: JSON.stringify(store.state), label: entry.label });
    store.state = JSON.parse(entry.json);
    saveDraft();
    emit('change');
    return entry.label;
}

// Called after a confirmed write to GitHub
export function markSaved(sha) {
    store.savedJson = JSON.stringify(store.state);
    store.baseSha = sha || store.baseSha;
    clearDraft();
    cacheData(store.state);
    emit('saved');
}

export function setSaving(v) { store.saving = v; emit('saving'); }

// Replace the whole state as an undoable edit (e.g. import a backup)
export function replaceState(data, label) {
    return mutate((s) => {
        Object.keys(s).forEach(k => delete s[k]);
        Object.assign(s, clone(data));
    }, label || 'استيراد');
}

// ---------- Local draft ----------
export function saveDraft() {
    try {
        if (!isDirty()) { clearDraft(); return; }
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
            state: store.state,
            baseSha: store.baseSha,
            baseJson: store.savedJson,
            ts: Date.now(),
        }));
    } catch (e) {
        console.warn('draft save failed:', e);
    }
}
export function readDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
export function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

// Restore a draft on top of the current baseline (undo returns to the baseline)
export function applyDraft(draft) {
    store.undoStack.push({ json: JSON.stringify(store.state), label: 'استعادة المسودة' });
    store.redoStack = [];
    store.state = clone(draft.state);
    saveDraft();
    emit('change');
}

// ---------- Offline cache of the last good data (for viewers with no connection) ----------
export function cacheData(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data: data, ts: Date.now() })); } catch (e) {}
}
export function readCache() {
    try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
