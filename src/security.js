import crypto from 'node:crypto';

// ---- Criptografia de tokens em repouso (AES-256-GCM) ----
export function makeCipher(secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
    },
    decrypt(payload) {
      const [iv, tag, enc] = String(payload).split('.').map((s) => Buffer.from(s, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    },
  };
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Assinatura do webhook da Meta (X-Hub-Signature-256) ----
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

// ---- Cookies assinados (sessão do painel e state do OAuth) ----
export function makeSigner(secret) {
  const key = crypto.createHash('sha256').update('cookie:' + secret).digest();
  const sig = (v) => crypto.createHmac('sha256', key).update(v).digest('base64url');
  return {
    sign(obj) {
      const v = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return `${v}.${sig(v)}`;
    },
    verify(token) {
      if (!token || typeof token !== 'string') return null;
      const [v, s] = token.split('.');
      if (!v || !s || !safeEqual(sig(v), s)) return null;
      try {
        const obj = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
        if (obj.exp && obj.exp < Date.now()) return null;
        return obj;
      } catch { return null; }
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, path = '/', sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

// Limitador simples em memória (login).
export function makeRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
}
