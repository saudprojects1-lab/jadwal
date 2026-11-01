// SHA-256 + iterated password hash — kept byte-for-byte compatible with the
// original single-file version so the existing admin password keeps working.

export function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Fallback for very old browsers / webviews
    const esc = unescape(encodeURIComponent(str));
    const arr = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) arr[i] = esc.charCodeAt(i);
    return arr;
}
export function sha256Hex(str) {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
               0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
               0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
               0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
               0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
               0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
               0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
               0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a,
        H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;
    const bytes = utf8Bytes(str);
    const l = bytes.length;
    const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[l] = 0x80;
    const dv = new DataView(padded.buffer);
    const bitLen = l * 8;
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H0 = (H0 + a) >>> 0; H1 = (H1 + b) >>> 0; H2 = (H2 + c) >>> 0; H3 = (H3 + d) >>> 0;
        H4 = (H4 + e) >>> 0; H5 = (H5 + f) >>> 0; H6 = (H6 + g) >>> 0; H7 = (H7 + h) >>> 0;
    }
    return [H0, H1, H2, H3, H4, H5, H6, H7]
        .map(x => x.toString(16).padStart(8, '0')).join('');
}

// Mirrors the original hash format: sha256(salt:password) iterated
export function computeAuthHash(password, salt, iterations) {
    let h = sha256Hex(salt + ':' + password);
    for (let i = 1; i < iterations; i++) h = sha256Hex(h);
    return h;
}

export function randomSaltHex(nBytes) {
    const arr = new Uint8Array(nBytes);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    let s = '';
    for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
    return s;
}

// ---------- Login (no lockout) — remembered on this device until "خروج" ----------
const SESSION_KEY = 'hospitality_admin_session';

export function verifyPassword(auth, password) {
    let ok = false;
    try { ok = computeAuthHash(password, auth.salt, auth.iter) === auth.hash; }
    catch (e) { console.error('hash failed:', e); }
    if (ok) setSession(auth.hash);
    return ok;
}

export function setSession(hash) {
    try { localStorage.setItem(SESSION_KEY, hash); } catch (e) {}
}
export function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
export function hasValidSession(auth) {
    if (!auth || !auth.hash) return false;
    try { return localStorage.getItem(SESSION_KEY) === auth.hash; }
    catch (e) { return false; }
}

export function makeAuth(password, iter) {
    iter = iter || 20000;
    const salt = randomSaltHex(16);
    return { algo: 'sha256-iter', salt: salt, iter: iter, hash: computeAuthHash(password, salt, iter) };
}
