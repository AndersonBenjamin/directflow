// Configuração central. Tudo vem de variáveis de ambiente (.env em dev).
function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v.trim();
}

export function loadConfig() {
  const baseUrl = required('APP_BASE_URL').replace(/\/+$/, '');
  return {
    env: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3000),
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),

    // App Dashboard > Instagram > API setup with Instagram login
    igAppId: required('IG_APP_ID'),
    igAppSecret: required('IG_APP_SECRET'),
    webhookVerifyToken: required('WEBHOOK_VERIFY_TOKEN'),

    adminPassword: required('ADMIN_PASSWORD'),
    encryptionKey: required('ENCRYPTION_KEY'),

    graphVersion: process.env.GRAPH_API_VERSION || 'v26.0',
    graphBase: (process.env.GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/+$/, ''),
    oauthAuthorizeUrl: process.env.OAUTH_AUTHORIZE_URL || 'https://www.instagram.com/oauth/authorize',
    oauthTokenUrl: process.env.OAUTH_TOKEN_URL || 'https://api.instagram.com/oauth/access_token',
    scopes: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],

    dbPath: process.env.DB_PATH || './data/app.db',
    // Meta permite 750/h por conta; usamos margem de segurança.
    hourlyLimit: Number(process.env.PRIVATE_REPLY_HOURLY_LIMIT || 600),
    historyRetentionDays: Number(process.env.HISTORY_RETENTION_DAYS || 90),
    trustProxy: process.env.TRUST_PROXY === '1',
    tzOffsetMin: Number(process.env.TZ_OFFSET_MINUTES || -180), // fuso do painel (padrão: Brasília)
    workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 5000),
  };
}
