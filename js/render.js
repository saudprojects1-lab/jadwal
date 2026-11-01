// HTML rendering of the public schedule (built from state — no pre-rendered tables).

import { esc } from './ui.js';
import { upcomingIndex } from './dates.js';

const FALLBACK = { bg: '#EEE', fg: '#333', border: '#CCC' };

export function pillStyle(c) {
    c = c || FALLBACK;
    return 'background:' + c.bg + ';color:' + c.fg + ';border-color:' + c.border;
}

function colorMap(items) {
    const map = {};
    items.forEach(it => { map[it.name] = it.color || FALLBACK; });
    return map;
}

// "**bold**" → <strong>, everything else escaped
export function richText(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export function autoSubtitle(state) {
    const s = state.schedule;
    if (!s.length) return 'أيام الجمعة';
    const fmt = (g) => { const p = gregParts(g); return p.day + ' ' + p.month + ' ' + p.year; };
    return 'أيام الجمعة · من ' + fmt(s[0].date.greg) + ' إلى ' + fmt(s[s.length - 1].date.greg);
}

// issues: output of verifyConstraints → { byMonth: {n: Set(person)}, monthsWithIssues: Set(n) }
export function indexIssues(issues) {
    const byMonth = {};
    const months = new Set();
    issues.forEach(is => {
        if (is.monthN == null) return;
        months.add(is.monthN);
        if (is.person) (byMonth[is.monthN] = byMonth[is.monthN] || new Set()).add(is.person);
    });
    return { byMonth: byMonth, months: months };
}

export function renderMonths(state, opts) {
    opts = opts || {};
    const colors = colorMap(state.items);
    const upIdx = upcomingIndex(state.schedule);
    const issueIdx = opts.issues ? indexIssues(opts.issues) : { byMonth: {}, months: new Set() };
    return state.schedule.map((month, i) => {
        const d = month.date;
        const badPeople = issueIdx.byMonth[d.n] || new Set();
        const isPast = upIdx === -1 || i < upIdx;
        // People added later don't exist in past Fridays — skip them there (and for viewers)
        const shown = state.people.filter(p => (p in month.assignment) || (opts.admin && !isPast));
        let rows = '';
        shown.forEach((person, pIdx) => {
            const item = month.assignment[person] || '';
            const style = pillStyle(colors[item]);
            const pill = opts.admin
                ? '<button type="button" class="pill pill-btn" data-cell="1" data-n="' + d.n + '" data-person="' + esc(person) + '" style="' + style + '">' +
                    esc(item || '— بدون —') + '<span class="pill-edit" aria-hidden="true">✎</span></button>'
                : '<span class="pill" style="' + style + '">' + esc(item) + '</span>';
            const cls = (badPeople.has(person) ? 'row-issue ' : '') + (person === opts.myPerson ? 'mine' : '');
            rows += '<tr' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + ' data-person="' + esc(person) + '">' +
                '<td class="num">' + (pIdx + 1) + '</td>' +
                '<td class="name">' + esc(person) + '</td>' +
                '<td class="item-cell">' + pill + '</td>' +
                '</tr>';
        });
        let badge = '';
        if (i === upIdx) badge = '<span class="month-badge upcoming no-export">القادمة</span>';
        else if (upIdx === -1 || i < upIdx) badge = '<span class="month-badge past no-export">مضت</span>';
        const issueBadge = opts.admin && issueIdx.months.has(d.n)
            ? '<span class="month-badge issue no-export">⚠ يحتاج مراجعة</span>' : '';
        return '<section id="m' + d.n + '" class="month' + (i === upIdx ? ' is-upcoming' : '') +
                (upIdx !== -1 && i < upIdx || upIdx === -1 ? ' is-past' : '') + '" data-n="' + d.n + '" data-idx="' + i + '">' +
            '<header class="month-head">' +
                '<div class="month-num">يوم الجمعة</div>' + badge + issueBadge +
                '<div class="month-dates">' +
                    '<span class="hijri">' + esc(d.hijri) + ' هـ</span>' +
                    '<span class="sep">·</span>' +
                    '<span class="greg">' + esc(d.greg) + ' م</span>' +
                '</div>' +
                '<button class="export-btn no-export" type="button" data-export="' + d.n + '" aria-label="تصدير الجدول كصورة">' +
                    '<span class="export-icon" aria-hidden="true">📸</span><span class="export-text">تصدير صورة</span>' +
                '</button>' +
                '<a href="#top" class="to-top no-export" title="عودة للأعلى">↑</a>' +
            '</header>' +
            '<table class="schedule">' +
                '<thead><tr><th class="num">#</th><th class="name">الاسم</th><th class="item">الضيافة</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table>' +
        '</section>';
    }).join('');
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function gregParts(greg) {
    const p = String(greg).split('/');
    return { day: p[0], month: AR_MONTHS[(+p[1] || 1) - 1] || '', year: p[2] || '' };
}

// Compact horizontal strip of date chips
export function renderIndex(state) {
    const upIdx = upcomingIndex(state.schedule);
    return state.schedule.map((m, i) => {
        const g = gregParts(m.date.greg);
        const cls = i === upIdx ? 'is-upcoming' : (upIdx === -1 || i < upIdx) ? 'is-past' : '';
        return '<li><a href="#m' + m.date.n + '" data-goto="' + i + '" class="' + cls + '" title="' + esc(m.date.greg) + ' م · ' + esc(m.date.hijri) + ' هـ">' +
            '<span class="chip-day">' + esc(g.day) + '</span>' +
            '<span class="chip-month">' + esc(g.month) + ' ' + esc(g.year) + '</span>' +
            (i === upIdx ? '<span class="chip-up">القادمة</span>' : '') +
        '</a></li>';
    }).join('');
}

function daysUntil(greg) {
    const p = String(greg).split('/');
    const d = new Date(+p[2], +p[1] - 1, +p[0], 12);
    const t = new Date(); const today = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12);
    return Math.round((d - today) / 86400000);
}

// "Next Friday" hero card (+ the viewer's own item when "جدولي" is set)
export function renderHero(state, myPerson) {
    const upIdx = upcomingIndex(state.schedule);
    if (upIdx === -1) return '';
    const m = state.schedule[upIdx];
    const g = gregParts(m.date.greg);
    const n = daysUntil(m.date.greg);
    const when = n <= 0 ? 'اليوم' : n === 1 ? 'غداً' : n === 2 ? 'بعد يومين' : n <= 10 ? 'بعد ' + n + ' أيام' : 'بعد ' + n + ' يوماً';
    let mine = '';
    if (myPerson && m.assignment[myPerson]) {
        const it = state.items.find(x => x.name === m.assignment[myPerson]);
        mine = '<div class="hero-mine"><span>بندك يا ' + esc(myPerson.split(' (')[0]) + ':</span>' +
            '<span class="pill" style="' + pillStyle(it && it.color) + '">' + esc(m.assignment[myPerson]) + '</span></div>';
    }
    return '<div class="hero-card">' +
        '<div class="hero-date"><span class="hero-day">' + esc(g.day) + '</span><span class="hero-month">' + esc(g.month) + '</span></div>' +
        '<div class="hero-info">' +
            '<div class="hero-label">الجمعة القادمة <span class="hero-when">' + when + '</span></div>' +
            '<div class="hero-dates">' + esc(m.date.greg) + ' م · ' + esc(m.date.hijri) + ' هـ</div>' +
            mine +
        '</div>' +
        '<a class="btn primary hero-go" href="#m' + m.date.n + '" data-goto="' + upIdx + '">عرض الجدول ↓</a>' +
    '</div>';
}

export function renderLegend(state) {
    return state.items.map(it =>
        '<div class="legend-item"><span class="pill" style="' + pillStyle(it.color) + '">' + esc(it.name) + '</span></div>'
    ).join('');
}

export function renderNotices(state) {
    return state.notices.map(n => '<li>' + richText(n) + '</li>').join('');
}

// One person's items across all Fridays — exportable like a month card
export function renderPersonCard(state, person) {
    const colors = colorMap(state.items);
    const upIdx = upcomingIndex(state.schedule);
    let rows = '';
    let k = 0;
    state.schedule.forEach((m, i) => {
        if (!(person in m.assignment)) return; // joined after this Friday
        const item = m.assignment[person];
        rows += '<tr class="' + (i === upIdx ? 'match' : (upIdx === -1 || i < upIdx) ? 'past-row' : '') + '">' +
            '<td class="num">' + (++k) + '</td>' +
            '<td class="name"><span class="greg">' + esc(m.date.greg) + ' م</span><span class="card-hijri">' + esc(m.date.hijri) + ' هـ</span></td>' +
            '<td class="item-cell"><span class="pill" style="' + pillStyle(colors[item]) + '">' + esc(item) + '</span></td>' +
            '</tr>';
    });
    return '<section class="month my-card" data-person="' + esc(person) + '">' +
        '<header class="month-head">' +
            '<div class="month-num">' + esc(person) + '</div>' +
            '<div class="month-dates"><span>جدول الضيافة الخاص بي</span></div>' +
            '<button class="export-btn no-export" type="button" data-export-card="1" aria-label="تصدير كصورة">' +
                '<span class="export-icon" aria-hidden="true">📸</span><span class="export-text">تصدير صورة</span>' +
            '</button>' +
            '<button class="to-top no-export my-card-close" type="button" title="إغلاق" aria-label="إغلاق">✕</button>' +
        '</header>' +
        '<table class="schedule">' +
            '<thead><tr><th class="num">#</th><th class="name">التاريخ</th><th class="item">الضيافة</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
        '</table>' +
    '</section>';
}
