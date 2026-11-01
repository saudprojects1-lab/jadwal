// Entry point: load data.json, render the public schedule, wire viewer features.

import { store, subscribe, setBaseline, cacheData, readCache } from './store.js';
import { normalizeState, relevantIssues } from './scheduler.js';
import { renderMonths, renderIndex, renderLegend, renderNotices, renderPersonCard, renderHero, autoSubtitle } from './render.js';
import { upcomingIndex, formatTime } from './dates.js';
import { exportSection, exportSections, sanitizeFilename } from './export.js';
import { toast, esc } from './ui.js';
import { initAdmin } from './admin.js';

const $ = (id) => document.getElementById(id);

export const view = {
    admin: false,
    activeIdx: 0,
    myPerson: '',
    issues: [],
};

let months = [];
let adminApi = null;

// ---------- Data loading ----------
async function loadData() {
    try {
        // Cache-busting query + no-store: always the latest published version,
        // never the copy GitHub Pages / the browser cached minutes ago.
        const res = await fetch('data.json?v=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        cacheData(data);
        return { data: data, offline: false };
    } catch (err) {
        console.error('data.json load failed:', err);
        const cached = readCache();
        if (cached && cached.data) return { data: cached.data, offline: true, ts: cached.ts };
        throw err;
    }
}

// ---------- Rendering ----------
export function renderView() {
    const s = store.state;
    if (!s) return;
    document.title = (s.title || 'جدول الضيافة') + ' — أيام الجمعة';
    $('siteTitle').textContent = s.title || 'جدول الضيافة';
    $('siteSubtitle').textContent = s.subtitle || autoSubtitle(s);

    $('noticesList').innerHTML = renderNotices(s);
    $('noticesBox').hidden = s.notices.length === 0;

    view.issues = view.admin ? relevantIssues(s) : [];
    $('monthsHost').innerHTML = renderMonths(s, { admin: view.admin, issues: view.issues, myPerson: view.myPerson });
    const hero = renderHero(s, view.myPerson);
    $('heroHost').innerHTML = hero;
    $('heroHost').hidden = !hero;
    updatePastToggle();
    $('indexList').innerHTML = renderIndex(s);
    $('legendGrid').innerHTML = renderLegend(s);

    // "جدولي" person picker
    const sel = $('mySelect');
    const keep = view.myPerson;
    sel.innerHTML = '<option value="">👤 جدولي…</option>' +
        s.people.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
    if (keep && s.people.includes(keep)) sel.value = keep; else view.myPerson = '';
    renderMyCard();

    refreshPager();
    applySearch();
    if (adminApi) adminApi.onRender(view.issues);
}

// Past Fridays are collapsed by default (desktop list view) — one tap shows them
function updatePastToggle() {
    const up = upcomingIndex(store.state.schedule);
    const pastCount = up === -1 ? store.state.schedule.length : up;
    $('pastToggleRow').hidden = pastCount === 0;
    $('pastToggle').textContent = document.body.classList.contains('show-past')
        ? '▲ إخفاء الجمعات الماضية' : '▼ إظهار الجمعات الماضية (' + pastCount + ')';
}
$('pastToggle').addEventListener('click', () => {
    document.body.classList.toggle('show-past');
    updatePastToggle();
});

function renderMyCard() {
    const host = $('myCardHost');
    host.innerHTML = view.myPerson ? renderPersonCard(store.state, view.myPerson) : '';
}

// ---------- Mobile paging ----------
const monthSelect = $('monthSelect');
const prevBtn = $('prevMonthBtn');
const nextBtn = $('nextMonthBtn');

function refreshPager() {
    months = Array.from(document.querySelectorAll('#monthsHost .month'));
    monthSelect.innerHTML = '';
    const upIdx = upcomingIndex(store.state.schedule);
    months.forEach((m, i) => {
        const greg = (m.querySelector('.greg') || {}).textContent || '';
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = (i + 1) + '  ·  ' + greg.trim() + (i === upIdx ? '  · القادمة' : '');
        monthSelect.appendChild(opt);
    });
    setActive(view.activeIdx, false);
}

function isMobile() { return window.innerWidth <= 640; }

export function setActive(i, scroll) {
    if (months.length === 0) return;
    view.activeIdx = Math.max(0, Math.min(months.length - 1, i));
    months.forEach((m, j) => m.classList.toggle('active', j === view.activeIdx));
    monthSelect.value = view.activeIdx;
    prevBtn.disabled = view.activeIdx === 0;
    nextBtn.disabled = view.activeIdx === months.length - 1;
    if (scroll !== false && document.body.classList.contains('mobile-paged')) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function applyMobileMode() {
    const searching = document.body.classList.contains('searching');
    document.body.classList.toggle('mobile-paged', isMobile() && !searching);
}

prevBtn.addEventListener('click', () => setActive(view.activeIdx - 1));
nextBtn.addEventListener('click', () => setActive(view.activeIdx + 1));
monthSelect.addEventListener('change', (e) => setActive(parseInt(e.target.value, 10)));
window.addEventListener('resize', applyMobileMode);

let touchX = 0, touchY = 0;
document.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('mobile-paged')) return;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', (e) => {
    if (!document.body.classList.contains('mobile-paged') || document.body.classList.contains('modal-open')) return;
    if (e.target.closest && e.target.closest('.drawer, .modal-overlay, .admin-bar')) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    // RTL: swipe left → next Friday
    setActive(view.activeIdx + (dx < 0 ? 1 : -1));
}, { passive: true });

// Index links also select the Friday in paged mode
document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    if (a.classList.contains('is-past') && !document.body.classList.contains('show-past')) {
        document.body.classList.add('show-past');
        updatePastToggle();
    }
    setActive(parseInt(a.getAttribute('data-goto'), 10), false);
});

// ---------- Search ----------
const searchInput = $('searchInput');
function applySearch() {
    const q = searchInput.value.trim();
    const rows = document.querySelectorAll('#monthsHost table.schedule tbody tr');
    if (!q) {
        rows.forEach(r => r.classList.remove('dim', 'match'));
        document.body.classList.remove('searching');
        applyMobileMode();
        return;
    }
    document.body.classList.add('searching');
    document.body.classList.remove('mobile-paged');
    rows.forEach(r => {
        const hit = r.querySelector('td.name').textContent.includes(q);
        r.classList.toggle('match', hit);
        r.classList.toggle('dim', !hit);
    });
}
searchInput.addEventListener('input', applySearch);

// ---------- "جدولي" ----------
$('mySelect').addEventListener('change', (e) => {
    view.myPerson = e.target.value;
    try { localStorage.setItem('jadwal_my_person', view.myPerson); } catch (err) {}
    renderView();
    if (view.myPerson) $('myCardHost').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('.my-card-close')) return;
    view.myPerson = '';
    $('mySelect').value = '';
    try { localStorage.removeItem('jadwal_my_person'); } catch (err) {}
    renderView();
});

// ---------- Image export ----------
async function withBusy(btn, label, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="export-icon">⏳</span><span class="export-text">' + label + '</span>';
    try { await fn((t) => { btn.querySelector('.export-text').textContent = t; }); }
    catch (err) {
        console.error('export failed:', err);
        toast('تعذّر إنشاء الصورة: ' + (err && err.message ? err.message : 'خطأ غير متوقع'), { kind: 'error' });
    } finally {
        btn.innerHTML = html;
        btn.disabled = false;
    }
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.export-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const section = btn.closest('.month');
    if (btn.hasAttribute('data-export-card')) {
        const person = section.getAttribute('data-person') || '';
        withBusy(btn, 'جارٍ إنشاء الصورة...', () => exportSection(section, sanitizeFilename('جدول_' + person + '.png')));
        return;
    }
    const greg = (section.querySelector('.greg') || {}).textContent || '';
    withBusy(btn, 'جارٍ إنشاء الصورة...', () => exportSection(section, sanitizeFilename('جدول_' + greg.replace(' م', '').trim() + '.png')));
});

$('exportAllBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const upIdx = upcomingIndex(store.state.schedule);
    // Only Fridays from the upcoming one onward (past ones aren't useful to share)
    const list = months
        .filter((m, i) => upIdx === -1 || i >= upIdx)
        .map(m => ({ section: m, filename: sanitizeFilename('جدول_' + ((m.querySelector('.greg') || {}).textContent || '').replace(' م', '').trim() + '.png') }));
    if (!list.length) return;
    const original = btn.textContent;
    btn.disabled = true;
    try {
        await exportSections(list, (i, n) => { btn.textContent = '⏳ ' + i + ' / ' + n; });
    } catch (err) {
        console.error(err);
        toast('تعذّر التصدير: ' + (err.message || ''), { kind: 'error' });
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
});

$('printBtn').addEventListener('click', () => window.print());

// ---------- Boot ----------
async function boot() {
    let loaded;
    try {
        loaded = await loadData();
    } catch (err) {
        $('loadState').innerHTML =
            '<div class="load-error"><strong>تعذّر تحميل الجدول.</strong><br>' +
            (location.protocol === 'file:'
                ? 'افتحي الصفحة عبر رابط الموقع (أو خادم محلي) — المتصفح يمنع قراءة data.json من ملف مباشر.'
                : 'تحققي من الاتصال بالإنترنت ثم أعيدي تحميل الصفحة.') +
            '<br><button type="button" class="btn primary" onclick="location.reload()">إعادة المحاولة</button></div>';
        return;
    }
    const data = normalizeState(loaded.data);
    setBaseline(data, null);
    $('loadState').hidden = true;
    ['toolbar', 'indexBox', 'legendBox', 'printArea'].forEach(id => { $(id).hidden = false; });
    if (loaded.offline) {
        toast('أنتِ غير متصلة — تُعرض آخر نسخة محفوظة (' + formatTime(loaded.ts) + ')', { kind: 'warn', duration: 6000 });
    }

    try { view.myPerson = localStorage.getItem('jadwal_my_person') || ''; } catch (e) {}
    const up = upcomingIndex(store.state.schedule);
    view.activeIdx = up === -1 ? Math.max(0, store.state.schedule.length - 1) : up;

    applyMobileMode();
    renderView();

    adminApi = initAdmin({ view: view, renderView: renderView, setActive: setActive });
    subscribe((reason) => {
        if (reason === 'saving') return;
        renderView();
    });
}

boot();
