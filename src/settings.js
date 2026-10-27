// Configurações editáveis pelo painel (credenciais da Meta e senha), guardadas no SQLite.
// Variável de ambiente, quando definida, tem prioridade e fica bloqueada no painel.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, verifyPassword, safeEqual } from './security.js';

/** ENCRYPTION_KEY ou, sem ela, uma chave gerada uma vez e guardada ao lado do banco. */
export function resolveEncryptionKey(cfg) {
  if (cfg.encryptionKey) return cfg.encryptionKey;
  if (cfg.dbPath === ':memory:') return crypto.randomBytes(32).toString('hex');
  const file = path.join(path.dirname(path.resolve(cfg.dbPath)), 'secret.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

export function makeSettings({ cfg, repo, cipher }) {
  const locked = {
    igAppId: !!cfg.igAppId,
    igAppSecret: !!cfg.igAppSecret,
    webhookVerifyToken: !!cfg.webhookVerifyToken,
    password: !!cfg.adminPassword,
  };

  // Aplica no cfg (lido em tempo real por graph.js e server.js) o que veio do painel.
  function apply() {
    if (!locked.igAppId) cfg.igAppId = repo.getSetting('ig_app_id') || '';
    if (!locked.igAppSecret) {
      const enc = repo.getSetting('ig_app_secret');
      cfg.igAppSecret = enc ? cipher.decrypt(enc) : '';
    }
    if (!locked.webhookVerifyToken) {
      let token = repo.getSetting('webhook_verify_token');
      if (!token) repo.setSetting('webhook_verify_token', (token = crypto.randomBytes(18).toString('base64url')));
      cfg.webhookVerifyToken = token;
    }
  }
  apply();

  const passwordHash = () => repo.getSetting('admin_password');
  const needsSetup = () => !locked.password && !passwordHash();
  // Código exigido para criar a senha no 1º acesso; só quem vê o log do servidor o conhece.
  const setupCode = needsSetup() ? crypto.randomBytes(4).toString('hex').toUpperCase() : null;

  return {
    setupCode,
    needsSetup,
    passwordLocked: () => locked.password,
    metaReady: () => !!(cfg.igAppId && cfg.igAppSecret),
    // Trocar a senha invalida as sessões existentes.
    signerSecret: () => cfg.encryptionKey + (locked.password ? cfg.adminPassword : passwordHash() || ''),

    checkPassword(password) {
      if (locked.password) return safeEqual(password, cfg.adminPassword);
      return verifyPassword(password, passwordHash());
    },
    checkSetupCode: (code) => !!setupCode && safeEqual(String(code || '').trim().toUpperCase(), setupCode),
    setPassword(password) {
      if (locked.password) throw new Error('Senha definida em ADMIN_PASSWORD no servidor');
      repo.setSetting('admin_password', hashPassword(password));
    },

    view() {
      return {
        igAppId: cfg.igAppId,
        igAppSecretSet: !!cfg.igAppSecret,
        webhookVerifyToken: cfg.webhookVerifyToken,
        locked,
        urls: {
          webhook: `${cfg.baseUrl}/webhook`,
          callback: `${cfg.baseUrl}/auth/instagram/callback`,
          privacy: `${cfg.baseUrl}/privacy`,
        },
      };
    },
    /** Grava só os campos informados e não bloqueados. App Secret vazio mantém o atual. */
    update({ igAppId, igAppSecret, webhookVerifyToken }) {
      if (igAppId !== undefined && !locked.igAppId) repo.setSetting('ig_app_id', igAppId);
      if (igAppSecret && !locked.igAppSecret) repo.setSetting('ig_app_secret', cipher.encrypt(igAppSecret));
      if (webhookVerifyToken && !locked.webhookVerifyToken) repo.setSetting('webhook_verify_token', webhookVerifyToken);
      apply();
    },
  };
}
