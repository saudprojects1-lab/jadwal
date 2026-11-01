// PNG export of a schedule card via html2canvas (settings kept from the original:
// scale 3, laid out at 800px wide, Web Share on phones, preview modal fallback).

import { el } from './ui.js';

export function sanitizeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, '_');
}

function isExportMobile() {
    return window.innerWidth <= 640 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function prepareForCapture(section) {
    const stash = [];
    section.querySelectorAll('.no-export').forEach(n => {
        stash.push([n, n.style.visibility]);
        n.style.visibility = 'hidden';
    });
    section.classList.add('exporting');
    let displayStash = null;
    if (getComputedStyle(section).display === 'none') {
        displayStash = section.style.display;
        section.style.display = 'block';
    }
    return function cleanup() {
        stash.forEach(([n, v]) => { n.style.visibility = v; });
        section.classList.remove('exporting');
        if (displayStash !== null) section.style.display = displayStash;
    };
}

async function renderBlob(section) {
    if (typeof html2canvas !== 'function') throw new Error('مكتبة تصدير الصور لم تُحمَّل — تحققي من الإنترنت');
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const cleanup = prepareForCapture(section);
    try {
        const canvas = await html2canvas(section, {
            scale: 3, backgroundColor: '#FFFFFF', useCORS: true, allowTaint: false, logging: false, windowWidth: 800,
        });
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png', 1.0);
        });
        return { blob: blob, dataUrl: canvas.toDataURL('image/png', 1.0) };
    } finally {
        cleanup();
    }
}

function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function tryShare(files) {
    if (!navigator.canShare || !navigator.share) return false;
    try {
        if (!navigator.canShare({ files: files })) return false;
        await navigator.share({ files: files, title: 'جدول الضيافة' });
        return true;
    } catch (e) {
        if (e.name === 'AbortError') return true; // user cancelled — not an error
        console.warn('share failed, falling back:', e);
        return false;
    }
}

function showPreview(images) {
    const overlay = el('div', { class: 'image-preview-modal no-export' });
    const box = el('div', { class: 'image-preview-box' });
    const close = () => overlay.remove();
    box.appendChild(el('button', { class: 'image-preview-close-btn', type: 'button', 'aria-label': 'إغلاق', text: '✕', onclick: close }));
    box.appendChild(el('p', { class: 'image-preview-hint', text: 'اضغطي مطولاً على الصورة لحفظها أو مشاركتها · أو استخدمي الأزرار أدناه' }));
    const wrap = el('div', { class: 'image-preview-img-wrap' });
    images.forEach(im => wrap.appendChild(el('img', { src: im.dataUrl, alt: 'جدول الضيافة' })));
    box.appendChild(wrap);
    const actions = el('div', { class: 'image-preview-actions' });
    if (images.length === 1) {
        actions.appendChild(el('a', { class: 'primary', href: images[0].dataUrl, download: images[0].filename, html: '<span>📥</span> تنزيل' }));
    } else {
        actions.appendChild(el('button', { class: 'primary', type: 'button', html: '<span>📥</span> تنزيل الكل',
            onclick: () => images.forEach((im, i) => setTimeout(() => download(im.blob, im.filename), i * 350)) }));
    }
    actions.appendChild(el('button', { class: 'secondary', type: 'button', text: 'إغلاق', onclick: close }));
    box.appendChild(actions);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
}

export async function exportSection(section, filename) {
    const { blob, dataUrl } = await renderBlob(section);
    if (isExportMobile()) {
        if (await tryShare([new File([blob], filename, { type: 'image/png' })])) return;
        showPreview([{ blob: blob, dataUrl: dataUrl, filename: filename }]);
    } else {
        download(blob, filename);
    }
}

// Export several cards. onProgress(i, total) for UI feedback.
export async function exportSections(list, onProgress) {
    const images = [];
    for (let i = 0; i < list.length; i++) {
        if (onProgress) onProgress(i + 1, list.length);
        const r = await renderBlob(list[i].section);
        images.push({ blob: r.blob, dataUrl: r.dataUrl, filename: list[i].filename });
    }
    if (isExportMobile()) {
        const files = images.map(im => new File([im.blob], im.filename, { type: 'image/png' }));
        if (await tryShare(files)) return;
        showPreview(images);
    } else {
        images.forEach((im, i) => setTimeout(() => download(im.blob, im.filename), i * 350));
    }
}
