import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY,
  ig_user_id       TEXT NOT NULL UNIQUE,      -- ID da conta profissional (igual ao entry.id do webhook)
  username         TEXT,
  profile_picture  TEXT,
  access_token_enc TEXT NOT NULL,             -- token longo, criptografado
  token_issued_at  INTEGER NOT NULL,
  token_expires_at INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ok', -- ok | reconnect
  status_detail    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  media_id        TEXT NOT NULL,
  media_type      TEXT,
  media_permalink TEXT,
  media_caption   TEXT,
  media_thumb     TEXT,
  keyword         TEXT NOT NULL,              -- uma ou mais, separadas por vírgula
  message         TEXT NOT NULL,
  link            TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (account_id, media_id)               -- uma automação por publicação
);

CREATE TABLE IF NOT EXISTS comment_events (
  id              INTEGER PRIMARY KEY,
  comment_id      TEXT NOT NULL UNIQUE,       -- deduplicação de webhooks repetidos
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id   INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  media_id        TEXT,
  from_id         TEXT,
  from_username   TEXT,
  text            TEXT,
  status          TEXT NOT NULL,              -- ignored | queued | sending | sent | failed
  reason          TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  message_id      TEXT,
  error           TEXT,
  received_at     INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_queue ON comment_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_events_received ON comment_events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_auto_user ON comment_events(automation_id, from_id, status);
CREATE INDEX IF NOT EXISTS idx_events_sent ON comment_events(account_id, sent_at);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return makeRepo(db);
}

function makeRepo(db) {
  const now = () => Date.now();
  const q = (sql) => db.prepare(sql);

  return {
    raw: db,
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    // ---------- contas ----------
    upsertAccount(a) {
      const t = now();
      q(`INSERT INTO accounts (ig_user_id, username, profile_picture, access_token_enc, token_issued_at, token_expires_at, status, status_detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
         ON CONFLICT(ig_user_id) DO UPDATE SET username=excluded.username, profile_picture=excluded.profile_picture,
           access_token_enc=excluded.access_token_enc, token_issued_at=excluded.token_issued_at,
           token_expires_at=excluded.token_expires_at, status='ok', status_detail=NULL, updated_at=excluded.updated_at`)
        .run(a.igUserId, a.username ?? null, a.profilePicture ?? null, a.tokenEnc, a.issuedAt, a.expiresAt, t, t);
      return this.accountByIgId(a.igUserId);
    },
    accountByIgId: (id) => q('SELECT * FROM accounts WHERE ig_user_id = ?').get(String(id)),
    accountById: (id) => q('SELECT * FROM accounts WHERE id = ?').get(id),
    primaryAccount: () => q('SELECT * FROM accounts ORDER BY id LIMIT 1').get(),
    listAccounts: () => q('SELECT * FROM accounts').all(),
    updateToken(id, tokenEnc, issuedAt, expiresAt) {
      q(`UPDATE accounts SET access_token_enc=?, token_issued_at=?, token_expires_at=?, status='ok', status_detail=NULL, updated_at=? WHERE id=?`)
        .run(tokenEnc, issuedAt, expiresAt, now(), id);
    },
    flagAccount(id, detail) {
      q(`UPDATE accounts SET status='reconnect', status_detail=?, updated_at=? WHERE id=?`).run(detail, now(), id);
    },
    deleteAccount: (id) => q('DELETE FROM accounts WHERE id = ?').run(id),

    // ---------- automações ----------
    listAutomations(accountId) {
      return q(`SELECT a.*,
          (SELECT COUNT(*) FROM comment_events e WHERE e.automation_id = a.id AND e.status = 'sent') AS sent_count,
          (SELECT COUNT(*) FROM comment_events e WHERE e.automation_id = a.id AND e.status = 'failed') AS failed_count
        FROM automations a WHERE a.account_id = ? ORDER BY a.created_at DESC`).all(accountId);
    },
    automationById: (id) => q('SELECT * FROM automations WHERE id = ?').get(id),
    automationByMedia: (accountId, mediaId) =>
      q('SELECT * FROM automations WHERE account_id = ? AND media_id = ?').get(accountId, String(mediaId)),
    createAutomation(accountId, d) {
      const t = now();
      const r = q(`INSERT INTO automations (account_id, media_id, media_type, media_permalink, media_caption, media_thumb, keyword, message, link, active, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(accountId, d.media_id, d.media_type ?? null, d.media_permalink ?? null, d.media_caption ?? null,
          d.media_thumb ?? null, d.keyword, d.message, d.link, d.active ? 1 : 0, t, t);
      return this.automationById(Number(r.lastInsertRowid));
    },
    updateAutomation(id, d) {
      const fields = ['keyword', 'message', 'link', 'active'].filter((k) => d[k] !== undefined);
      if (!fields.length) return this.automationById(id);
      const vals = fields.map((k) => (k === 'active' ? (d[k] ? 1 : 0) : d[k]));
      q(`UPDATE automations SET ${fields.map((f) => `${f}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...vals, now(), id);
      return this.automationById(id);
    },
    deleteAutomation: (id) => q('DELETE FROM automations WHERE id = ?').run(id),

    // ---------- eventos / fila ----------
    /** Insere evento; retorna false se o comment_id já existe (webhook duplicado). */
    insertEvent(e) {
      const r = q(`INSERT OR IGNORE INTO comment_events
        (comment_id, account_id, automation_id, media_id, from_id, from_username, text, status, reason, next_attempt_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(String(e.comment_id), e.account_id, e.automation_id ?? null, e.media_id ?? null, e.from_id ?? null,
          e.from_username ?? null, e.text ?? null, e.status, e.reason ?? null, e.next_attempt_at ?? null, e.received_at ?? now());
      return r.changes > 0;
    },
    userAlreadyServed(automationId, fromId) {
      return !!q(`SELECT 1 FROM comment_events WHERE automation_id=? AND from_id=? AND status IN ('queued','sending','sent') LIMIT 1`)
        .get(automationId, String(fromId));
    },
    dueEvents(limit = 20) {
      return q(`SELECT * FROM comment_events WHERE status='queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`).all(now(), limit);
    },
    /** Trava otimista: só um processo consegue passar queued -> sending. */
    claimEvent(id) {
      return q(`UPDATE comment_events SET status='sending', attempts=attempts+1 WHERE id=? AND status='queued'`).run(id).changes === 1;
    },
    markSent(id, messageId) {
      q(`UPDATE comment_events SET status='sent', message_id=?, error=NULL, sent_at=? WHERE id=?`).run(messageId ?? null, now(), id);
    },
    markRetry(id, at, error) {
      q(`UPDATE comment_events SET status='queued', next_attempt_at=?, error=? WHERE id=?`).run(at, error, id);
    },
    markFailed(id, error) {
      q(`UPDATE comment_events SET status='failed', error=?, next_attempt_at=NULL WHERE id=?`).run(error, id);
    },
    requeue(id) {
      return q(`UPDATE comment_events SET status='queued', next_attempt_at=?, error=NULL WHERE id=? AND status='failed'`).run(now(), id).changes === 1;
    },
    resetStuckSending() {
      // Se o processo caiu no meio de um envio, devolvemos à fila. O risco de duplicar
      // é coberto pela própria Meta (1 resposta privada por comentário).
      q(`UPDATE comment_events SET status='queued', next_attempt_at=? WHERE status='sending'`).run(now());
    },
    sentInLastHour(accountId) {
      return q(`SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM comment_events WHERE account_id=? AND status='sent' AND sent_at > ?`)
        .get(accountId, now() - 3600_000);
    },
    listEvents(accountId, { status, automationId, limit = 50, before } = {}) {
      const where = ['e.account_id = ?'];
      const args = [accountId];
      if (status) { where.push('e.status = ?'); args.push(status); }
      if (automationId) { where.push('e.automation_id = ?'); args.push(automationId); }
      if (before) { where.push('e.id < ?'); args.push(before); }
      args.push(Math.min(Number(limit) || 50, 200));
      return q(`SELECT e.*, a.keyword, a.media_caption, a.media_thumb FROM comment_events e
                LEFT JOIN automations a ON a.id = e.automation_id
                WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`).all(...args);
    },
    stats(accountId, days = 14, tzOffsetMin = -180) {
      const since = now() - days * 86400_000;
      const totals = q(`SELECT
          SUM(status='sent') AS sent, SUM(status='failed') AS failed, SUM(status='queued' OR status='sending') AS queued,
          SUM(status='ignored') AS ignored, COUNT(*) AS total
        FROM comment_events WHERE account_id=? AND received_at > ?`).get(accountId, since);
      const daily = q(`SELECT strftime('%Y-%m-%d', (sent_at/1000) + ? * 60, 'unixepoch') AS day, COUNT(*) AS n
        FROM comment_events WHERE account_id=? AND status='sent' AND sent_at > ? GROUP BY day ORDER BY day`).all(tzOffsetMin, accountId, since);
      const active = q(`SELECT COUNT(*) AS n FROM automations WHERE account_id=? AND active=1`).get(accountId).n;
      return { totals, daily, active, lastHour: this.sentInLastHour(accountId).n };
    },
    purgeOlderThan(days) {
      return q(`DELETE FROM comment_events WHERE received_at < ? AND status IN ('ignored','sent','failed')`)
        .run(now() - days * 86400_000).changes;
    },
  };
}
