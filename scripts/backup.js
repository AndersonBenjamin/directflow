// Cópia consistente do banco, mesmo com o app rodando (VACUUM INTO).
// Uso no Docker: docker compose exec app node scripts/backup.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const src = process.env.DB_PATH || './data/app.db';
const dir = path.join(path.dirname(src), 'backups');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);

const db = new DatabaseSync(src);
db.prepare('VACUUM INTO ?').run(out);
db.close();

// Mantém só os 14 backups mais recentes.
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
for (const f of files.slice(0, -14)) fs.unlinkSync(path.join(dir, f));
console.log(out);
