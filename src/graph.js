// Cliente mínimo da Instagram API with Instagram Login (graph.instagram.com).
export class GraphError extends Error {
  constructor(err = {}, httpStatus = 0) {
    super(err.message || err.error_message || `Erro HTTP ${httpStatus}`);
    this.code = err.code ?? null;
    this.subcode = err.error_subcode ?? null;
    this.type = err.type || err.error_type || null;
    this.httpStatus = httpStatus;
  }
  get summary() {
    return [this.code && `código ${this.code}`, this.subcode && `sub ${this.subcode}`].filter(Boolean).join('/') + (this.code ? ': ' : '') + this.message;
  }
}

/**
 * Classifica erros da Meta para decidir: reenviar mais tarde ou desistir.
 * Ref.: Graph API error codes + Private Replies.
 */
export function classifyError(err) {
  if (!(err instanceof GraphError)) return 'transient'; // rede, timeout
  const { code, subcode, httpStatus } = err;
  if ([4, 17, 32, 613, 80002].includes(code) || subcode === 2534040) return 'rate_limit';
  if (code === 190) return 'auth'; // token inválido/expirado/revogado -> reconectar
  if (code === 100 && subcode === 2534025) return 'permanent'; // prazo de 7 dias ou já respondido
  if (code === 1 || code === 2 || httpStatus >= 500) return 'transient';
  return 'permanent';
}

export function makeGraph(cfg) {
  const v = cfg.graphVersion;

  async function request(url, { method = 'GET', token, json, form } = {}) {
    const headers = {};
    let body;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || data.error_type) throw new GraphError(data.error || data, res.status);
    return data;
  }
  const api = (p, params = {}) => {
    const u = new URL(`${cfg.graphBase}/${v}${p}`);
    for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
    return u;
  };

  return {
    authorizeUrl(state) {
      const u = new URL(cfg.oauthAuthorizeUrl);
      u.searchParams.set('client_id', cfg.igAppId);
      u.searchParams.set('redirect_uri', `${cfg.baseUrl}/auth/instagram/callback`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', cfg.scopes.join(','));
      u.searchParams.set('state', state);
      return u.toString();
    },

    /** code -> token curto (1h). */
    async exchangeCode(code) {
      const d = await request(cfg.oauthTokenUrl, {
        method: 'POST',
        form: {
          client_id: cfg.igAppId, client_secret: cfg.igAppSecret, grant_type: 'authorization_code',
          redirect_uri: `${cfg.baseUrl}/auth/instagram/callback`, code,
        },
      });
      const row = Array.isArray(d.data) ? d.data[0] : d; // a Meta já retornou nos dois formatos
      return { accessToken: row.access_token, permissions: String(row.permissions || '') };
    },

    /** token curto -> token longo (60 dias). Sempre no servidor (usa o App Secret). */
    async longLived(shortToken) {
      const u = new URL(`${cfg.graphBase}/access_token`);
      u.searchParams.set('grant_type', 'ig_exchange_token');
      u.searchParams.set('client_secret', cfg.igAppSecret);
      u.searchParams.set('access_token', shortToken);
      const d = await request(u);
      return { accessToken: d.access_token, expiresIn: Number(d.expires_in) };
    },

    async refresh(token) {
      const u = new URL(`${cfg.graphBase}/refresh_access_token`);
      u.searchParams.set('grant_type', 'ig_refresh_token');
      u.searchParams.set('access_token', token);
      const d = await request(u);
      return { accessToken: d.access_token, expiresIn: Number(d.expires_in) };
    },

    me: (token) => request(api('/me', { fields: 'user_id,username,profile_picture_url,account_type' }), { token }),

    async listMedia(token, after) {
      const params = { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp', limit: '30' };
      if (after) params.after = after;
      const d = await request(api('/me/media', params), { token });
      return { items: d.data || [], next: d.paging?.cursors?.after && d.paging?.next ? d.paging.cursors.after : null };
    },

    /** Liga os webhooks de comentários para esta conta. */
    subscribe: (token) => request(api('/me/subscribed_apps', { subscribed_fields: 'comments' }), { method: 'POST', token }),
    unsubscribe: (token) => request(api('/me/subscribed_apps'), { method: 'DELETE', token }),

    /** Resposta privada: 1 por comentário, até 7 dias após o comentário. */
    sendPrivateReply: (token, igUserId, commentId, text) =>
      request(api(`/${igUserId}/messages`), {
        method: 'POST', token,
        json: { recipient: { comment_id: String(commentId) }, message: { text } },
      }),
  };
}
