// Small UI kit: toasts + modal dialogs (replaces alert / confirm / prompt,
// which are blocked or ugly on iOS and inside WhatsApp's in-app browser).

export function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const k in attrs) {
            const v = attrs[k];
            if (v == null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'html') node.innerHTML = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
    }
    (Array.isArray(children) ? children : children != null ? [children] : []).forEach(c => {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
}

// ---------- Toast ----------
let toastHost = null;
export function toast(message, opts) {
    opts = opts || {};
    if (!toastHost) {
        toastHost = el('div', { class: 'toast-host no-export', 'aria-live': 'polite' });
        document.body.appendChild(toastHost);
    }
    const t = el('div', { class: 'toast ' + (opts.kind || 'info') }, [el('span', { class: 'toast-msg', text: message })]);
    if (opts.action) {
        t.appendChild(el('button', {
            type: 'button', class: 'toast-action', text: opts.action.label,
            onclick: () => { opts.action.onClick(); dismiss(); }
        }));
    }
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    let timer = setTimeout(dismiss, opts.duration || (opts.action ? 6000 : 3200));
    function dismiss() {
        clearTimeout(timer);
        t.classList.remove('show');
        setTimeout(() => t.remove(), 250);
    }
    return dismiss;
}

// ---------- Modal ----------
const openModals = [];

// actions: [{ label, kind:'primary'|'secondary'|'danger', value, close:true }]
// Resolves with the clicked action's value (or `null` on dismiss).
export function modal(opts) {
    return new Promise((resolve) => {
        const overlay = el('div', { class: 'modal-overlay no-export' + (opts.sheet ? ' sheet' : '') });
        const box = el('div', { class: 'modal-box' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
        const head = el('div', { class: 'modal-head' }, [
            el('h3', { class: 'modal-title', text: opts.title || '' }),
            el('button', { type: 'button', class: 'modal-x', 'aria-label': 'إغلاق', text: '✕', onclick: () => close(null) })
        ]);
        const body = el('div', { class: 'modal-body' });
        if (typeof opts.body === 'string') body.innerHTML = opts.body;
        else if (opts.body) body.appendChild(opts.body);
        box.appendChild(head);
        box.appendChild(body);

        const error = el('div', { class: 'form-error', hidden: true });
        body.appendChild(error);

        if (opts.actions && opts.actions.length) {
            const foot = el('div', { class: 'modal-actions' });
            opts.actions.forEach(a => {
                foot.appendChild(el('button', {
                    type: 'button', class: 'btn ' + (a.kind || 'secondary'), text: a.label,
                    onclick: async () => {
                        if (a.onClick) {
                            const r = await a.onClick(api);
                            if (r && r.error) { showError(r.error); return; }
                            if (r === false) return;
                        }
                        close(a.value !== undefined ? a.value : true);
                    }
                }));
            });
            box.appendChild(foot);
        }
        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        document.body.appendChild(overlay);
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => overlay.classList.add('show'));

        function showError(msg) { error.textContent = msg; error.hidden = !msg; }
        function close(value) {
            const i = openModals.indexOf(api);
            if (i !== -1) openModals.splice(i, 1);
            overlay.classList.remove('show');
            setTimeout(() => {
                overlay.remove();
                if (openModals.length === 0) document.body.classList.remove('modal-open');
            }, 180);
            if (opts.onClose) opts.onClose(value);
            resolve(value);
        }
        const api = { close: close, showError: showError, body: body, box: box };
        openModals.push(api);
        if (opts.onOpen) opts.onOpen(api);
        const first = box.querySelector('input:not([type=hidden]), select, textarea');
        if (first && !opts.noAutofocus) setTimeout(() => first.focus(), 60);
    });
}

export function closeTopModal() {
    const top = openModals[openModals.length - 1];
    if (top) { top.close(null); return true; }
    return false;
}
export function hasOpenModal() { return openModals.length > 0; }

export function confirmDialog(message, opts) {
    opts = opts || {};
    return modal({
        title: opts.title || 'تأكيد',
        body: el('p', { class: 'modal-text', text: message }),
        actions: [
            { label: opts.cancel || 'إلغاء', kind: 'secondary', value: false },
            { label: opts.ok || 'موافق', kind: opts.danger ? 'danger' : 'primary', value: true },
        ]
    }).then(v => v === true);
}

export function alertDialog(message, title) {
    return modal({
        title: title || 'تنبيه',
        body: el('p', { class: 'modal-text', text: message }),
        actions: [{ label: 'حسناً', kind: 'primary', value: true }]
    });
}

// fields: [{ name, label, type:'text'|'number'|'date'|'select'|'textarea'|'password', value,
//            options:[{value,label}], placeholder, hint, min, max, onInput(values, inputs) }]
// submit(values) may return {error} to keep the dialog open. Resolves with values or null.
export function formDialog(opts) {
    const form = el('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); submitBtn && submitBtn.click(); } });
    const inputs = {};
    opts.fields.forEach(f => {
        let input;
        if (f.type === 'select') {
            input = el('select', { name: f.name });
            (f.options || []).forEach(o => {
                const opt = el('option', { value: o.value, text: o.label });
                if (String(o.value) === String(f.value)) opt.selected = true;
                input.appendChild(opt);
            });
        } else if (f.type === 'textarea') {
            input = el('textarea', { name: f.name, rows: f.rows || 6, placeholder: f.placeholder || '' });
            input.value = f.value || '';
        } else {
            input = el('input', {
                name: f.name, type: f.type || 'text', placeholder: f.placeholder || '',
                min: f.min, max: f.max, autocomplete: 'off', dir: f.dir
            });
            input.value = f.value == null ? '' : f.value;
        }
        inputs[f.name] = input;
        const hint = f.hint ? el('div', { class: 'field-hint', 'data-hint-for': f.name, text: f.hint }) : null;
        const wrap = el('label', { class: 'field' + (f.hidden ? ' is-hidden' : ''), 'data-field': f.name }, [
            el('span', { class: 'field-label', text: f.label }), input, hint
        ]);
        form.appendChild(wrap);
    });
    const values = () => {
        const v = {};
        for (const k in inputs) v[k] = inputs[k].value;
        return v;
    };
    opts.fields.forEach(f => {
        if (f.onInput) {
            const handler = () => f.onInput(values(), inputs, form);
            inputs[f.name].addEventListener('input', handler);
            inputs[f.name].addEventListener('change', handler);
        }
    });
    if (opts.extra) form.appendChild(opts.extra);
    form.appendChild(el('button', { type: 'submit', hidden: true }));

    let submitBtn = null;
    return modal({
        title: opts.title,
        body: form,
        wide: opts.wide,
        onOpen: (api) => {
            submitBtn = api.box.querySelector('.modal-actions .btn.primary, .modal-actions .btn.danger');
            opts.fields.forEach(f => { if (f.onInput) f.onInput(values(), inputs, form); });
        },
        actions: [
            { label: 'إلغاء', kind: 'secondary', value: null },
            {
                label: opts.submitLabel || 'حفظ', kind: opts.danger ? 'danger' : 'primary',
                onClick: () => {
                    const v = values();
                    if (opts.submit) {
                        const r = opts.submit(v);
                        if (r && r.error) return r;
                    }
                    lastValues = v;
                },
                value: '__ok__'
            }
        ]
    }).then(res => res === '__ok__' ? lastValues : null);
}
let lastValues = null;

// iOS Safari sometimes swallows synthetic clicks; bind click + guarded touchend.
export function bindTap(node, handler) {
    node.addEventListener('click', handler);
    let x = 0, y = 0;
    node.addEventListener('touchstart', (e) => { x = e.touches[0].clientX; y = e.touches[0].clientY; }, { passive: true });
    node.addEventListener('touchend', (e) => {
        if (node.disabled) return;
        const t = e.changedTouches[0];
        if (Math.abs(t.clientX - x) > 12 || Math.abs(t.clientY - y) > 12) return;
        e.preventDefault();
        handler(e);
    });
}
