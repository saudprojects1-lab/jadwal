// Admin mode: login, save/sync with GitHub, cell editing, and the management drawer.

import {
    store, mutate, undo, redo, canUndo, canRedo, isDirty, setBaseline, markSaved, setSaving,
    readDraft, clearDraft, applyDraft, replaceState
} from './store.js';
import * as S from './scheduler.js';
import { verifyPassword, hasValidSession, clearSession, makeAuth, setSession } from './auth.js';
import { fetchRemote, saveRemote, getToken, setToken, isConflict, siteUrl } from './github.js';
import { toast, modal, confirmDialog, alertDialog, formDialog, el, esc, bindTap, closeTopModal, hasOpenModal } from './ui.js';
import { pillStyle } from './render.js';
import {
    upcomingIndex, parseGreg, formatGreg, toHijri, fromIsoInput, toIsoInput, suggestNextDate, formatTime, isFriday
} from './dates.js';

const $ = (id) => document.getElementById(id);

let ctx = null;          // { view, renderView, setActive }
let currentTab = 'items';
let drawerOpen = false;

// ======================================================================
// Entry / login
// ======================================================================
export function initAdmin(context) {
    ctx = context;

    bindTap($('adminEntry'), (e) => {
        e.preventDefault();
        if (ctx.view.admin) openDrawer();
        else if (hasValidSession(store.state.auth)) enterAdmin();
        else openLogin();
    });
    $('undoBtn').addEventListener('click', doUndo);
    $('redoBtn').addEventListener('click', doRedo);
    $('saveBtn').addEventListener('click', saveNow);
    $('openDrawerBtn').addEventListener('click', () => openDrawer());
    $('issuesBtn').addEventListener('click', () => openDrawer('distribute'));
    $('logoutBtn').addEventListener('click', exitAdmin);
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    $('drawerTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) { currentTab = b.getAttribute('data-tab'); renderDrawer(); $('drawerBody').scrollTop = 0; }
    });

    // Tap on a pill (admin mode) → cell editor
    document.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-cell]');
        if (!cell || !ctx.view.admin) return;
        e.preventDefault();
        openCellEditor(parseInt(cell.getAttribute('data-n'), 10), cell.getAttribute('data-person'));
    });

    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', (e) => {
        if (ctx.view.admin && isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    if (hasValidSession(store.state.auth)) enterAdmin();
    else if (location.hash === '#admin') openLogin();

    return { onRender: onRender };
}

function openLogin() {
    if (!store.state.auth || !store.state.auth.hash) {
        alertDialog('بيانات الدخول غير متوفرة في ملف البيانات.');
        return;
    }
    const input = el('input', { type: 'password', class: 'login-input', placeholder: 'كلمة المرور', autocomplete: 'current-password' });
    const toggle = el('button', {
        type: 'button', class: 'login-toggle', 'aria-label': 'إظهار كلمة المرور', text: '👁',
        onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; input.focus(); }
    });
    const body = el('div', { class: 'login-body' }, [
        el('div', { class: 'login-icon', text: '🔐' }),
        el('p', { class: 'login-hint', text: 'أدخلي كلمة مرور المدير للمتابعة' }),
        el('div', { class: 'login-field' }, [input, toggle]),
    ]);
    let submitting = false;
    const submit = (api) => {
        if (submitting) return false;
        if (!input.value) { input.focus(); return { error: 'أدخلي كلمة المرور' }; }
        submitting = true;
        const ok = verifyPassword(store.state.auth, input.value);
        submitting = false;
        if (!ok) {
            input.value = '';
            input.focus();
            return { error: 'كلمة المرور غير صحيحة — حاولي مرة أخرى' };
        }
        setTimeout(enterAdmin, 0);
        return true;
    };
    modal({
        title: 'دخول المدير',
        body: body,
        onOpen: (api) => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const r = submit(api);
                    if (r && r.error) api.showError(r.error);
                    else if (r === true) api.close(true);
                }
            });
        },
        actions: [
            { label: 'إلغاء', kind: 'secondary', value: null },
            { label: 'دخول', kind: 'primary', onClick: submit },
        ]
    });
}

async function enterAdmin() {
    ctx.view.admin = true;
    document.body.classList.add('admin-active');
    $('adminBar').hidden = false;
    ctx.renderView();
    await syncFromServer({ silent: true });
    handleDraftOnEntry();
    updateBar();
}

async function exitAdmin() {
    if (isDirty()) {
        const ok = await confirmDialog('لديك تعديلات غير محفوظة على GitHub. ستبقى محفوظة كمسودة على هذا الجهاز وتُستعاد عند الدخول مرة أخرى.',
            { title: 'خروج من وضع المدير', ok: 'خروج' });
        if (!ok) return;
    }
    clearSession();
    ctx.view.admin = false;
    document.body.classList.remove('admin-active');
    $('adminBar').hidden = true;
    $('draftBanner').hidden = true;
    closeDrawer();
    if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
    ctx.renderView();
}

// ======================================================================
// Sync with GitHub
// ======================================================================
function publishCfg() {
    const p = store.state.publish || {};
    return { owner: p.owner || '', repo: p.repo || '', branch: p.branch || 'main', path: p.path || 'data.json' };
}

// Load the authoritative latest version straight from the GitHub API (no Pages cache).
async function syncFromServer(opts) {
    opts = opts || {};
    const token = getToken();
    const cfg = publishCfg();
    if (!token || !cfg.owner || !cfg.repo) {
        if (!opts.silent) toast('أضيفي رمز GitHub في «الحفظ والإعدادات» أولاً', { kind: 'warn' });
        return false;
    }
    try {
        const remote = await fetchRemote(cfg, token);
        if (remote.data) {
            const data = S.normalizeState(remote.data);
            if (opts.replace || !isDirty()) {
                setBaseline(data, remote.sha);
            } else {
                // keep local edits; just learn the server baseline
                store.baseSha = remote.sha;
                store.savedJson = JSON.stringify(data);
            }
        } else {
            store.baseSha = null;
        }
        if (!opts.silent) toast('تم تحميل أحدث نسخة من GitHub ✓', { kind: 'success' });
        updateBar();
        return true;
    } catch (err) {
        console.error('sync failed:', err);
        toast('تعذّر قراءة النسخة الأحدث من GitHub: ' + err.message, { kind: 'error', duration: 6000 });
        return false;
    }
}

function handleDraftOnEntry() {
    const draft = readDraft();
    const banner = $('draftBanner');
    banner.hidden = true;
    if (!draft || !draft.state) return;
    if (JSON.stringify(draft.state) === store.savedJson) { clearDraft(); return; }

    const when = formatTime(draft.ts);
    if (draft.baseJson === store.savedJson) {
        // Same base → restore automatically
        applyDraft(draft);
        showBanner('تمت استعادة تعديلاتك غير المحفوظة (' + when + '). اضغطي «حفظ» لنشرها.', [
            { label: 'تجاهل المسودة', kind: 'secondary', onClick: async () => {
                if (!await confirmDialog('سيتم حذف التعديلات غير المحفوظة والرجوع لآخر نسخة منشورة.', { danger: true, ok: 'تجاهل' })) return;
                setBaseline(JSON.parse(store.savedJson), store.baseSha);
                clearDraft();
                banner.hidden = true;
            } },
            { label: 'حسناً', kind: 'primary', onClick: () => { banner.hidden = true; } },
        ]);
    } else {
        // The published version changed since this draft was made
        showBanner('⚠ توجد مسودة على هذا الجهاز (' + when + ') لكن الجدول المنشور تغيّر بعدها. استعادتها ستستبدل التغييرات الأحدث.', [
            { label: 'تجاهل المسودة', kind: 'secondary', onClick: () => { clearDraft(); banner.hidden = true; } },
            { label: 'استعادة المسودة', kind: 'primary', onClick: () => { applyDraft(draft); banner.hidden = true; } },
        ], 'warn');
    }
}

function showBanner(text, actions, kind) {
    const banner = $('draftBanner');
    banner.className = 'draft-banner' + (kind ? ' ' + kind : '');
    banner.innerHTML = '';
    banner.appendChild(el('span', { text: text }));
    const box = el('span', { class: 'draft-actions' });
    actions.forEach(a => box.appendChild(el('button', { type: 'button', class: 'btn small ' + a.kind, text: a.label, onclick: a.onClick })));
    banner.appendChild(box);
    banner.hidden = false;
}

async function saveNow() {
    if (store.saving) return;
    if (!isDirty() && store.baseSha) { toast('لا توجد تعديلات جديدة — كل شيء محفوظ ✓', { kind: 'success' }); return; }
    const token = getToken();
    const cfg = publishCfg();
    if (!token || !cfg.owner || !cfg.repo) {
        openDrawer('settings');
        toast('أدخلي رمز الوصول (Token) لحفظ التعديلات على الموقع', { kind: 'warn', duration: 5000 });
        return;
    }
    const issues = S.relevantIssues(store.state);
    if (issues.length) {
        const ok = await confirmDialog('يوجد ' + issues.length + ' ملاحظة في التوزيع (تكرار أو أعداد غير متطابقة). هل تريدين الحفظ رغم ذلك؟',
            { title: 'حفظ مع وجود ملاحظات', ok: 'حفظ على أي حال' });
        if (!ok) { openDrawer('distribute'); return; }
    }

    setSaving(true);
    updateBar();
    try {
        let sha = store.baseSha;
        if (!sha) {
            // Loaded from the public site — find the current sha and make sure nobody saved since
            const remote = await fetchRemote(cfg, token);
            if (remote.data && JSON.stringify(S.normalizeState(remote.data)) !== store.savedJson) {
                setSaving(false);
                return resolveConflict(cfg, token, remote);
            }
            sha = remote.sha;
        }
        const res = await saveRemote(cfg, token, store.state, sha, commitMessage());
        markSaved(res.sha);
        $('draftBanner').hidden = true;
        toast('تم الحفظ والنشر ✓ — يظهر للجميع خلال دقيقة تقريباً', {
            kind: 'success', duration: 5000,
            action: { label: 'فتح الموقع', onClick: () => window.open(siteUrl(cfg), '_blank', 'noopener') }
        });
    } catch (err) {
        console.error('save failed:', err);
        if (isConflict(err)) {
            setSaving(false);
            try { return resolveConflict(cfg, token, await fetchRemote(cfg, token)); }
            catch (e) { toast(e.message, { kind: 'error' }); }
        } else {
            toast('لم يتم الحفظ: ' + err.message + ' — تعديلاتك محفوظة على هذا الجهاز', { kind: 'error', duration: 7000 });
        }
    } finally {
        setSaving(false);
        updateBar();
    }
}

function commitMessage() {
    const labels = store.undoStack.map(e => e.label).filter(Boolean);
    const uniq = Array.from(new Set(labels)).slice(-5);
    return 'تحديث جدول الضيافة' + (uniq.length ? ': ' + uniq.join('، ') : '');
}

async function resolveConflict(cfg, token, remote) {
    const choice = await modal({
        title: 'تم تعديل الجدول من جهاز آخر',
        body: el('p', { class: 'modal-text', text: 'تم حفظ نسخة أحدث على GitHub بعد أن بدأتِ التعديل. ماذا تريدين أن تفعلي؟' }),
        actions: [
            { label: 'إلغاء', kind: 'secondary', value: null },
            { label: 'تحميل النسخة الأحدث (تُفقد تعديلاتي)', kind: 'secondary', value: 'theirs' },
            { label: 'استبدالها بنسختي', kind: 'danger', value: 'mine' },
        ]
    });
    if (choice === 'theirs') {
        setBaseline(S.normalizeState(remote.data), remote.sha);
        clearDraft();
        toast('تم تحميل النسخة الأحدث', { kind: 'success' });
    } else if (choice === 'mine') {
        store.baseSha = remote.sha;
        store.savedJson = remote.data ? JSON.stringify(S.normalizeState(remote.data)) : null;
        return saveNow();
    }
}

// ======================================================================
// Admin bar + keyboard
// ======================================================================
function onRender(issues) {
    if (!ctx.view.admin) return;
    updateBar(issues);
    if (drawerOpen) renderDrawer();
}

function updateBar(issues) {
    if (!ctx.view.admin) return;
    issues = issues || ctx.view.issues || [];
    const st = $('saveState');
    const txt = $('saveText');
    if (store.saving) { st.dataset.state = 'saving'; txt.textContent = 'جارٍ الحفظ…'; }
    else if (isDirty()) { st.dataset.state = 'dirty'; txt.textContent = 'تعديلات غير محفوظة'; }
    else { st.dataset.state = 'clean'; txt.textContent = store.baseSha ? 'محفوظ ✓' : 'محفوظ'; }
    $('undoBtn').disabled = !canUndo();
    $('redoBtn').disabled = !canRedo();
    $('saveBtn').disabled = store.saving;
    $('saveBtn').classList.toggle('pulse', isDirty());
    $('issuesBtn').hidden = issues.length === 0;
    $('issuesCount').textContent = issues.length;
}

function doUndo() {
    const label = undo();
    if (label != null) toast('تم التراجع' + (label ? ': ' + label : ''));
}
function doRedo() {
    const label = redo();
    if (label != null) toast('تمت الإعادة' + (label ? ': ' + label : ''));
}

function onKey(e) {
    if (e.key === 'Escape') {
        if (closeTopModal()) return;
        if (drawerOpen) closeDrawer();
        return;
    }
    if (!ctx.view.admin) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const typing = /^(input|textarea|select)$/i.test((e.target && e.target.tagName) || '');
    if (k === 's') { e.preventDefault(); saveNow(); }
    else if (typing || hasOpenModal()) return;
    else if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
}

// Mutate + feedback toast with "undo"
function act(fn, label, okMsg) {
    const r = mutate(fn, label);
    if (r && r.error) { toast(r.error, { kind: 'error' }); return r; }
    if (okMsg) toast(okMsg, { kind: 'success', action: { label: 'تراجع', onClick: doUndo } });
    return r;
}

// Same, for dialogs: errors are returned (shown inside the dialog) instead of toasted
function actForm(fn, label, okMsg) {
    const r = mutate(fn, label);
    if (r && r.error) return r;
    if (okMsg) toast(okMsg, { kind: 'success', action: { label: 'تراجع', onClick: doUndo } });
    return r;
}

// "أخذته قبل N أشهر" when the item falls inside the spacing window
function recentNote(s, idx, person, itemName) {
    const t = parseGreg(s.schedule[idx].date.greg);
    if (!t) return null;
    const win = S.getRepeatMonths(s) * 30.44;
    let best = null;
    s.schedule.forEach((m, j) => {
        if (j === idx || m.assignment[person] !== itemName) return;
        const d = parseGreg(m.date.greg);
        if (!d) return;
        const gap = Math.abs(t - d) / 86400000;
        if (gap < win && (best == null || gap < best)) best = gap;
    });
    return best == null ? null : el('span', { class: 'cell-recent', text: '⏱ لها نفس البند قبل/بعد ' + Math.max(1, Math.round(best / 30.44)) + ' شهر' });
}

// ======================================================================
// Cell editor
// ======================================================================
function openCellEditor(n, person) {
    const s = store.state;
    const idx = s.schedule.findIndex(m => m.date.n === n);
    if (idx === -1) return;
    const month = s.schedule[idx];
    const current = month.assignment[person];
    const title = person + ' · ' + month.date.greg;

    if (person === s.fixedPerson) {
        alertDialog(person + ' ثابتة دائماً على «' + s.fixedItem + '».', title);
        return;
    }

    const counts = S.itemCountsForMonth(s, month);
    const prevItem = idx > 0 ? s.schedule[idx - 1].assignment[person] : null;
    const nextItem = idx < s.schedule.length - 1 ? s.schedule[idx + 1].assignment[person] : null;

    const body = el('div', { class: 'cell-editor' });
    body.appendChild(el('p', { class: 'cell-context', html:
        'البند الحالي: <span class="pill" style="' + pillStyle((S.findItem(s, current) || {}).color) + '">' + esc(current || '—') + '</span>' +
        (prevItem ? '<br><small>الجمعة السابقة: ' + esc(prevItem) + '</small>' : '') +
        (nextItem ? '<br><small>الجمعة التالية: ' + esc(nextItem) + '</small>' : '')
    }));
    body.appendChild(el('p', { class: 'cell-help', text: 'اختاري الشخص الذي تريدين التبديل معه — التبديل يحافظ على أعداد البنود. أو «تعيين فقط» لتغيير البند دون تبديل.' }));

    let closeModal = null;
    S.getRotatingItems(s).forEach(it => {
        if (it.name === current) return;
        const repeat = S.wouldRepeat(s, idx, person, it.name);
        const group = el('div', { class: 'cell-group' + (repeat ? ' has-warn' : '') });
        const head = el('div', { class: 'cell-group-head' }, [
            el('span', { class: 'pill', style: pillStyle(it.color), text: it.name }),
            el('span', { class: 'cell-count' + (counts[it.name] !== it.slots ? ' bad' : ''), text: (counts[it.name] || 0) + ' / ' + it.slots }),
            repeat ? el('span', { class: 'cell-warn', text: '⚠ تكرار مع جمعة مجاورة' })
                : recentNote(s, idx, person, it.name),
        ]);
        group.appendChild(head);
        const chips = el('div', { class: 'cell-chips' });
        Object.keys(month.assignment).filter(p => month.assignment[p] === it.name && p !== s.fixedPerson).forEach(other => {
            // after swap: person gets it.name, other gets current
            const bad = repeat || S.wouldRepeat(s, idx, other, current);
            chips.appendChild(el('button', {
                type: 'button', class: 'chip' + (bad ? ' warn' : ''), title: bad ? 'سينتج عنه تكرار' : '',
                text: '⇄ ' + other + (bad ? ' ⚠' : ''),
                onclick: () => {
                    act(st => S.swapAssignment(st, n, person, other), 'تبديل ' + person + ' مع ' + other,
                        'تم التبديل: ' + person + ' ⇄ ' + other);
                    closeModal && closeModal();
                }
            }));
        });
        chips.appendChild(el('button', {
            type: 'button', class: 'chip ghost', text: 'تعيين فقط',
            onclick: () => {
                act(st => S.setAssignment(st, n, person, it.name), 'تغيير بند ' + person,
                    'تم التغيير — تحقّقي من أعداد البنود في هذه الجمعة');
                closeModal && closeModal();
            }
        }));
        group.appendChild(chips);
        body.appendChild(group);
    });

    modal({
        title: title, body: body, sheet: true, wide: true, noAutofocus: true,
        onOpen: (api) => { closeModal = () => api.close(true); },
        actions: [{ label: 'إغلاق', kind: 'secondary', value: null }]
    });
}

// ======================================================================
// Drawer
// ======================================================================
function openDrawer(tab) {
    if (tab) currentTab = tab;
    drawerOpen = true;
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerBackdrop').classList.add('show');
    document.body.classList.add('drawer-open');
    renderDrawer();
}
function closeDrawer() {
    drawerOpen = false;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerBackdrop').classList.remove('show');
    document.body.classList.remove('drawer-open');
}

function renderDrawer() {
    $('drawerTabs').querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === currentTab));
    const body = $('drawerBody');
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const render = { items: tabItems, people: tabPeople, dates: tabDates, distribute: tabDistribute, content: tabContent, settings: tabSettings }[currentTab];
    body.appendChild(render());
    body.scrollTop = scroll;
}

function section(title, children, opts) {
    opts = opts || {};
    return el('section', { class: 'd-section' + (opts.danger ? ' danger' : '') }, [
        title ? el('h3', { text: title }) : null,
        opts.help ? el('p', { class: 'd-help', text: opts.help }) : null,
    ].concat(children));
}

function iconBtn(label, title, onClick, cls) {
    return el('button', {
        type: 'button', class: 'icon-btn ' + (cls || ''), title: title, 'aria-label': title, text: label,
        disabled: cls === 'disabled', onclick: onClick
    });
}

function startIdx() {
    const up = upcomingIndex(store.state.schedule);
    return up === -1 ? store.state.schedule.length : up;
}

function dateOptions(fromDefault) {
    return store.state.schedule.map((m, i) => ({ value: i, label: (i + 1) + ' · ' + m.date.greg + (i < startIdx() ? ' (مضت)' : '') }));
}

// ---------- Tab: items ----------
function totalsBar() {
    const s = store.state;
    const slots = s.items.reduce((a, it) => a + (it.slots || 0), 0);
    const ok = slots === s.people.length;
    return el('div', { class: 'totals ' + (ok ? 'ok' : 'bad') }, [
        el('span', { html: 'مجموع الأماكن في كل جمعة: <b>' + slots + '</b>' }),
        el('span', { html: 'عدد الأشخاص: <b>' + s.people.length + '</b>' }),
        el('span', { class: 'totals-state', text: ok ? '✓ متطابق' : (slots > s.people.length ? '▲ زيادة ' + (slots - s.people.length) : '▼ نقص ' + (s.people.length - slots)) })
    ]);
}

function tabItems() {
    const s = store.state;
    const list = el('ul', { class: 'd-list items-list' });
    s.items.forEach((it, i) => {
        const swatch = el('button', {
            type: 'button', class: 'swatch', title: 'تغيير اللون', style: pillStyle(it.color), text: '🎨',
            onclick: () => pickColor(it)
        });
        const stepper = it.fixed
            ? el('span', { class: 'slots-fixed', text: it.slots + ' 🔒' })
            : el('span', { class: 'stepper' }, [
                iconBtn('−', 'إنقاص', () => act(st => S.setItemSlots(st, it.name, Math.max(0, it.slots - 1)), 'عدد ' + it.name)),
                el('input', {
                    type: 'number', min: 0, max: 99, value: it.slots, class: 'slots-input', 'aria-label': 'عدد الأشخاص',
                    onchange: (e) => act(st => S.setItemSlots(st, it.name, parseInt(e.target.value, 10)), 'عدد ' + it.name)
                }),
                iconBtn('+', 'زيادة', () => act(st => S.setItemSlots(st, it.name, it.slots + 1), 'عدد ' + it.name)),
            ]);
        list.appendChild(el('li', { class: 'd-row' }, [
            swatch,
            el('span', { class: 'd-name' }, [el('span', { class: 'pill', style: pillStyle(it.color), text: it.name })]),
            stepper,
            el('span', { class: 'd-actions' }, [
                iconBtn('✎', 'إعادة تسمية', () => renameItemDialog(it.name)),
                iconBtn('↑', 'تحريك للأعلى', () => act(st => S.moveItem(st, it.name, -1), 'ترتيب البنود'), i === 0 ? 'disabled' : ''),
                iconBtn('↓', 'تحريك للأسفل', () => act(st => S.moveItem(st, it.name, 1), 'ترتيب البنود'), i === s.items.length - 1 ? 'disabled' : ''),
                it.fixed ? null : iconBtn('🗑', 'حذف', () => deleteItemDialog(it.name), 'danger'),
            ])
        ]));
    });

    const issues = ctx.view.issues || [];
    const slots = s.items.reduce((a, it) => a + it.slots, 0);
    const children = [totalsBar(), list,
        el('button', { type: 'button', class: 'btn primary block', text: '+ إضافة بند', onclick: addItemDialog })];
    if (slots === s.people.length && issues.some(x => x.type === 'count')) {
        children.splice(1, 0, el('div', { class: 'callout' }, [
            el('span', { text: 'تغيّرت الأعداد — الجمعات القادمة تحتاج إعادة موازنة.' }),
            el('button', { type: 'button', class: 'btn small primary', text: '⚡ إصلاح الجمعات القادمة', onclick: () => runAutoFix(startIdx()) })
        ]));
    }
    return section('البنود وأعداد الأشخاص', children, {
        help: 'غيّري عدد الأشخاص لكل بند بأزرار − / +. يجب أن يساوي مجموع الأماكن عدد الأشخاص، ثم استخدمي «إصلاح» لإعادة موازنة الجمعات القادمة فقط.'
    });
}

function renameItemDialog(name) {
    formDialog({
        title: 'إعادة تسمية البند',
        fields: [{ name: 'name', label: 'الاسم الجديد', value: name }],
        submit: (v) => actForm(st => S.renameItem(st, name, v.name), 'تسمية ' + v.name.trim())
    });
}

function addItemDialog() {
    const s = store.state;
    formDialog({
        title: 'إضافة بند جديد',
        fields: [
            { name: 'name', label: 'اسم البند', placeholder: 'مثال: عصير' },
            { name: 'slots', label: 'عدد الأشخاص في كل جمعة', type: 'number', value: 1, min: 0 },
        ],
        submit: (v) => actForm(st => S.addItem(st, v.name, v.slots, S.PALETTE[(s.items.length + 3) % S.PALETTE.length]),
            'إضافة بند ' + v.name.trim(), 'تمت إضافة البند — عدّلي الأعداد ثم «إصلاح الجمعات القادمة»')
    });
}

async function deleteItemDialog(name) {
    const s = store.state;
    let used = 0;
    s.schedule.forEach(m => { for (const p in m.assignment) if (m.assignment[p] === name) used++; });
    if (!used) {
        if (await confirmDialog('حذف البند «' + name + '»؟', { danger: true, ok: 'حذف' })) act(st => S.deleteItemMoving(st, name), 'حذف ' + name, 'تم حذف البند');
        return;
    }
    formDialog({
        title: 'حذف البند «' + name + '»',
        danger: true, submitLabel: 'حذف ونقل',
        fields: [{
            name: 'to', label: 'هذا البند معيَّن ' + used + ' مرة. انقلي أصحابه إلى:', type: 'select',
            options: S.getRotatingItems(s).filter(it => it.name !== name).map(it => ({ value: it.name, label: it.name }))
        }],
        submit: (v) => actForm(st => S.deleteItemMoving(st, name, v.to), 'حذف ' + name, 'تم الحذف ونقل ' + used + ' تعيين')
    });
}

function deriveColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mix = (k) => '#' + [r, g, b].map(c => Math.round(c * k).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { bg: hex.toUpperCase(), border: mix(0.78), fg: mix(0.3) };
}

function pickColor(item) {
    const grid = el('div', { class: 'palette' });
    let close = null;
    S.PALETTE.forEach(c => {
        grid.appendChild(el('button', {
            type: 'button', class: 'pill palette-swatch', style: pillStyle(c), text: item.name,
            onclick: () => { act(st => S.setItemColor(st, item.name, c), 'لون ' + item.name); close && close(); }
        }));
    });
    const custom = el('input', { type: 'color', value: (item.color && item.color.bg) || '#EEEEEE' });
    const body = el('div', {}, [grid, el('label', { class: 'field inline' }, [el('span', { class: 'field-label', text: 'لون مخصص:' }), custom])]);
    custom.addEventListener('change', () => { act(st => S.setItemColor(st, item.name, deriveColor(custom.value)), 'لون ' + item.name); close && close(); });
    modal({ title: 'لون «' + item.name + '»', body: body, onOpen: (api) => { close = () => api.close(true); }, noAutofocus: true,
        actions: [{ label: 'إغلاق', kind: 'secondary', value: null }] });
}

// ---------- Tab: people ----------
function tabPeople() {
    const s = store.state;
    const list = el('ul', { class: 'd-list' });
    s.people.forEach((p, i) => {
        const fixed = p === s.fixedPerson;
        list.appendChild(el('li', { class: 'd-row' }, [
            el('span', { class: 'd-num', text: i + 1 }),
            el('span', { class: 'd-name', text: p + (fixed ? ' 🔒' : '') }),
            el('span', { class: 'd-actions' }, [
                iconBtn('✎', 'تعديل الاسم', () => renamePersonDialog(p)),
                iconBtn('↑', 'تحريك للأعلى', () => act(st => S.movePerson(st, p, -1), 'ترتيب الأشخاص'), i === 0 ? 'disabled' : ''),
                iconBtn('↓', 'تحريك للأسفل', () => act(st => S.movePerson(st, p, 1), 'ترتيب الأشخاص'), i === s.people.length - 1 ? 'disabled' : ''),
                fixed ? null : iconBtn('🗑', 'حذف', async () => {
                    if (!await confirmDialog('حذف «' + p + '» من جميع الجمعات؟ سيُنقص عدد بندها الأكثر تكراراً بواحد.', { danger: true, ok: 'حذف' })) return;
                    act(st => S.deletePerson(st, p), 'حذف ' + p, 'تم حذف ' + p);
                }, 'danger'),
            ])
        ]));
    });
    return section('الأشخاص (' + s.people.length + ')', [
        totalsBar(), list,
        el('button', { type: 'button', class: 'btn primary block', text: '+ إضافة شخص', onclick: addPersonDialog })
    ], { help: 'الترتيب هنا هو ترتيب الظهور في الجدول. عند الإضافة يُزاد عدد البند المختار تلقائياً ويوزَّع الشخص على الجمعات القادمة فقط (الجمعات التي مضت لا تتغير).' });
}

function renamePersonDialog(name) {
    formDialog({
        title: 'تعديل الاسم',
        fields: [{ name: 'name', label: 'الاسم', value: name }],
        submit: (v) => actForm(st => S.renamePerson(st, name, v.name), 'تسمية ' + v.name.trim())
    });
}

function addPersonDialog() {
    const s = store.state;
    const itemOpts = S.getRotatingItems(s).map(it => ({ value: it.name, label: it.name + ' (' + it.slots + ' ← ' + (it.slots + 1) + ')' }));
    itemOpts.push({ value: '__new__', label: '+ بند جديد…' });
    formDialog({
        title: 'إضافة شخص',
        fields: [
            { name: 'name', label: 'الاسم', placeholder: 'مثال: سارة (أم خالد)' },
            {
                name: 'item', label: 'البند الأساسي (يُزاد عدده بواحد)', type: 'select', options: itemOpts, value: itemOpts[0] && itemOpts[0].value,
                onInput: (v, inputs, form) => {
                    form.querySelector('[data-field="newItem"]').classList.toggle('is-hidden', v.item !== '__new__');
                }
            },
            { name: 'newItem', label: 'اسم البند الجديد', hidden: true },
            {
                name: 'position', label: 'الموضع في القائمة', type: 'select', value: 'end',
                options: [{ value: 'end', label: 'في النهاية' }].concat(s.people.map(p => ({ value: p, label: 'بعد ' + p })))
            },
        ],
        submit: (v) => {
            const isNew = v.item === '__new__';
            return actForm(st => S.addPersonFrom(st, v.name, isNew ? v.newItem : v.item, v.position, isNew, 1, startIdx()),
                'إضافة ' + v.name.trim(), 'تمت إضافة ' + v.name.trim() + ' وتوزيعها على الجمعات');
        }
    });
}

// ---------- Tab: dates ----------
function tabDates() {
    const s = store.state;
    const up = upcomingIndex(s.schedule);
    const list = el('ul', { class: 'd-list' });
    s.schedule.forEach((m, i) => {
        const tag = i === up ? el('span', { class: 'month-badge upcoming', text: 'القادمة' })
            : (up === -1 || i < up) ? el('span', { class: 'month-badge past', text: 'مضت' }) : null;
        list.appendChild(el('li', { class: 'd-row' }, [
            el('span', { class: 'd-num', text: i + 1 }),
            el('span', { class: 'd-name' }, [
                el('b', { text: m.date.greg + ' م' }), el('small', { text: ' · ' + m.date.hijri + ' هـ ' }), tag
            ]),
            el('span', { class: 'd-actions' }, [
                iconBtn('👁', 'عرض', () => { closeDrawer(); ctx.setActive(i); const sec = document.getElementById('m' + m.date.n); if (sec) sec.scrollIntoView({ behavior: 'smooth' }); }),
                iconBtn('✎', 'تعديل', () => dateDialog(m)),
                iconBtn('🗑', 'حذف', async () => {
                    if (!await confirmDialog('حذف جمعة ' + m.date.greg + '؟', { danger: true, ok: 'حذف' })) return;
                    act(st => S.deleteDate(st, m.date.n), 'حذف ' + m.date.greg, 'تم حذف الجمعة');
                }, 'danger'),
            ])
        ]));
    });
    return section('التواريخ (' + s.schedule.length + ')', [
        list,
        el('button', { type: 'button', class: 'btn primary block', text: '+ إضافة جمعة', onclick: () => dateDialog(null) })
    ], { help: 'اختاري التاريخ الميلادي من التقويم ويُحسب الهجري تلقائياً (أم القرى). الجمعة الجديدة توزَّع تلقائياً دون تكرار مع ما قبلها وما بعدها.' });
}

function dateDialog(month) {
    const s = store.state;
    const initial = month ? parseGreg(month.date.greg) : suggestNextDate(s.schedule);
    formDialog({
        title: month ? 'تعديل التاريخ' : 'إضافة جمعة جديدة',
        fields: [
            {
                name: 'date', label: 'التاريخ الميلادي', type: 'date', value: initial ? toIsoInput(initial) : '', hint: ' ',
                onInput: (v, inputs, form) => {
                    const d = fromIsoInput(v.date);
                    if (d) inputs.hijri.value = toHijri(d) || inputs.hijri.value;
                    const hint = form.querySelector('[data-hint-for="date"]');
                    if (hint) hint.textContent = d ? (isFriday(d) ? '✓ يوم جمعة' : '⚠ هذا اليوم ليس جمعة') : '';
                }
            },
            { name: 'hijri', label: 'التاريخ الهجري (يُحسب تلقائياً ويمكن تعديله)', value: month ? month.date.hijri : '', dir: 'ltr', hint: 'الصيغة: سنة/شهر/يوم' },
        ],
        submit: (v) => {
            const d = fromIsoInput(v.date);
            if (!d) return { error: 'اختاري التاريخ' };
            const greg = formatGreg(d);
            if (month) return actForm(st => S.editDate(st, month.date.n, greg, v.hijri), 'تعديل تاريخ ' + greg, 'تم تعديل التاريخ');
            return actForm(st => S.addDate(st, greg, v.hijri), 'إضافة جمعة ' + greg, 'تمت إضافة جمعة ' + greg);
        }
    });
}

// ---------- Tab: distribute ----------
function runAutoFix(from) {
    const r = act(st => S.autoFix(st, from), 'إصلاح تلقائي');
    if (r && !r.error) {
        const left = S.relevantIssues(store.state).length;
        toast('تم الإصلاح: ' + r.swaps + ' تعيين تغيّر في ' + r.regenerated + ' جمعة' + (left ? ' — بقيت ' + left + ' ملاحظة' : ' ✓'),
            { kind: left ? 'warn' : 'success', action: { label: 'تراجع', onClick: doUndo } });
    }
}

function tabDistribute() {
    const s = store.state;
    const issues = ctx.view.issues || [];
    const wrap = el('div');

    // Issues
    const issueList = el('ul', { class: 'issue-list' });
    issues.slice(0, 60).forEach(is => {
        issueList.appendChild(el('li', {}, [
            el('span', { text: is.message }),
            is.monthN != null ? iconBtn('👁', 'عرض', () => {
                closeDrawer();
                const idx = s.schedule.findIndex(m => m.date.n === is.monthN);
                ctx.setActive(idx);
                const sec = document.getElementById('m' + is.monthN);
                if (sec) sec.scrollIntoView({ behavior: 'smooth' });
            }) : null
        ]));
    });
    if (issues.length > 60) issueList.appendChild(el('li', { text: '… و ' + (issues.length - 60) + ' أخرى' }));
    wrap.appendChild(section(issues.length ? '⚠ ملاحظات التوزيع (' + issues.length + ')' : '✓ التوزيع سليم', [
        issues.length ? issueList : el('p', { class: 'd-help', text: 'كل الجمعات متوازنة، ولا يوجد تكرار متتالٍ لأي شخص.' })
    ]));

    // Spacing rule (no same item for the same person within N months)
    const months = S.getRepeatMonths(s);
    const rs = S.repeatStats(s, Math.min(startIdx(), s.schedule.length));
    const monthsInput = el('input', { type: 'number', min: 1, max: 24, value: months, class: 'slots-input', 'aria-label': 'عدد الأشهر' });
    monthsInput.addEventListener('change', () => {
        const v = Math.max(1, Math.min(24, parseInt(monthsInput.value, 10) || 8));
        act(st => { st.rules = Object.assign({}, st.rules, { repeatMonths: v }); }, 'مدة عدم التكرار', 'تم: لا يتكرر البند خلال ' + v + ' أشهر قدر الإمكان');
    });
    const optFrom = el('select', { class: 'inline-select' });
    dateOptions().forEach(o => optFrom.appendChild(el('option', { value: o.value, text: o.label })));
    optFrom.value = Math.min(startIdx(), s.schedule.length - 1);
    wrap.appendChild(section('🧭 قاعدة التباعد', [
        el('div', { class: 'inline-form' }, [
            el('span', { text: 'لا يرجع نفس البند لنفس الشخص خلال' }), monthsInput, el('span', { text: 'أشهر' })
        ]),
        el('div', { class: 'totals ' + (rs.within ? 'bad' : 'ok') }, [
            el('span', { html: 'تكرارات داخل المدة (من الجمعة القادمة): <b>' + rs.within + '</b>' }),
            el('span', { html: 'أقصر فترة تكرار: <b>' + (rs.minGapMonths == null ? '—' : rs.minGapMonths + ' شهر') + '</b>' }),
        ]),
        el('div', { class: 'inline-form' }, [el('span', { text: 'من جمعة:' }), optFrom,
            el('button', { type: 'button', class: 'btn primary', text: '⚡ تحسين التباعد', onclick: () => {
                const from = parseInt(optFrom.value, 10);
                const r = act(st => S.optimizeFrom(st, from), 'تحسين التباعد');
                if (r && !r.error) toast(r.changed ? 'تم تغيير ' + r.changed + ' تعيين — التكرارات داخل المدة: ' + r.before + ' ← ' + r.after : 'التوزيع الحالي هو الأفضل الممكن ✓',
                    { kind: 'success', action: r.changed ? { label: 'تراجع', onClick: doUndo } : null });
            } })])
    ], { help: 'الخوارزمية تختار لكل جمعة التوزيع الأمثل: يُمنع تكرار البند في جمعتين متتاليتين، وكلما كان التكرار أقرب كان أسوأ. ملاحظة: عدد البنود محدود، فقد لا يمكن منع التكرار كلياً خلال مدة طويلة — الخوارزمية تجعل الفترة أطول ما يمكن. الجمعات التي مضت لا تتغير.' }));

    // Auto-fix (minimal changes)
    const fixFrom = el('select', { class: 'inline-select' });
    dateOptions().forEach(o => fixFrom.appendChild(el('option', { value: o.value, text: o.label })));
    fixFrom.value = Math.min(startIdx(), s.schedule.length - 1);
    wrap.appendChild(section('🩹 إصلاح الأخطاء فقط', [
        el('div', { class: 'inline-form' }, [el('span', { text: 'من جمعة:' }), fixFrom,
            el('button', { type: 'button', class: 'btn secondary', text: 'إصلاح', onclick: () => runAutoFix(parseInt(fixFrom.value, 10)) })])
    ], { help: 'يعالج فقط الجمعات التي فيها أعداد غير متطابقة أو تكرار متتالٍ، مع إبقاء أكبر قدر من التعيينات كما هي.' }));

    // Full redistribution
    const regenFrom = el('select', { class: 'inline-select' });
    dateOptions().forEach(o => regenFrom.appendChild(el('option', { value: o.value, text: o.label })));
    regenFrom.value = Math.min(startIdx(), s.schedule.length - 1);
    wrap.appendChild(section('🔄 توزيع جديد كامل', [
        el('div', { class: 'inline-form' }, [el('span', { text: 'من جمعة:' }), regenFrom,
            el('button', {
                type: 'button', class: 'btn danger', text: 'توزيع جديد',
                onclick: async () => {
                    const from = parseInt(regenFrom.value, 10);
                    const n = s.schedule.length - from;
                    if (!await confirmDialog('سيُعاد توزيع ' + n + ' جمعة (من ' + s.schedule[from].date.greg + ' إلى النهاية) من الصفر بالخوارزمية. الجمعات قبلها لن تتغير. يمكنك التراجع بعدها.',
                        { danger: true, ok: 'توزيع جديد' })) return;
                    act(st => S.regenFrom(st, from), 'توزيع جديد من ' + s.schedule[from].date.greg, 'تم توزيع ' + n + ' جمعة من جديد');
                }
            })])
    ], { danger: true, help: 'يبني التوزيع من الصفر لكل الجمعات المختارة. استخدميه عند تغيير كبير في الأشخاص أو البنود؛ للتعديلات الصغيرة استخدمي «تحسين التباعد».' }));

    // Fairness table
    const stats = S.personItemStats(s);
    const rot = S.getRotatingItems(s);
    let html = '<div class="fair-wrap"><table class="fair"><thead><tr><th>الاسم</th>' +
        rot.map(it => '<th><span class="pill tiny" style="' + pillStyle(it.color) + '">' + esc(it.name) + '</span></th>').join('') + '</tr></thead><tbody>';
    s.people.forEach(p => {
        if (p === s.fixedPerson) return;
        html += '<tr><td>' + esc(p) + '</td>' + rot.map(it => {
            const c = stats[p][it.name] || 0;
            return '<td class="' + (c === 0 ? 'zero' : '') + '">' + c + '</td>';
        }).join('') + '</tr>';
    });
    html += '</tbody></table></div>';
    wrap.appendChild(section('📊 عدد مرات كل بند لكل شخص', [el('div', { html: html })],
        { help: 'نظرة على عدالة التوزيع عبر كل الجمعات.' }));
    return wrap;
}

// ---------- Tab: content ----------
function tabContent() {
    const s = store.state;
    const title = el('input', { type: 'text', value: s.title || '' });
    const subtitle = el('input', { type: 'text', value: s.subtitle || '', placeholder: 'اتركيه فارغاً ليُحسب تلقائياً من التواريخ' });
    const notices = el('textarea', { rows: 9 });
    notices.value = s.notices.join('\n');
    return section('النصوص والتنبيهات', [
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'العنوان' }), title]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'العنوان الفرعي' }), subtitle]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'التنبيهات (كل سطر تنبيه — ضعي **النص** بين نجمتين ليظهر عريضاً)' }), notices]),
        el('button', {
            type: 'button', class: 'btn primary block', text: 'تطبيق',
            onclick: () => act(st => {
                st.title = title.value.trim() || 'جدول الضيافة';
                st.subtitle = subtitle.value.trim();
                st.notices = notices.value.split('\n').map(x => x.trim()).filter(Boolean);
            }, 'تعديل النصوص', 'تم تحديث النصوص')
        })
    ]);
}

// ---------- Tab: settings ----------
function tabSettings() {
    const s = store.state;
    const cfg = publishCfg();
    const wrap = el('div');

    // GitHub
    const token = el('input', { type: 'password', value: getToken(), placeholder: 'github_pat_…', autocomplete: 'off', dir: 'ltr' });
    const owner = el('input', { type: 'text', value: cfg.owner, dir: 'ltr' });
    const repo = el('input', { type: 'text', value: cfg.repo, dir: 'ltr' });
    const branch = el('input', { type: 'text', value: cfg.branch, dir: 'ltr' });
    const path = el('input', { type: 'text', value: cfg.path, dir: 'ltr' });
    const status = el('div', { class: 'sync-info', text: store.baseSha
        ? '✓ متصل — آخر نسخة من GitHub: ' + store.baseSha.slice(0, 7)
        : (getToken() ? 'لم يتم التحميل من GitHub بعد' : 'لم يُضَف رمز الوصول بعد — الحفظ على الموقع غير متاح') });

    const applyCfg = () => {
        setToken(token.value.trim());
        const next = { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', path: path.value.trim() || 'data.json' };
        if (JSON.stringify(next) !== JSON.stringify(s.publish)) mutate(st => { st.publish = next; }, 'إعدادات النشر');
    };

    wrap.appendChild(section('🌐 الحفظ على الموقع (GitHub)', [
        status,
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'رمز الوصول (Token)' }), token,
            el('div', { class: 'field-hint', text: 'يُحفظ على هذا الجهاز فقط ولا يُرفع مع البيانات أبداً.' })]),
        el('details', { class: 'advanced' }, [
            el('summary', { text: 'إعدادات متقدمة' }),
            el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'اسم المستخدم (owner)' }), owner]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'المستودع (repo)' }), repo]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'الفرع (branch)' }), branch]),
            el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'مسار ملف البيانات' }), path]),
        ]),
        el('div', { class: 'btn-row' }, [
            el('button', { type: 'button', class: 'btn primary', text: 'حفظ الإعدادات واختبار الاتصال', onclick: async () => {
                applyCfg();
                if (await syncFromServer({ silent: false })) renderDrawer();
            } }),
            el('button', { type: 'button', class: 'btn secondary', text: '⟳ تحميل أحدث نسخة', onclick: async () => {
                applyCfg();
                if (isDirty() && !await confirmDialog('سيتم استبدال تعديلاتك غير المحفوظة بأحدث نسخة على GitHub.', { danger: true, ok: 'تحميل' })) return;
                if (await syncFromServer({ silent: false, replace: true })) { clearDraft(); $('draftBanner').hidden = true; }
            } }),
        ]),
        el('details', { class: 'advanced' }, [
            el('summary', { text: 'كيف أحصل على رمز الوصول؟' }),
            el('ol', { class: 'd-help steps', html:
                '<li>من GitHub: Settings ← Developer settings ← Personal access tokens ← <b>Fine-grained tokens</b> ← Generate new token.</li>' +
                '<li>Repository access: <b>Only select repositories</b> واختاري <code dir="ltr">' + esc(cfg.repo || 'jadwal') + '</code>.</li>' +
                '<li>Permissions ← Repository ← <b>Contents: Read and write</b>.</li>' +
                '<li>انسخي الرمز والصقيه هنا.</li>' })
        ]),
    ]));

    // Backup
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        try {
            const data = S.normalizeState(JSON.parse(await f.text()));
            if (!Array.isArray(data.people) || !Array.isArray(data.items) || !Array.isArray(data.schedule)) throw new Error('bad');
            if (!await confirmDialog('استبدال الجدول الحالي بالنسخة «' + f.name + '»؟ (يمكن التراجع)', { ok: 'استيراد' })) return;
            if (!data.auth) data.auth = s.auth;
            replaceState(data, 'استيراد نسخة');
            toast('تم الاستيراد — اضغطي «حفظ» لنشره', { kind: 'success' });
        } catch (e) {
            toast('الملف غير صالح', { kind: 'error' });
        } finally { fileInput.value = ''; }
    });
    wrap.appendChild(section('🗂 النسخ الاحتياطية', [
        el('div', { class: 'btn-row' }, [
            el('button', { type: 'button', class: 'btn secondary', text: '📥 تنزيل نسخة (JSON)', onclick: () => {
                const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
                const a = el('a', { href: URL.createObjectURL(blob), download: 'jadwal-backup-' + toIsoInput(new Date()) + '.json' });
                document.body.appendChild(a); a.click(); a.remove();
            } }),
            el('button', { type: 'button', class: 'btn secondary', text: '📤 استيراد نسخة', onclick: () => fileInput.click() }),
            fileInput
        ])
    ], { help: 'ملف صغير يحتوي كل البيانات. يمكن استيراده لاحقاً لاسترجاع الجدول كما هو.' }));

    // Password
    const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'كلمة المرور الجديدة' });
    const p2 = el('input', { type: 'password', autocomplete: 'new-password' });
    wrap.appendChild(section('🔑 كلمة مرور المدير', [
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'كلمة المرور الجديدة' }), p1]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'تأكيد كلمة المرور' }), p2]),
        el('button', { type: 'button', class: 'btn primary', text: 'تغيير كلمة المرور', onclick: (e) => {
            if (!p1.value) { toast('أدخلي كلمة المرور', { kind: 'error' }); return; }
            if (p1.value !== p2.value) { toast('كلمتا المرور غير متطابقتين', { kind: 'error' }); return; }
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'جارٍ التحديث…';
            setTimeout(() => {
                const auth = makeAuth(p1.value, (s.auth && s.auth.iter) || 20000);
                mutate(st => { st.auth = auth; }, 'تغيير كلمة المرور');
                setSession(auth.hash);
                toast('تم تغيير كلمة المرور — اضغطي «حفظ» لتثبيتها على الموقع', { kind: 'success', duration: 5000 });
            }, 30);
        } })
    ], { help: 'كلمة المرور لا تُحفظ نصاً — فقط بصمة مشفّرة داخل ملف البيانات.' }));

    wrap.appendChild(el('button', { type: 'button', class: 'btn secondary block', text: '🔒 الخروج من وضع المدير', onclick: exitAdmin }));
    return wrap;
}
