// Date helpers. Stored formats (unchanged from the original data):
//   greg  = "d/m/yyyy"      e.g. "15/5/2026"
//   hijri = "yyyy/m/d"      e.g. "1447/11/28"  (Umm al-Qura calendar)

const hijriFmt = (() => {
    try {
        return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
            year: 'numeric', month: 'numeric', day: 'numeric'
        });
    } catch (e) { return null; }
})();

export function parseGreg(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1], 12);
    return isNaN(d) ? null : d;
}

export function formatGreg(d) {
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
}

// "yyyy-mm-dd" (from <input type=date>) ⇄ Date
export function fromIsoInput(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null;
}
export function toIsoInput(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function toHijri(d) {
    if (!hijriFmt || !d) return '';
    const parts = {};
    hijriFmt.formatToParts(d).forEach(p => { parts[p.type] = p.value; });
    if (!parts.year) return '';
    return parseInt(parts.year, 10) + '/' + parseInt(parts.month, 10) + '/' + parseInt(parts.day, 10);
}

export function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

export function isFriday(d) { return d && d.getDay() === 5; }

export function today() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12);
}

// Index of the first date on/after today (the "upcoming" Friday); -1 if all are past
export function upcomingIndex(schedule) {
    const t = today().getTime();
    for (let i = 0; i < schedule.length; i++) {
        const d = parseGreg(schedule[i].date.greg);
        if (d && d.getTime() >= t) return i;
    }
    return -1;
}

// Suggest the next date: same spacing as the last two dates (default 4 weeks), snapped to a Friday
export function suggestNextDate(schedule) {
    const dates = schedule.map(m => parseGreg(m.date.greg)).filter(Boolean);
    if (dates.length === 0) {
        let d = today();
        while (!isFriday(d)) d = addDays(d, 1);
        return d;
    }
    const last = dates[dates.length - 1];
    let gap = 28;
    if (dates.length >= 2) {
        const g = Math.round((last - dates[dates.length - 2]) / 86400000);
        if (g >= 7 && g <= 70) gap = Math.round(g / 7) * 7;
    }
    let d = addDays(last, gap);
    while (!isFriday(d)) d = addDays(d, 1);
    return d;
}

const ORDINALS = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة',
    'التاسعة', 'العاشرة', 'الحادية عشرة', 'الثانية عشرة', 'الثالثة عشرة', 'الرابعة عشرة', 'الخامسة عشرة',
    'السادسة عشرة', 'السابعة عشرة', 'الثامنة عشرة', 'التاسعة عشرة', 'العشرون'];
export function ordinalLabel(i) {
    return 'الجمعة ' + (ORDINALS[i] || (i + 1));
}

export function formatTime(ts) {
    try {
        return new Date(ts).toLocaleString('ar-SA-u-nu-latn', {
            day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit'
        });
    } catch (e) { return new Date(ts).toLocaleString(); }
}
