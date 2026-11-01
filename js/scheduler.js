// Scheduling rules + all state mutations. Pure functions over the state object
// (no DOM). Ported from the original single-file version, plus new edit tools.
//
// Rules:
//  1. Each Friday every item has exactly `slots` people.
//  2. The fixed person always has the fixed item.
//  3. No rotating person gets the same item on two consecutive Fridays.
//  4. Every person appears once per Friday, only with known items.
//  5. Total slots === number of people.

import { ordinalLabel, upcomingIndex } from './dates.js';

export function shuffleArr(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
}
export function getRotatingPeople(state) {
    return state.people.filter(p => p !== state.fixedPerson);
}
export function getRotatingItems(state) {
    return state.items.filter(it => !it.fixed);
}
export function findItem(state, name) {
    return state.items.find(it => it.name === name);
}
export function totalRotatingSlots(state) {
    return getRotatingItems(state).reduce((s, it) => s + (it.slots || 0), 0);
}

// -------- Constraint verification --------
export function verifyConstraints(state) {
    const issues = [];
    if (!state || !state.schedule) return issues;
    const itemSlotMap = {};
    state.items.forEach(it => itemSlotMap[it.name] = it.slots);

    // 1. Each month: counts match expected slots
    state.schedule.forEach(m => {
        const counts = {};
        for (const p in m.assignment) {
            const it = m.assignment[p];
            counts[it] = (counts[it] || 0) + 1;
        }
        for (const itemName in itemSlotMap) {
            const expected = itemSlotMap[itemName];
            const actual = counts[itemName] || 0;
            if (expected !== actual) {
                issues.push({
                    type: 'count',
                    monthN: m.date.n,
                    monthLabel: m.date.greg,
                    message: '"' + itemName + '" في ' + m.date.greg + ': المتوقع ' + expected + '، الفعلي ' + actual
                });
            }
        }
    });

    // 2. Fixed person on fixed item every month
    state.schedule.forEach(m => {
        if (m.assignment[state.fixedPerson] !== state.fixedItem) {
            issues.push({
                type: 'fixed',
                monthN: m.date.n,
                monthLabel: m.date.greg,
                message: state.fixedPerson + ' يجب أن تكون على "' + state.fixedItem + '" في ' + m.date.greg
            });
        }
    });

    // 3. No consecutive same-item for any rotating person
    for (let i = 1; i < state.schedule.length; i++) {
        const prev = state.schedule[i-1].assignment;
        const curr = state.schedule[i].assignment;
        state.people.forEach(p => {
            if (p === state.fixedPerson) return;
            if (prev[p] && curr[p] && prev[p] === curr[p]) {
                issues.push({
                    type: 'consecutive',
                    person: p,
                    monthN: state.schedule[i].date.n,
                    prevMonthN: state.schedule[i-1].date.n,
                    message: p + ' حصلت على "' + curr[p] + '" في شهرين متتاليين (' + state.schedule[i-1].date.greg + ' و ' + state.schedule[i].date.greg + ')'
                });
            }
        });
    }

    // 4. Each person appears once per month + items exist
    const validItems = new Set(state.items.map(it => it.name));
    state.schedule.forEach(m => {
        state.people.forEach(p => {
            if (!(p in m.assignment)) {
                issues.push({
                    type: 'missing',
                    person: p,
                    monthN: m.date.n,
                    message: p + ' غير معيّنة في ' + m.date.greg
                });
            }
        });
        for (const p in m.assignment) {
            if (!validItems.has(m.assignment[p])) {
                issues.push({
                    type: 'unknown_item',
                    person: p,
                    monthN: m.date.n,
                    message: 'بند غير معروف "' + m.assignment[p] + '" مُعيَّن لـ ' + p + ' في ' + m.date.greg
                });
            }
        }
    });

    // 5. Total slots equals total people in each month
    const totalPeople = state.people.length;
    const totalSlotsPerMonth = state.items.reduce((s, it) => s + it.slots, 0);
    if (totalPeople !== totalSlotsPerMonth) {
        issues.push({
            type: 'totals',
            message: 'مجموع الأشخاص (' + totalPeople + ') لا يساوي مجموع البنود (' + totalSlotsPerMonth + ' لكل شهر)'
        });
    }

    return issues;
}

// -------- Distribution algorithms --------
// prevAssign / nextAssign: neighbouring Fridays — nobody may repeat either one's item
export function regenMonth(state, prevAssign, nextAssign, maxAttempts) {
    maxAttempts = maxAttempts || 3000;
    prevAssign = prevAssign || {};
    nextAssign = nextAssign || {};
    const rotPeople = getRotatingPeople(state);
    const rotItems = getRotatingItems(state);
    const pool = [];
    rotItems.forEach(it => {
        for (let i = 0; i < it.slots; i++) pool.push(it.name);
    });
    if (pool.length !== rotPeople.length) return null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const remaining = shuffleArr(pool.slice());
        const peopleOrder = shuffleArr(rotPeople.slice());
        const assignment = {};
        let ok = true;
        for (const person of peopleOrder) {
            const forbidden = prevAssign[person];
            const forbiddenNext = nextAssign[person];
            const candidates = [];
            for (let i = 0; i < remaining.length; i++) {
                if (remaining[i] !== forbidden && remaining[i] !== forbiddenNext) candidates.push(i);
            }
            if (candidates.length === 0) { ok = false; break; }
            const pickIdx = candidates[Math.floor(Math.random() * candidates.length)];
            assignment[person] = remaining[pickIdx];
            remaining.splice(pickIdx, 1);
        }
        if (ok) return assignment;
    }
    return null;
}

export function regenFullSchedule(state) {
    let prev = {};
    for (let i = 0; i < state.schedule.length; i++) {
        const newAssign = regenMonth(state, prev);
        if (!newAssign) return false;
        const fullAssign = Object.assign({}, newAssign);
        fullAssign[state.fixedPerson] = state.fixedItem;
        state.schedule[i].assignment = fullAssign;
        prev = newAssign;
    }
    return true;
}

// -------- Mutations --------
export function addPerson(state, personName, primaryItemName, position, isNewItem, newItemSlots) {
    if (!personName || !personName.trim()) {
        return { error: 'الاسم مطلوب' };
    }
    personName = personName.trim();
    if (state.people.includes(personName)) {
        return { error: 'الاسم موجود سابقاً' };
    }

    // Add or increment item
    if (isNewItem) {
        if (!primaryItemName || !primaryItemName.trim()) {
            return { error: 'اسم البند الجديد مطلوب' };
        }
        primaryItemName = primaryItemName.trim();
        if (findItem(state, primaryItemName)) {
            return { error: 'اسم البند موجود سابقاً' };
        }
        const slots = parseInt(newItemSlots);
        if (!slots || slots < 1) {
            return { error: 'عدد الأشخاص يجب أن يكون 1 أو أكثر' };
        }
        // Pick a default color from a palette
        const palette = [
            { bg: '#F6C2B0', fg: '#6E2708', border: '#DE8A5D' },
            { bg: '#B9D9F2', fg: '#0E3D5C', border: '#79AFCF' },
            { bg: '#E3C6EC', fg: '#4B2160', border: '#B98CCB' },
            { bg: '#C4E3B8', fg: '#1E4A0F', border: '#8CBE79' },
            { bg: '#F3DC8F', fg: '#4A3A05', border: '#C9AC3B' },
        ];
        const color = palette[state.items.length % palette.length];
        state.items.push({ name: primaryItemName, slots: slots, color: color, fixed: false });
        // The new item adds `slots` slots/month. We're adding 1 person.
        // For the assignment algorithm to be consistent, slots should equal 1
        // (one person per month using this new item). If user requested >1, we'd
        // need additional people on this item, which means total is off.
        // Keep slots as-is; validation will flag mismatch.
    } else {
        const item = findItem(state, primaryItemName);
        if (!item) {
            return { error: 'البند غير موجود' };
        }
        item.slots += 1;
    }

    // Insert person at position
    let insertIdx;
    if (position === 'end' || !position) {
        insertIdx = state.people.length;
    } else {
        const afterIdx = state.people.indexOf(position);
        insertIdx = afterIdx === -1 ? state.people.length : afterIdx + 1;
    }
    state.people.splice(insertIdx, 0, personName);

    // Distribute new person across all months
    let prevItemForNew = null;
    for (let m = 0; m < state.schedule.length; m++) {
        const month = state.schedule[m];
        const monthAssign = month.assignment;
        let chosenItem = null;

        // Try direct: place new person on primaryItem if not consecutive
        if (prevItemForNew !== primaryItemName) {
            // Check if primaryItem has free slot in this month
            let curCount = 0;
            for (const p in monthAssign) {
                if (monthAssign[p] === primaryItemName) curCount++;
            }
            const slotCount = findItem(state, primaryItemName).slots;
            if (curCount < slotCount) {
                chosenItem = primaryItemName;
            }
        }

        // Else: try to swap
        if (!chosenItem) {
            // Find item Y != primaryItem with a person that can move to primaryItem
            const rotItems = getRotatingItems(state);
            for (const candItem of rotItems) {
                if (candItem.name === primaryItemName) continue;
                // Find someone on candItem in this month who can move to primaryItem
                for (const otherP in monthAssign) {
                    if (otherP === state.fixedPerson) continue;
                    if (monthAssign[otherP] !== candItem.name) continue;
                    // Check their prev-month item
                    const prevA = m > 0 ? state.schedule[m-1].assignment : null;
                    if (prevA && prevA[otherP] === primaryItemName) continue;
                    // Check their next-month item
                    const nextA = m < state.schedule.length - 1 ? state.schedule[m+1].assignment : null;
                    if (nextA && nextA[otherP] === primaryItemName) continue;
                    // Found valid swap
                    monthAssign[otherP] = primaryItemName;
                    chosenItem = candItem.name;
                    break;
                }
                if (chosenItem) break;
            }
        }

        // Fallback: regen this month
        if (!chosenItem) {
            const prevA = m > 0 ? state.schedule[m-1].assignment : {};
            const newAssign = regenMonth(state, prevA);
            if (newAssign) {
                const fullAssign = Object.assign({}, newAssign);
                fullAssign[state.fixedPerson] = state.fixedItem;
                state.schedule[m].assignment = fullAssign;
                chosenItem = newAssign[personName];
            } else {
                // Couldn't even regen — just place anyway, validation will flag
                monthAssign[personName] = primaryItemName;
                chosenItem = primaryItemName;
            }
        } else {
            monthAssign[personName] = chosenItem;
        }
        prevItemForNew = chosenItem;
    }

    return { success: true };
}

export function deletePerson(state, personName) {
    if (personName === state.fixedPerson) {
        return { error: 'لا يمكن حذف هذا الشخص' };
    }
    const idx = state.people.indexOf(personName);
    if (idx === -1) {
        return { error: 'الشخص غير موجود' };
    }

    // Find this person's most-common item (their "primary")
    const counts = {};
    state.schedule.forEach(m => {
        const it = m.assignment[personName];
        if (it) counts[it] = (counts[it] || 0) + 1;
    });
    let primaryItem = null, maxCount = -1;
    for (const it in counts) {
        if (counts[it] > maxCount) { primaryItem = it; maxCount = counts[it]; }
    }

    // Remove person from people[]
    state.people.splice(idx, 1);

    // For each month: remove person, then if their item != primaryItem,
    // move someone from primaryItem to fill the gap
    state.schedule.forEach((m, mi) => {
        const personItem = m.assignment[personName];
        delete m.assignment[personName];
        if (personItem && personItem !== primaryItem) {
            // Move someone from primaryItem to personItem
            for (const otherP in m.assignment) {
                if (otherP === state.fixedPerson) continue;
                if (m.assignment[otherP] !== primaryItem) continue;
                // Try to avoid creating consecutive violation
                const prevA = mi > 0 ? state.schedule[mi-1].assignment : null;
                const nextA = mi < state.schedule.length - 1 ? state.schedule[mi+1].assignment : null;
                if (prevA && prevA[otherP] === personItem) continue;
                if (nextA && nextA[otherP] === personItem) continue;
                m.assignment[otherP] = personItem;
                break;
            }
        }
    });

    // Decrement primaryItem slots, remove if reaches 0 (and not fixed)
    if (primaryItem) {
        const itObj = findItem(state, primaryItem);
        if (itObj) {
            itObj.slots = Math.max(0, itObj.slots - 1);
            if (itObj.slots === 0 && !itObj.fixed) {
                state.items = state.items.filter(it => it.name !== primaryItem);
            }
        }
    }

    return { success: true };
}

export function setItemSlots(state, itemName, newSlots) {
    const item = findItem(state, itemName);
    if (!item) return { error: 'البند غير موجود' };
    if (item.fixed) return { error: 'لا يمكن تعديل هذا البند' };
    const n = parseInt(newSlots);
    if (isNaN(n) || n < 0) return { error: 'القيمة غير صحيحة' };
    item.slots = n;
    return { success: true };
}

export function deleteItem(state, itemName) {
    const item = findItem(state, itemName);
    if (!item) return { error: 'البند غير موجود' };
    if (item.fixed) return { error: 'لا يمكن حذف هذا البند' };
    // Check if used
    let usedBy = 0;
    state.schedule.forEach(m => {
        for (const p in m.assignment) {
            if (m.assignment[p] === itemName) usedBy++;
        }
    });
    if (usedBy > 0) {
        return { error: 'لا يمكن حذف هذا البند — مستخدم في ' + usedBy + ' مكان. اضبط عدد الأشخاص لـ 0 وأعد التوزيع أولاً.' };
    }
    state.items = state.items.filter(it => it.name !== itemName);
    return { success: true };
}

export function addDate(state, gregStr, hijriStr) {
    gregStr = (gregStr || '').trim();
    hijriStr = (hijriStr || '').trim();
    if (!gregStr || !hijriStr) {
        return { error: 'يجب إدخال التاريخين' };
    }
    // Check duplicates
    if (state.schedule.some(m => m.date.greg === gregStr || m.date.hijri === hijriStr)) {
        return { error: 'هذا التاريخ موجود سابقاً' };
    }
    // New n = max existing n + 1 (n is a stable id, not the display order)
    let maxN = 0;
    state.schedule.forEach(m => { if (m.date.n > maxN) maxN = m.date.n; });
    const newN = maxN + 1;
    const dateInfo = { n: newN, label: '', hijri: hijriStr, greg: gregStr };
    // Insert in chronological order; respect both neighbours
    const newTime = gregTime(gregStr);
    let idx = state.schedule.length;
    if (newTime != null) {
        const at = state.schedule.findIndex(m => { const t = gregTime(m.date.greg); return t != null && t > newTime; });
        if (at !== -1) idx = at;
    }
    state.schedule.splice(idx, 0, { date: dateInfo, assignment: {} });
    const best = optimizeMonth(state, idx, { context: 'all' });
    if (!best) {
        state.schedule.splice(idx, 1);
        return { error: 'تعذّر توليد توزيع للجمعة الجديدة — تأكدي أن مجموع البنود يساوي عدد الأشخاص' };
    }
    state.schedule[idx].assignment = best;
    relabelDates(state);
    return { success: true, n: newN };
}

export function deleteDate(state, dateN) {
    if (state.schedule.length <= 1) {
        return { error: 'لا يمكن حذف آخر تاريخ' };
    }
    const idx = state.schedule.findIndex(m => m.date.n === dateN);
    if (idx === -1) return { error: 'التاريخ غير موجود' };
    state.schedule.splice(idx, 1);
    relabelDates(state);
    return { success: true };
}

export function editDate(state, dateN, newGreg, newHijri) {
    const m = state.schedule.find(x => x.date.n === dateN);
    if (!m) return { error: 'التاريخ غير موجود' };
    newGreg = (newGreg || '').trim();
    newHijri = (newHijri || '').trim();
    if (!newGreg || !newHijri) return { error: 'يجب إدخال التاريخين' };
    // Check duplicates (excluding this date)
    if (state.schedule.some(x => x.date.n !== dateN && (x.date.greg === newGreg || x.date.hijri === newHijri))) {
        return { error: 'هذا التاريخ موجود سابقاً' };
    }
    m.date.greg = newGreg;
    m.date.hijri = newHijri;
    sortSchedule(state);
    return { success: true };
}

// ==================== New edit tools ====================

function gregTime(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1], 12).getTime() : null;
}

export function relabelDates(state) {
    state.schedule.forEach((m, i) => { m.date.label = ordinalLabel(i); });
}

export function sortSchedule(state) {
    state.schedule.sort((a, b) => (gregTime(a.date.greg) || 0) - (gregTime(b.date.greg) || 0));
    relabelDates(state);
}

// Ensure optional fields exist (older data files lack them)
export function normalizeState(state) {
    if (!Array.isArray(state.notices)) state.notices = [];
    if (!state.title) state.title = 'جدول الضيافة';
    if (typeof state.subtitle !== 'string') state.subtitle = '';
    if (!state.rules) state.rules = { repeatMonths: 8 };
    if (!state.publish) state.publish = { owner: '', repo: '', branch: 'main', path: 'data.json' };
    state.items.forEach(it => {
        if (!it.color) it.color = { bg: '#EEE', fg: '#333', border: '#CCC' };
        it.fixed = !!it.fixed;
    });
    return state;
}

export function itemCountsForMonth(state, month) {
    const counts = {};
    state.items.forEach(it => { counts[it.name] = 0; });
    for (const p in month.assignment) {
        const it = month.assignment[p];
        counts[it] = (counts[it] || 0) + 1;
    }
    return counts;
}

function monthByN(state, n) {
    const idx = state.schedule.findIndex(m => m.date.n === n);
    return { idx: idx, month: idx === -1 ? null : state.schedule[idx] };
}

// Change one person's item on one Friday (counts may become unbalanced — validation flags it)
export function setAssignment(state, dateN, person, itemName) {
    const { month } = monthByN(state, dateN);
    if (!month) return { error: 'التاريخ غير موجود' };
    if (!findItem(state, itemName)) return { error: 'البند غير موجود' };
    if (person === state.fixedPerson && itemName !== state.fixedItem) {
        return { error: person + ' ثابتة على "' + state.fixedItem + '"' };
    }
    month.assignment[person] = itemName;
    return { success: true };
}

// Swap the items of two people on one Friday (keeps counts balanced)
export function swapAssignment(state, dateN, p1, p2) {
    const { month } = monthByN(state, dateN);
    if (!month) return { error: 'التاريخ غير موجود' };
    if (p1 === state.fixedPerson || p2 === state.fixedPerson) return { error: 'لا يمكن تبديل الشخص الثابت' };
    const a = month.assignment[p1], b = month.assignment[p2];
    month.assignment[p1] = b;
    month.assignment[p2] = a;
    return { success: true };
}

// Would giving `itemName` to `person` on schedule[idx] repeat a neighbouring Friday?
export function wouldRepeat(state, idx, person, itemName) {
    if (person === state.fixedPerson) return false;
    const prev = idx > 0 ? state.schedule[idx - 1].assignment[person] : null;
    const next = idx < state.schedule.length - 1 ? state.schedule[idx + 1].assignment[person] : null;
    return prev === itemName || next === itemName;
}

export function addItem(state, name, slots, color) {
    name = (name || '').trim();
    if (!name) return { error: 'اسم البند مطلوب' };
    if (findItem(state, name)) return { error: 'اسم البند موجود سابقاً' };
    const n = parseInt(slots, 10);
    if (isNaN(n) || n < 0) return { error: 'العدد غير صحيح' };
    state.items.push({ name: name, slots: n, color: color || PALETTE[state.items.length % PALETTE.length], fixed: false });
    return { success: true };
}

export function renameItem(state, oldName, newName) {
    newName = (newName || '').trim();
    const item = findItem(state, oldName);
    if (!item) return { error: 'البند غير موجود' };
    if (!newName) return { error: 'الاسم مطلوب' };
    if (newName === oldName) return { success: true };
    if (findItem(state, newName)) return { error: 'يوجد بند بنفس الاسم' };
    item.name = newName;
    state.schedule.forEach(m => {
        for (const p in m.assignment) if (m.assignment[p] === oldName) m.assignment[p] = newName;
    });
    if (state.fixedItem === oldName) state.fixedItem = newName;
    return { success: true };
}

export function setItemColor(state, itemName, color) {
    const item = findItem(state, itemName);
    if (!item) return { error: 'البند غير موجود' };
    item.color = { bg: color.bg, fg: color.fg, border: color.border };
    return { success: true };
}

export function moveItem(state, itemName, dir) {
    const i = state.items.findIndex(it => it.name === itemName);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= state.items.length) return { error: 'لا يمكن النقل' };
    const t = state.items[i]; state.items[i] = state.items[j]; state.items[j] = t;
    return { success: true };
}

// Delete an item; people holding it are moved to `moveTo` (or the delete is refused)
export function deleteItemMoving(state, itemName, moveTo) {
    const item = findItem(state, itemName);
    if (!item) return { error: 'البند غير موجود' };
    if (item.fixed) return { error: 'لا يمكن حذف هذا البند' };
    let used = 0;
    state.schedule.forEach(m => { for (const p in m.assignment) if (m.assignment[p] === itemName) used++; });
    if (used > 0) {
        const target = findItem(state, moveTo);
        if (!target || target.name === itemName) return { error: 'اختاري بنداً لنقل المعيَّنين إليه' };
        if (target.fixed) return { error: 'لا يمكن النقل إلى البند الثابت' };
        state.schedule.forEach(m => {
            for (const p in m.assignment) if (m.assignment[p] === itemName) m.assignment[p] = target.name;
        });
        target.slots += item.slots;
    }
    state.items = state.items.filter(it => it.name !== itemName);
    return { success: true, moved: used };
}

export function renamePerson(state, oldName, newName) {
    newName = (newName || '').trim();
    const idx = state.people.indexOf(oldName);
    if (idx === -1) return { error: 'الشخص غير موجود' };
    if (!newName) return { error: 'الاسم مطلوب' };
    if (newName === oldName) return { success: true };
    if (state.people.includes(newName)) return { error: 'الاسم موجود سابقاً' };
    state.people[idx] = newName;
    state.schedule.forEach(m => {
        if (oldName in m.assignment) {
            m.assignment[newName] = m.assignment[oldName];
            delete m.assignment[oldName];
        }
    });
    if (state.fixedPerson === oldName) state.fixedPerson = newName;
    return { success: true };
}

export function movePerson(state, name, dir) {
    const i = state.people.indexOf(name);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= state.people.length) return { error: 'لا يمكن النقل' };
    const t = state.people[i]; state.people[i] = state.people[j]; state.people[j] = t;
    return { success: true };
}

function totalsError(state) {
    if (totalRotatingSlots(state) === getRotatingPeople(state).length) return null;
    return 'مجموع البنود (' + state.items.reduce((s, it) => s + it.slots, 0) +
        ') لا يساوي عدد الأشخاص (' + state.people.length + ') — عدّلي الأعداد أولاً';
}

// Redistribute ONLY Fridays from index `fromIdx` onward (earlier ones untouched), using the
// optimiser Friday by Friday; several runs, keep the one with the fewest close repeats.
export function regenFrom(state, fromIdx) {
    fromIdx = Math.max(0, fromIdx || 0);
    const err = totalsError(state);
    if (err) return { error: err };
    const backup = state.schedule.slice(fromIdx).map(m => m.assignment);
    let best = null;
    for (let run = 0; run < 12; run++) {
        let ok = true;
        for (let i = fromIdx; i < state.schedule.length; i++) {
            const a = optimizeMonth(state, i, { context: 'before' });
            if (!a) { ok = false; break; }
            state.schedule[i].assignment = a;
        }
        if (!ok) continue;
        const score = repeatStats(state, fromIdx).within;
        if (!best || score < best.score) best = { score: score, plan: state.schedule.slice(fromIdx).map(m => m.assignment) };
        if (score === 0) break;
    }
    const plan = best ? best.plan : backup;
    plan.forEach((a, k) => { state.schedule[fromIdx + k].assignment = a; });
    if (!best) return { error: 'تعذّر إيجاد توزيع صالح — حاولي مرة أخرى' };
    return { success: true, count: state.schedule.length - fromIdx };
}

function monthCountsBad(state, m) {
    const counts = itemCountsForMonth(state, m);
    const validItems = new Set(state.items.map(it => it.name));
    return state.items.some(it => counts[it.name] !== it.slots) ||
        state.people.some(p => !(p in m.assignment) || !validItems.has(m.assignment[p])) ||
        Object.keys(m.assignment).some(p => !state.people.includes(p)) ||
        m.assignment[state.fixedPerson] !== state.fixedItem;
}

function regenOne(state, i) {
    const a = optimizeMonth(state, i, { context: 'all', keep: 40 });
    if (!a) return false;
    state.schedule[i].assignment = a;
    return true;
}

// Repair Fridays from `fromIdx` onward that have problems (wrong counts, missing people,
// consecutive repeats). Each is re-solved by the optimiser with a bonus for keeping the
// current items, so only the necessary changes are made.
export function autoFix(state, fromIdx) {
    fromIdx = Math.max(0, fromIdx || 0);
    const err = totalsError(state);
    if (err) return { error: err };
    let regenerated = 0, failed = 0, changed = 0;
    for (let pass = 0; pass < 2; pass++) {
        for (let i = fromIdx; i < state.schedule.length; i++) {
            const m = state.schedule[i];
            const prevA = i > 0 ? state.schedule[i - 1].assignment : {};
            const nextA = i < state.schedule.length - 1 ? state.schedule[i + 1].assignment : {};
            const repeat = state.people.some(p => p !== state.fixedPerson && m.assignment[p] &&
                (prevA[p] === m.assignment[p] || nextA[p] === m.assignment[p]));
            if (!monthCountsBad(state, m) && !repeat) continue;
            const before = m.assignment;
            if (regenOne(state, i)) {
                regenerated++;
                for (const p in m.assignment) if (before[p] !== m.assignment[p]) changed++;
            } else failed++;
        }
    }
    return { success: true, swaps: changed, regenerated: regenerated, failed: failed };
}

// person → { itemName: count } across all Fridays (fairness overview)
export function personItemStats(state) {
    const stats = {};
    state.people.forEach(p => { stats[p] = {}; });
    state.schedule.forEach(m => {
        for (const p in m.assignment) {
            if (!stats[p]) continue;
            const it = m.assignment[p];
            stats[p][it] = (stats[p][it] || 0) + 1;
        }
    });
    return stats;
}

export const PALETTE = [
    { bg: '#F3D27F', fg: '#4A3405', border: '#C79E3B' },
    { bg: '#F2C193', fg: '#5C3300', border: '#CE8F4B' },
    { bg: '#DFC8F0', fg: '#3F2359', border: '#AE86CF' },
    { bg: '#B8E0C3', fg: '#0F4A26', border: '#74B98A' },
    { bg: '#DCE9A4', fg: '#3A4A0E', border: '#A8BE59' },
    { bg: '#F6BFA4', fg: '#6E2708', border: '#DE8A5D' },
    { bg: '#BBDCEF', fg: '#0E3D5C', border: '#79AFCF' },
    { bg: '#F5C6D6', fg: '#5E1631', border: '#D98AA5' },
    { bg: '#C9D3F5', fg: '#1E2C66', border: '#8C9EDB' },
    { bg: '#BFE6E0', fg: '#0D4A42', border: '#76BDB2' },
    { bg: '#E8D5C0', fg: '#4A3220', border: '#BF9F7E' },
    { bg: '#E0E0E0', fg: '#333333', border: '#A8A8A8' },
];

// Issues that still matter: past Fridays are history — their counts/repeats are
// not flagged (changing an item's count must not make old Fridays "wrong").
export function relevantIssues(state) {
    const up = upcomingIndex(state.schedule);
    const firstLive = up === -1 ? state.schedule.length : up;
    const idxOf = {};
    state.schedule.forEach((m, i) => { idxOf[m.date.n] = i; });
    return verifyConstraints(state).filter(is => is.monthN == null || idxOf[is.monthN] >= firstLive);
}

// Add a person from schedule[fromIdx] onward only — past Fridays stay exactly as they were
// (the new person simply doesn't appear in them). Uses the original addPerson for the
// placement, then restores history and repairs any repeat at the boundary.
export function addPersonFrom(state, personName, primaryItemName, position, isNewItem, newItemSlots, fromIdx) {
    fromIdx = Math.max(0, fromIdx || 0);
    const past = state.schedule.slice(0, fromIdx).map(m => JSON.stringify(m.assignment));
    const r = addPerson(state, personName, primaryItemName, position, isNewItem, newItemSlots);
    if (r.error) return r;
    past.forEach((json, i) => { state.schedule[i].assignment = JSON.parse(json); });
    if (fromIdx < state.schedule.length) optimizeFrom(state, fromIdx);
    return { success: true };
}

// ==================== Optimal distribution (repeat-window rule) ====================
// Each Friday is solved as an assignment problem (Hungarian algorithm) over
// people × item-slots, minimising:
//   - HARD:  same item as the previous/next Friday (consecutive repeat)
//   - STRONG: same item within the last `repeatMonths` months (closer = worse)
//   - SOFT:  items the person has had often overall (spreads الورقيات/مغاسل around)
//   - SOFT:  changing the current assignment (only when repairing → minimal change)
// A full ban is often impossible (more Fridays in the window than items a person can
// rotate through), so this yields the best achievable spacing instead of failing.

const DAY = 86400000;
const MONTH_DAYS = 30.44;

export function getRepeatMonths(state) {
    const n = state.rules && parseInt(state.rules.repeatMonths, 10);
    return n > 0 ? n : 8;
}

function dateTime(m) { return gregTime(m.date.greg); }

// Hungarian algorithm (min-cost perfect matching), square matrix a[n][n] → col for each row
function hungarian(a) {
    const n = a.length;
    const INF = 1e18;
    const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
    const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(n + 1).fill(INF);
        const used = new Array(n + 1).fill(false);
        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = INF, j1 = 0;
            for (let j = 1; j <= n; j++) {
                if (used[j]) continue;
                const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                if (minv[j] < delta) { delta = minv[j]; j1 = j; }
            }
            for (let j = 0; j <= n; j++) {
                if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
                else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const res = new Array(n);
    for (let j = 1; j <= n; j++) if (p[j]) res[p[j] - 1] = j - 1;
    return res;
}

// Build the best assignment for schedule[idx].
// opts.context: 'before' = only earlier Fridays count (sequential regeneration),
//               'all'    = earlier and later Fridays count (repairing one Friday)
// opts.keep:    bonus for keeping the current item (minimal-change repair)
export function optimizeMonth(state, idx, opts) {
    opts = opts || {};
    const rotPeople = getRotatingPeople(state);
    const slots = [];
    getRotatingItems(state).forEach(it => { for (let k = 0; k < it.slots; k++) slots.push(it.name); });
    if (slots.length !== rotPeople.length || !slots.length) return null;

    const target = state.schedule[idx];
    const tTime = dateTime(target);
    const windowDays = getRepeatMonths(state) * MONTH_DAYS;
    const others = state.schedule
        .map((m, j) => ({ m: m, j: j }))
        .filter(o => o.j !== idx && (opts.context === 'all' || o.j < idx));
    const prevA = idx > 0 ? state.schedule[idx - 1].assignment : {};
    const nextA = opts.context === 'all' && idx < state.schedule.length - 1 ? state.schedule[idx + 1].assignment : {};

    const cost = rotPeople.map(person => {
        // per item: recency penalty + overall count
        const pen = {};
        others.forEach(o => {
            const it = o.m.assignment[person];
            if (!it) return;
            const gap = tTime != null && dateTime(o.m) != null ? Math.abs(tTime - dateTime(o.m)) / DAY : 9999;
            let c = 3; // overall fairness: every past occurrence counts a little
            if (gap < windowDays) {
                const closeness = (windowDays - gap) / MONTH_DAYS; // months inside the window
                c += 100 + Math.pow(6, closeness); // exponential: one nearer repeat outweighs several farther ones
            }
            pen[it] = (pen[it] || 0) + c;
        });
        const current = target.assignment[person];
        return slots.map(it => {
            let c = pen[it] || 0;
            if (prevA[person] === it || nextA[person] === it) c += 1e7;
            if (opts.keep && current === it) c -= opts.keep;
            return c + Math.random() * 0.5; // tie-break → variety between runs
        });
    });

    const cols = hungarian(cost);
    const assign = {};
    let total = 0;
    rotPeople.forEach((p, r) => { assign[p] = slots[cols[r]]; total += cost[r][cols[r]]; });
    if (total >= 1e7) return null; // a consecutive repeat was unavoidable
    assign[state.fixedPerson] = state.fixedItem;
    return assign;
}

// Spacing report: repeats of the same item within the window, counted on Fridays from
// `fromIdx` onward (earlier Fridays still count as history they are compared against)
export function repeatStats(state, fromIdx) {
    fromIdx = fromIdx || 0;
    const windowDays = getRepeatMonths(state) * MONTH_DAYS;
    const people = getRotatingPeople(state);
    let within = 0, minGap = Infinity;
    const perPerson = {};
    people.forEach(p => {
        const seen = {};
        let n = 0;
        state.schedule.forEach((m, idx) => {
            const it = m.assignment[p];
            const t = dateTime(m);
            if (!it || t == null) return;
            if (seen[it] != null && idx >= fromIdx) {
                const gap = (t - seen[it]) / DAY;
                minGap = Math.min(minGap, gap);
                if (gap < windowDays) n++;
            }
            seen[it] = t;
        });
        perPerson[p] = n;
        within += n;
    });
    return { within: within, minGapMonths: minGap === Infinity ? null : Math.round(minGap / MONTH_DAYS * 10) / 10, perPerson: perPerson };
}

// Improve spacing from `fromIdx` onward with minimal changes: every Friday is re-solved
// with a bonus for keeping current items, so an item only moves when that reduces
// close repeats (also fixes wrong counts / consecutive repeats along the way).
export function optimizeFrom(state, fromIdx) {
    fromIdx = Math.max(0, fromIdx || 0);
    const err = totalsError(state);
    if (err) return { error: err };
    const before = repeatStats(state, fromIdx).within;
    let changed = 0;
    for (let pass = 0; pass < 3; pass++) {
        let passChanged = 0;
        for (let i = fromIdx; i < state.schedule.length; i++) {
            const old = state.schedule[i].assignment;
            const a = optimizeMonth(state, i, { context: 'all', keep: 40 });
            if (!a) continue;
            for (const p in a) if (old[p] !== a[p]) passChanged++;
            state.schedule[i].assignment = a;
        }
        changed += passChanged;
        if (!passChanged) break;
    }
    return { success: true, changed: changed, before: before, after: repeatStats(state, fromIdx).within };
}
