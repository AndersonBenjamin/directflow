// Teste ponta a ponta com uma Graph API simulada (nenhuma chamada real à Meta).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK_PORT = 4810, APP_PORT = 4811;
const IG_ID = '17841400000000001';
const SECRET = 'app-secret-teste';
const sentDMs = [];
let rateLimitOnce = true;

const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const u = new URL(req.url, 'http://x');
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/oauth/access_token') {
    const f = new URLSearchParams(body);
    assert.equal(f.get('client_secret'), SECRET);
    return json(200, { data: [{ access_token: 'SHORT', user_id: '999', permissions: 'instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages' }] });
  }
  if (u.pathname === '/access_token') return json(200, { access_token: 'LONG-TOKEN', token_type: 'bearer', expires_in: 5184000 });
  if (u.pathname === '/refresh_access_token') return json(200, { access_token: 'LONG-TOKEN-2', token_type: 'bearer', expires_in: 5184000 });
  assert.equal(req.headers.authorization, 'Bearer LONG-TOKEN');
  if (u.pathname === '/v26.0/me') return json(200, { user_id: IG_ID, username: 'loja.teste', profile_picture_url: 'https://example.com/p.jpg' });
  if (u.pathname === '/v26.0/me/subscribed_apps') return json(200, { success: true });
  if (u.pathname === '/v26.0/me/media') return json(200, { data: [
    { id: '1801', caption: 'Reels do produto — comente QUERO', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/reel/1', thumbnail_url: 'https://example.com/t.jpg' },
    { id: '1802', caption: 'Foto', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://instagram.com/p/2', media_url: 'https://example.com/m.jpg' },
  ] });
  if (u.pathname === `/v26.0/${IG_ID}/messages`) {
    const b = JSON.parse(body);
    const cid = b.recipient.comment_id;
    if (cid === 'c-rate' && rateLimitOnce) { rateLimitOnce = false; return json(400, { error: { message: 'Rate limit', code: 613, error_subcode: 2534040 } }); }
    if (cid === 'c-old') return json(400, { error: { message: 'Fora do prazo', code: 100, error_subcode: 2534025 } });
    sentDMs.push(b);
    return json(200, { recipient_id: 'igsid', message_id: `mid-${cid}` });
  }
  json(404, { error: { message: 'mock: rota desconhecida ' + u.pathname, code: 100 } });
});

let app, jar = {};
const base = `http://127.0.0.1:${APP_PORT}`;
async function call(p, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
}
function webhook(comments, { badSig } = {}) {
  const payload = JSON.stringify({ object: 'instagram', entry: [{ id: IG_ID, time: Math.floor(Date.now() / 1000),
    changes: comments.map((c) => ({ field: 'comments', value: { id: c.id, text: c.text, from: { id: c.from, username: c.user || 'fulano' }, media: { id: c.media || '1801', media_product_type: 'REELS' } } })) }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', badSig ? 'errado' : SECRET).update(payload).digest('hex');
  return call('/webhook', { method: 'POST', raw: payload, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig } });
}
const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await app.worker.tick(); };

before(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linka-'));
  Object.assign(process.env, {
    APP_BASE_URL: base, IG_APP_ID: '123', IG_APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: 'verifica', ADMIN_PASSWORD: 'senha-forte',
    ENCRYPTION_KEY: 'chave-de-teste', GRAPH_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, OAUTH_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/oauth/access_token`,
    DB_PATH: path.join(dir, 'app.db'), WORKER_INTERVAL_MS: '600000', PORT: String(APP_PORT),
  });
  const { start } = await import('../src/index.js');
  app = await start({ });
});
after(async () => { await app.close(); mock.close(); });

test('verificação do webhook', async () => {
  const ok = await call('/webhook?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=42');
  assert.equal(ok.status, 200); assert.equal(ok.data, 42);
  assert.equal((await call('/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42')).status, 403);
});

test('painel exige login', async () => {
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'errada' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'senha-forte' } })).status, 200);
  assert.equal((await call('/api/me')).status, 200);
});

test('OAuth conecta a conta e assina webhooks', async () => {
  const s = await call('/auth/instagram/start');
  assert.equal(s.status, 302);
  const state = new URL(s.location).searchParams.get('state');
  assert.ok(new URL(s.location).searchParams.get('scope').includes('instagram_business_manage_messages'));
  const bad = await call(`/auth/instagram/callback?code=abc&state=forjado`);
  assert.match(bad.location, /erro=/);
  const s2 = await call('/auth/instagram/start');
  const st2 = new URL(s2.location).searchParams.get('state');
  const cb = await call(`/auth/instagram/callback?code=abc%23_&state=${st2}`);
  assert.equal(cb.location, '/?conectado=1');
  const me = await call('/api/me');
  assert.equal(me.data.account.username, 'loja.teste');
  assert.equal(me.data.account.access_token_enc, undefined, 'token não pode vazar para o painel');
  const row = app.repo.primaryAccount();
  assert.ok(!row.access_token_enc.includes('LONG-TOKEN'), 'token deve estar criptografado');
  void state;
});

test('cria automação com validação', async () => {
  const media = await call('/api/media');
  assert.equal(media.data.items.length, 2);
  assert.equal((await call('/api/automations', { method: 'POST', body: { media_id: '1801', keyword: 'QUERO', message: 'Oi', link: 'javascript:alert(1)' } })).status, 400);
  const c = await call('/api/automations', { method: 'POST', body: { media_id: '1801', media_caption: 'Reels', keyword: 'quero, eu quero', message: 'Oi {username}! Aqui está o link 👇', link: 'https://loja.com/produto' } });
  assert.equal(c.status, 201);
  assert.equal((await call('/api/automations', { method: 'POST', body: { media_id: '1801', keyword: 'X', message: 'a', link: 'https://a.com' } })).status, 409);
  assert.equal((await call('/api/automations', { method: 'POST', body: { media_id: '1801', keyword: 'X', message: 'a', link: 'https://a.com' }, headers: { Origin: 'https://malicioso.com' } })).status, 403);
});

test('webhook com assinatura inválida é rejeitado', async () => {
  assert.equal((await webhook([{ id: 'c-x', text: 'QUERO', from: 'u9' }], { badSig: true })).status, 401);
});

test('fluxo principal: palavra-chave -> DM, sem duplicar', async () => {
  const r = await webhook([
    { id: 'c1', text: 'Quero!!! 😍', from: 'u1', user: 'maria' },
    { id: 'c2', text: 'que lindo', from: 'u2' },             // sem palavra
    { id: 'c3', text: 'QUERO', from: IG_ID },                 // própria conta
    { id: 'c4', text: 'queroo', from: 'u3' },                 // não é palavra inteira
    { id: 'c5', text: 'quero', from: 'u4', media: '1802' },   // post sem automação
  ]);
  assert.equal(r.status, 200);
  await settle();
  assert.equal(sentDMs.length, 1);
  assert.equal(sentDMs[0].recipient.comment_id, 'c1');
  assert.equal(sentDMs[0].message.text, 'Oi @maria! Aqui está o link 👇\n\nhttps://loja.com/produto');

  await webhook([{ id: 'c1', text: 'Quero!!!', from: 'u1' }]);                 // reentrega da Meta
  await webhook([{ id: 'c6', text: 'eu quero de novo', from: 'u1' }]);         // mesma pessoa
  await settle();
  assert.equal(sentDMs.length, 1, 'não pode enviar duplicado');

  const ev = await call('/api/events');
  const by = Object.fromEntries(ev.data.items.map((e) => [e.comment_id, e]));
  assert.equal(by.c1.status, 'sent');
  assert.equal(by.c2.reason, 'Sem palavra-chave');
  assert.equal(by.c3.reason, 'Comentário da própria conta');
  assert.equal(by.c4.status, 'ignored');
  assert.equal(by.c6.reason, 'Usuário já recebeu esta DM');
  assert.equal(by.c5, undefined, 'post sem automação não é registrado');
});

test('limite de taxa reagenda; prazo expirado falha', async () => {
  await webhook([{ id: 'c-rate', text: 'QUERO', from: 'u10' }, { id: 'c-old', text: 'quero', from: 'u11' }]);
  await settle();
  let ev = (await call('/api/events')).data.items;
  const rate = ev.find((e) => e.comment_id === 'c-rate');
  assert.equal(rate.status, 'queued'); assert.ok(rate.next_attempt_at > Date.now());
  assert.equal(ev.find((e) => e.comment_id === 'c-old').status, 'failed');
  app.repo.raw.prepare(`UPDATE comment_events SET next_attempt_at = 0 WHERE comment_id='c-rate'`).run();
  await app.worker.tick();
  ev = (await call('/api/events')).data.items;
  assert.equal(ev.find((e) => e.comment_id === 'c-rate').status, 'sent');
});

test('pausar automação para de enviar', async () => {
  const [a] = (await call('/api/automations')).data.items;
  assert.equal((await call(`/api/automations/${a.id}`, { method: 'PATCH', body: { active: false } })).data.active, 0);
  await webhook([{ id: 'c20', text: 'quero', from: 'u20' }]);
  await settle();
  const ev = (await call('/api/events?status=ignored')).data.items;
  assert.equal(ev.find((e) => e.comment_id === 'c20').reason, 'Automação pausada');
  const stats = await call('/api/stats');
  assert.equal(stats.data.totals.sent, 2);
});
