import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { makeGraph } from './graph.js';
import { makeCipher } from './security.js';
import { makeWorker, refreshTokens } from './automation.js';
import { createServer } from './server.js';
import { makeSettings, resolveEncryptionKey } from './settings.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

export function start(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  cfg.encryptionKey = resolveEncryptionKey(cfg);
  const repo = openDb(cfg.dbPath);
  const graph = makeGraph(cfg);
  const cipher = makeCipher(cfg.encryptionKey);
  const settings = makeSettings({ cfg, repo, cipher });
  const worker = makeWorker({ repo, graph, cipher, cfg, log });
  const server = createServer({ cfg, repo, graph, cipher, settings, worker, log });

  repo.resetStuckSending();
  const timers = [
    setInterval(() => worker.tick().catch((e) => log('worker:', e.message)), cfg.workerIntervalMs),
    setInterval(() => refreshTokens({ repo, graph, cipher, log }).catch(() => {}), 6 * 3600_000),
    setInterval(() => { const n = repo.purgeOlderThan(cfg.historyRetentionDays); if (n) log(`histórico: ${n} eventos antigos removidos`); }, 24 * 3600_000),
  ];
  refreshTokens({ repo, graph, cipher, log }).catch(() => {});

  return new Promise((resolve) => {
    server.listen(cfg.port, () => {
      log(`rodando em ${cfg.baseUrl} (porta ${cfg.port}) · Graph API ${cfg.graphVersion}`);
      if (/seudominio/i.test(cfg.baseUrl)) log(`ATENÇÃO: APP_BASE_URL ainda é o endereço de exemplo (${cfg.baseUrl}). Corrija no .env.`);
      if (settings.setupCode) log(`primeiro acesso: abra ${cfg.baseUrl} e use o código ${settings.setupCode} para criar a senha do painel`);
      else if (!settings.metaReady()) log('credenciais da Meta pendentes: preencha em Configurações, no painel');
      resolve({
        server, repo, cfg, worker, settings,
        close: () => new Promise((r) => { timers.forEach(clearInterval); server.close(() => { repo.raw.close(); r(); }); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = start().catch((e) => { console.error(e.message); process.exit(1); });
  // Encerramento limpo (docker stop envia SIGTERM): para de aceitar conexões e fecha o banco.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log(`${sig} recebido, encerrando…`);
      setTimeout(() => process.exit(0), 8000).unref();
      await (await app)?.close();
      process.exit(0);
    });
  }
}
