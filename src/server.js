import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyMetaSignature, makeSigner, parseCookies, cookie, safeEqual, makeRateLimiter } from './security.js';
import { ingestWebhook, MAX_DM_LENGTH, parseKeywords } from './automation.js';
import { GraphError } from './graph.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SESSION_TTL = 7 * 86400_000;
const MAX_BODY = 1024 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function createServer({ cfg, repo, graph, cipher, settings, worker, log = console.log }) {
  // Recriado a cada uso porque a senha (parte do segredo) pode mudar pelo painel.
  const signer = () => makeSigner(settings.signerSecret());
  const loginLimiter = makeRateLimiter({ max: 10, windowMs: 15 * 60_000 });

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const redirect = (res, to, headers = {}) => send(res, 302, '', { Location: to, ...headers });

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Corpo muito grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => {
    if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Use application/json');
    try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON inválido'); }
  };
  const session = (req) => signer().verify(parseCookies(req.headers.cookie).sid);
  const requireSession = (req) => { if (!session(req)) throw new HttpError(401, 'Faça login'); };
  // Proteção CSRF: além de SameSite=Lax, toda mutação precisa vir da mesma origem.
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    return o === new URL(cfg.baseUrl).origin || o === `http://${req.headers.host}` || o === `https://${req.headers.host}`;
  };
  const clientIp = (req) => {
    // Atrás do proxy reverso (Nginx), o IP real vem no X-Forwarded-For.
    const fwd = cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.socket.remoteAddress || '?';
  };
  const startSession = (res) => {
    const sid = signer().sign({ exp: Date.now() + SESSION_TTL, n: crypto.randomUUID() });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('sid', sid, { maxAge: SESSION_TTL / 1000, secure: cfg.secureCookies }) });
  };
  const validPassword = (p) => {
    if (typeof p !== 'string' || p.length < 10 || p.length > 200) throw new HttpError(400, 'A senha precisa ter de 10 a 200 caracteres');
    return p;
  };
  const currentAccount = () => repo.primaryAccount();
  const requireAccount = () => { const a = currentAccount(); if (!a) throw new HttpError(409, 'Conecte uma conta do Instagram primeiro'); return a; };
  const publicAccount = (a) => a && ({
    id: a.id, ig_user_id: a.ig_user_id, username: a.username, profile_picture: a.profile_picture,
    status: a.status, status_detail: a.status_detail, token_expires_at: a.token_expires_at,
  });

  function validateAutomation(d, partial = false) {
    const out = {};
    if (!partial || d.keyword !== undefined) {
      if (!parseKeywords(d.keyword).length || String(d.keyword).length > 100) throw new HttpError(400, 'Informe a palavra-chave (até 100 caracteres)');
      out.keyword = String(d.keyword).trim();
    }
    if (!partial || d.link !== undefined) {
      let u; try { u = new URL(String(d.link).trim()); } catch { throw new HttpError(400, 'Link inválido'); }
      if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, 'O link deve começar com https://');
      out.link = u.toString();
    }
    if (!partial || d.message !== undefined) {
      const m = String(d.message ?? '').trim();
      if (!m) throw new HttpError(400, 'Escreva a mensagem');
      out.message = m;
    }
    if (d.active !== undefined) out.active = !!d.active;
    return out;
  }

  // ---------- rotas ----------
  async function route(req, res, url) {
    const { pathname } = url;
    const m = req.method;

    if (pathname === '/healthz') return send(res, 200, { ok: true });

    // ===== Webhook da Meta =====
    if (pathname === '/webhook' && m === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      if (mode === 'subscribe' && token && cfg.webhookVerifyToken && safeEqual(token, cfg.webhookVerifyToken)) {
        return send(res, 200, url.searchParams.get('hub.challenge') || '', { 'Content-Type': 'text/plain' });
      }
      return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
    }
    if (pathname === '/webhook' && m === 'POST') {
      if (!cfg.igAppSecret) return send(res, 503, { error: 'App Secret não configurado' });
      const raw = await readBody(req);
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], cfg.igAppSecret)) {
        log('webhook rejeitado: assinatura inválida');
        return send(res, 401, { error: 'assinatura inválida' });
      }
      let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'json' }); }
      const queued = ingestWebhook(repo, payload, log);
      send(res, 200, 'EVENT_RECEIVED', { 'Content-Type': 'text/plain' }); // responde rápido
      if (queued) setImmediate(() => worker.tick().catch((e) => log('worker:', e.message)));
      return;
    }

    // ===== Login do painel =====
    if (pathname === '/api/setup' && m === 'GET') return send(res, 200, { needsSetup: settings.needsSetup() });
    if (pathname === '/api/setup' && m === 'POST') {
      // Primeiro acesso: cria a senha do painel com o código impresso no log do servidor.
      if (!settings.needsSetup()) throw new HttpError(409, 'A senha já foi criada');
      if (!sameOrigin(req)) throw new HttpError(403, 'Origem não permitida');
      if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
      const { code, password } = await readJson(req);
      if (!settings.checkSetupCode(code)) throw new HttpError(401, 'Código de configuração incorreto');
      settings.setPassword(validPassword(password));
      log('senha do painel criada');
      return startSession(res);
    }
    if (pathname === '/api/login' && m === 'POST') {
      if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
      if (settings.needsSetup()) throw new HttpError(409, 'Crie a senha do painel primeiro');
      const { password } = await readJson(req);
      if (!password || !settings.checkPassword(password)) throw new HttpError(401, 'Senha incorreta');
      return startSession(res);
    }
    if (pathname === '/api/logout' && m === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('sid', '', { maxAge: 0, secure: cfg.secureCookies }) });
    }

    // ===== OAuth: Business Login for Instagram =====
    if (pathname === '/auth/instagram/start' && m === 'GET') {
      if (!session(req)) return redirect(res, '/login.html');
      if (!settings.metaReady()) return redirect(res, '/?erro=' + encodeURIComponent('Preencha o App ID e o App Secret da Meta em Configurações'));
      const state = crypto.randomBytes(24).toString('base64url');
      return redirect(res, graph.authorizeUrl(state), {
        'Set-Cookie': cookie('oauth_state', signer().sign({ state, exp: Date.now() + 10 * 60_000 }), { maxAge: 600, secure: cfg.secureCookies }),
      });
    }
    if (pathname === '/auth/instagram/callback' && m === 'GET') {
      if (!session(req)) return redirect(res, '/login.html');
      const clear = cookie('oauth_state', '', { maxAge: 0, secure: cfg.secureCookies });
      const saved = signer().verify(parseCookies(req.headers.cookie).oauth_state);
      const state = url.searchParams.get('state');
      if (url.searchParams.get('error')) return redirect(res, `/?erro=${encodeURIComponent(url.searchParams.get('error_description') || 'Login cancelado')}`, { 'Set-Cookie': clear });
      if (!saved || !state || !safeEqual(saved.state, state)) return redirect(res, '/?erro=' + encodeURIComponent('Sessão de login expirada, tente de novo'), { 'Set-Cookie': clear });
      const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
      try {
        const short = await graph.exchangeCode(code);
        const missing = cfg.scopes.filter((s) => short.permissions && !short.permissions.includes(s));
        if (missing.length) throw new Error(`Permissões não concedidas: ${missing.join(', ')}`);
        const long = await graph.longLived(short.accessToken);
        const me = await graph.me(long.accessToken);
        await graph.subscribe(long.accessToken);
        repo.upsertAccount({
          igUserId: String(me.user_id || me.id), username: me.username, profilePicture: me.profile_picture_url,
          tokenEnc: cipher.encrypt(long.accessToken), issuedAt: Date.now(), expiresAt: Date.now() + long.expiresIn * 1000,
        });
        log(`conta conectada: @${me.username}`);
        return redirect(res, '/?conectado=1', { 'Set-Cookie': clear });
      } catch (err) {
        log('falha no OAuth:', err.message);
        return redirect(res, '/?erro=' + encodeURIComponent(err.message), { 'Set-Cookie': clear });
      }
    }

    // ===== API do painel (exige sessão) =====
    if (pathname.startsWith('/api/')) {
      requireSession(req);
      if (m !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Origem não permitida');

      if (pathname === '/api/me' && m === 'GET') return send(res, 200, { account: publicAccount(currentAccount()), metaReady: settings.metaReady() });

      if (pathname === '/api/settings' && m === 'GET') return send(res, 200, settings.view());
      if (pathname === '/api/settings' && m === 'PUT') {
        const d = await readJson(req);
        const str = (v, max) => (v === undefined ? undefined : String(v).trim().slice(0, max));
        const igAppId = str(d.igAppId, 40);
        if (igAppId && !/^\d+$/.test(igAppId)) throw new HttpError(400, 'O App ID tem só números');
        const webhookVerifyToken = str(d.webhookVerifyToken, 200);
        if (webhookVerifyToken !== undefined && !/^\S{8,}$/.test(webhookVerifyToken)) throw new HttpError(400, 'O Verify token precisa ter ao menos 8 caracteres, sem espaços');
        settings.update({ igAppId, igAppSecret: str(d.igAppSecret, 200), webhookVerifyToken });
        log('configurações da Meta atualizadas pelo painel');
        return send(res, 200, settings.view());
      }
      if (pathname === '/api/password' && m === 'POST') {
        if (settings.passwordLocked()) throw new HttpError(409, 'A senha está definida em ADMIN_PASSWORD no servidor');
        if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
        const { current, password } = await readJson(req);
        if (!current || !settings.checkPassword(current)) throw new HttpError(400, 'Senha atual incorreta'); // 401 deslogaria o painel
        settings.setPassword(validPassword(password));
        return startSession(res); // a sessão antiga deixa de valer com a senha nova
      }

      if (pathname === '/api/account' && m === 'DELETE') {
        const a = requireAccount();
        try { await graph.unsubscribe(cipher.decrypt(a.access_token_enc)); } catch (e) { log('unsubscribe:', e.message); }
        repo.deleteAccount(a.id);
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/media' && m === 'GET') {
        const a = requireAccount();
        const r = await graph.listMedia(cipher.decrypt(a.access_token_enc), url.searchParams.get('after') || undefined);
        const used = new Set(repo.listAutomations(a.id).map((x) => x.media_id));
        return send(res, 200, { items: r.items.map((i) => ({ ...i, has_automation: used.has(i.id) })), next: r.next });
      }

      if (pathname === '/api/automations' && m === 'GET') {
        return send(res, 200, { items: repo.listAutomations(requireAccount().id) });
      }
      if (pathname === '/api/automations' && m === 'POST') {
        const a = requireAccount();
        const d = await readJson(req);
        const v = validateAutomation(d);
        if (`${v.message}\n\n${v.link}`.length > MAX_DM_LENGTH) throw new HttpError(400, `Mensagem + link passam de ${MAX_DM_LENGTH} caracteres`);
        if (!d.media_id || !/^\d+$/.test(String(d.media_id))) throw new HttpError(400, 'Selecione uma publicação');
        if (repo.automationByMedia(a.id, d.media_id)) throw new HttpError(409, 'Esta publicação já tem uma automação');
        const created = repo.createAutomation(a.id, {
          ...v, active: v.active ?? true, media_id: String(d.media_id),
          media_type: String(d.media_type || '').slice(0, 40), media_permalink: String(d.media_permalink || '').slice(0, 500),
          media_caption: String(d.media_caption || '').slice(0, 300), media_thumb: String(d.media_thumb || '').slice(0, 2000),
        });
        return send(res, 201, created);
      }
      const am = pathname.match(/^\/api\/automations\/(\d+)$/);
      if (am) {
        const a = requireAccount();
        const auto = repo.automationById(Number(am[1]));
        if (!auto || auto.account_id !== a.id) throw new HttpError(404, 'Automação não encontrada');
        if (m === 'PATCH') {
          const v = validateAutomation(await readJson(req), true);
          const merged = { ...auto, ...v };
          if (`${merged.message}\n\n${merged.link}`.length > MAX_DM_LENGTH) throw new HttpError(400, `Mensagem + link passam de ${MAX_DM_LENGTH} caracteres`);
          return send(res, 200, repo.updateAutomation(auto.id, v));
        }
        if (m === 'DELETE') { repo.deleteAutomation(auto.id); return send(res, 200, { ok: true }); }
      }

      if (pathname === '/api/events' && m === 'GET') {
        const a = requireAccount();
        const status = url.searchParams.get('status');
        return send(res, 200, {
          items: repo.listEvents(a.id, {
            status: ['ignored', 'queued', 'sending', 'sent', 'failed'].includes(status) ? status : undefined,
            automationId: Number(url.searchParams.get('automation')) || undefined,
            before: Number(url.searchParams.get('before')) || undefined,
            limit: url.searchParams.get('limit'),
          }),
        });
      }
      const rm = pathname.match(/^\/api\/events\/(\d+)\/retry$/);
      if (rm && m === 'POST') {
        requireAccount();
        if (!repo.requeue(Number(rm[1]))) throw new HttpError(409, 'Só é possível reenviar eventos com falha');
        setImmediate(() => worker.tick().catch(() => {}));
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/stats' && m === 'GET') {
        const a = currentAccount();
        if (!a) return send(res, 200, null);
        return send(res, 200, { ...repo.stats(a.id, 14, cfg.tzOffsetMin), hourlyLimit: cfg.hourlyLimit });
      }

      throw new HttpError(404, 'Rota não encontrada');
    }

    // ===== Arquivos estáticos =====
    if (m === 'GET' || m === 'HEAD') {
      if (pathname === '/' && !session(req)) return redirect(res, '/login.html');
      const map = { '/': '/index.html', '/privacy': '/privacy.html' };
      const file = path.normalize(path.join(PUBLIC_DIR, map[pathname] || pathname));
      if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Não encontrado');
      const data = await fs.promises.readFile(file).catch(() => null);
      if (!data) throw new HttpError(404, 'Não encontrado');
      return send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    }
    throw new HttpError(404, 'Não encontrado');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      await route(req, res, url);
    } catch (err) {
      const status = err.status || (err instanceof GraphError ? 502 : 500);
      if (status >= 500) log('erro:', err.stack || err.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro interno' : status === 502 ? `Instagram: ${err.message}` : err.message });
    }
  });
}
