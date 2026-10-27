import { classifyError } from './graph.js';

const SEVEN_DAYS = 7 * 86400_000;
const MAX_ATTEMPTS = 6;
export const MAX_DM_LENGTH = 1000; // limite de texto de mensagem do Instagram

// ---------- palavra-chave ----------
export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
export function parseKeywords(keyword) {
  return String(keyword || '').split(',').map(normalize).filter(Boolean);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Casa a palavra inteira, sem diferenciar maiúsculas/acentos: "quero!!", "Eu QUERO" ✓ — "queroo" ✗ */
export function matchesKeyword(text, keyword) {
  const t = normalize(text);
  return parseKeywords(keyword).some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(t));
}

export function buildMessage(automation, username) {
  const body = String(automation.message).replaceAll('{username}', username ? `@${username}` : '').trim();
  return `${body}\n\n${automation.link}`.slice(0, MAX_DM_LENGTH);
}

// ---------- entrada: webhook -> eventos ----------
/**
 * Converte o payload do webhook em eventos no banco. Rápido e síncrono
 * (sem chamadas externas), para a rota responder 200 em milissegundos.
 */
export function ingestWebhook(repo, payload, log = () => {}) {
  if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return 0;
  let queued = 0;
  for (const entry of payload.entry) {
    const account = repo.accountByIgId(entry.id);
    if (!account) continue; // conta não conectada a este app
    const changes = entry.changes || (entry.field ? [{ field: entry.field, value: entry.value }] : []);
    for (const ch of changes) {
      if (ch.field !== 'comments' || !ch.value?.id) continue;
      const v = ch.value;
      const mediaId = v.media?.id;
      const automation = mediaId && repo.automationByMedia(account.id, mediaId);
      if (!automation) continue; // posts sem automação não são registrados (minimização de dados)

      const base = {
        comment_id: v.id, account_id: account.id, automation_id: automation.id, media_id: mediaId,
        from_id: v.from?.id, from_username: v.from?.username, text: v.text,
      };
      let status = 'queued', reason = null;
      if (String(v.from?.id) === String(account.ig_user_id)) { status = 'ignored'; reason = 'Comentário da própria conta'; }
      else if (!automation.active) { status = 'ignored'; reason = 'Automação pausada'; }
      else if (!matchesKeyword(v.text, automation.keyword)) { status = 'ignored'; reason = 'Sem palavra-chave'; }
      else if (v.from?.id && repo.userAlreadyServed(automation.id, v.from.id)) { status = 'ignored'; reason = 'Usuário já recebeu esta DM'; }

      const inserted = repo.insertEvent({ ...base, status, reason, next_attempt_at: status === 'queued' ? Date.now() : null });
      if (!inserted) log(`webhook duplicado ignorado: comentário ${v.id}`);
      else if (status === 'queued') queued++;
    }
  }
  return queued;
}

// ---------- saída: fila -> DM ----------
export function makeWorker({ repo, graph, cipher, cfg, log = console.log }) {
  let running = false;

  async function processOne(ev) {
    const account = repo.accountById(ev.account_id);
    const automation = ev.automation_id && repo.automationById(ev.automation_id);
    if (!account || !automation) return repo.markFailed(ev.id, 'Automação ou conta removida');
    if (account.status !== 'ok') return repo.markRetry(ev.id, Date.now() + 15 * 60_000, 'Conta precisa ser reconectada');
    if (Date.now() - ev.received_at > SEVEN_DAYS) return repo.markFailed(ev.id, 'Prazo de 7 dias da Meta expirado');

    // Teto por hora (Meta: 750/h por conta em posts e Reels).
    const { n, oldest } = repo.sentInLastHour(account.id);
    if (n >= cfg.hourlyLimit) return repo.markRetry(ev.id, (oldest || Date.now()) + 3600_000 + 1000, 'Aguardando limite por hora');

    if (!repo.claimEvent(ev.id)) return; // outro ciclo já pegou
    try {
      const token = cipher.decrypt(account.access_token_enc);
      const res = await graph.sendPrivateReply(token, account.ig_user_id, ev.comment_id, buildMessage(automation, ev.from_username));
      repo.markSent(ev.id, res.message_id);
      log(`DM enviada: comentário ${ev.comment_id} -> @${ev.from_username || ev.from_id}`);
    } catch (err) {
      const kind = classifyError(err);
      const msg = err.summary || err.message;
      const attempts = ev.attempts + 1;
      if (kind === 'auth') {
        repo.flagAccount(account.id, msg);
        repo.markRetry(ev.id, Date.now() + 15 * 60_000, msg);
      } else if ((kind === 'rate_limit' || kind === 'transient') && attempts < MAX_ATTEMPTS) {
        const delay = Math.min(60_000 * 2 ** (attempts - 1), 3600_000) * (kind === 'rate_limit' ? 5 : 1);
        repo.markRetry(ev.id, Date.now() + delay, msg);
      } else {
        repo.markFailed(ev.id, msg);
      }
      log(`falha ao enviar (${kind}) comentário ${ev.comment_id}: ${msg}`);
    }
  }

  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        for (const ev of repo.dueEvents(20)) await processOne(ev);
      } finally { running = false; }
    },
  };
}

// ---------- manutenção ----------
export async function refreshTokens({ repo, graph, cipher, log = console.log }) {
  for (const acc of repo.listAccounts()) {
    const msLeft = acc.token_expires_at - Date.now();
    const age = Date.now() - acc.token_issued_at;
    if (msLeft > 10 * 86400_000 || age < 86400_000) continue; // Meta exige token com 24h+ para renovar
    try {
      const r = await graph.refresh(cipher.decrypt(acc.access_token_enc));
      repo.updateToken(acc.id, cipher.encrypt(r.accessToken), Date.now(), Date.now() + r.expiresIn * 1000);
      log(`token renovado: @${acc.username}`);
    } catch (err) {
      repo.flagAccount(acc.id, `Falha ao renovar token: ${err.message}`);
      log(`falha ao renovar token de @${acc.username}: ${err.message}`);
    }
  }
}
