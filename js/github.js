// Read / write data.json through the GitHub Contents API.
// The API is never cached (unlike the GitHub Pages site), so the admin always edits
// the true latest version, and the file `sha` gives us conflict detection.

import { utf8Bytes } from './auth.js';

const TOKEN_KEY = 'hospitality_gh_token';

export function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
export function setToken(token) {
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
}

export class GhError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function apiUrl(cfg) {
    return 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' +
        encodeURIComponent(cfg.repo) + '/contents/' +
        String(cfg.path || 'data.json').split('/').map(encodeURIComponent).join('/');
}

function headers(token) {
    return {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

function statusMessage(status, writing) {
    if (status === 401) return 'رمز الوصول غير صحيح أو منتهي الصلاحية (401)';
    if (status === 403) return writing ? 'الرمز لا يملك صلاحية الكتابة على المستودع (403)' : 'الرمز لا يملك صلاحية على هذا المستودع (403)';
    if (status === 404) return 'المستودع أو الملف غير موجود، أو الرمز بلا صلاحية عليه (404)';
    if (status === 409 || status === 422) return 'تم تعديل الملف من جهاز آخر (تعارض)';
    return 'فشل الاتصال بـ GitHub (' + status + ')';
}

export function b64EncodeUtf8(str) {
    const bytes = utf8Bytes(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export function b64DecodeUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

// → { data, sha } or { data:null, sha:null } when the file doesn't exist yet
export async function fetchRemote(cfg, token) {
    let res;
    try {
        res = await fetch(apiUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch || 'main') + '&t=' + Date.now(),
            { headers: headers(token), cache: 'no-store' });
    } catch (e) {
        throw new GhError(0, 'تعذّر الاتصال — تحققي من الإنترنت');
    }
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new GhError(res.status, statusMessage(res.status, false));
    const info = await res.json();
    let text;
    if (info.content) {
        text = b64DecodeUtf8(info.content);
    } else if (info.download_url) {
        // > 1MB files come without inline content
        const raw = await fetch(info.download_url + '?t=' + Date.now(), { cache: 'no-store' });
        text = await raw.text();
    } else {
        throw new GhError(0, 'استجابة غير متوقعة من GitHub');
    }
    return { data: JSON.parse(text), sha: info.sha };
}

// Writes data.json. `sha` must be the version we based our edits on (null = new file).
// → { sha } of the new version. Throws GhError (status 409/422 = conflict).
export async function saveRemote(cfg, token, data, sha, message) {
    const body = {
        message: message || 'تحديث جدول الضيافة',
        content: b64EncodeUtf8(JSON.stringify(data, null, 2) + '\n'),
        branch: cfg.branch || 'main'
    };
    if (sha) body.sha = sha;
    let res;
    try {
        res = await fetch(apiUrl(cfg), { method: 'PUT', headers: headers(token), body: JSON.stringify(body) });
    } catch (e) {
        throw new GhError(0, 'تعذّر الاتصال — تحققي من الإنترنت');
    }
    if (!res.ok) {
        // GitHub answers 409 for a stale sha, 422 when sha is missing for an existing file
        throw new GhError(res.status, statusMessage(res.status, true));
    }
    const out = await res.json();
    return { sha: out.content && out.content.sha };
}

export function isConflict(err) {
    return err && (err.status === 409 || err.status === 422);
}

export function siteUrl(cfg) {
    return 'https://' + cfg.owner + '.github.io/' + cfg.repo + '/';
}
