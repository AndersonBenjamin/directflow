// Painel Linka — JS puro, sem build. Todo conteúdo vindo do Instagram é inserido via textContent.
const $ = (s, el = document) => el.querySelector(s);
const MAX_DM = 1000;

function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === 'svg' || tag === 'use' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (id) => h('svg', {}, h('use', { href: `#${id}` }));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Sessão expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3800);
}

const fmtDate = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const initials = (s) => (s || 'L').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'L';
const keywords = (s) => String(s || '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
const mediaThumb = (m) => m.thumbnail_url || m.media_url || '';
const mediaLabel = (t) => ({ REELS: 'REELS', FEED: 'POST', STORY: 'STORY' }[t] || t || '');

const state = { account: null, metaReady: false, automations: [], filter: '', events: [], media: [], mediaNext: null, editing: null, selectedMedia: null };

// ---------------- conta ----------------
function renderAccount() {
  const a = state.account;
  const nav = $('#nav-account');
  const card = $('#conta');
  const banner = $('#banner');
  nav.replaceChildren();
  card.replaceChildren();
  banner.replaceChildren();

  if (!a) {
    // Sem App ID/Secret o login do Instagram não funciona: manda para Configurações.
    const connect = state.metaReady ? '/auth/instagram/start' : '#configuracoes';
    if (!state.metaReady) banner.append(h('div', { class: 'banner' },
      h('span', {}, 'Antes de conectar o Instagram, preencha o App ID e o App Secret da Meta.'),
      h('a', { class: 'btn small accent', href: '#configuracoes' }, 'Configurar')));
    nav.append(h('a', { class: 'btn', href: connect }, 'Conectar Instagram'));
    $('#hero-card-title').textContent = 'Conecte sua conta profissional para começar.';
    $('#hero-card-text').textContent = 'Usamos o login oficial do Instagram (Meta). A conta precisa ser Comercial ou Criador e estar pública.';
    $('#hero-cta').href = connect;
    $('#hero-cta').setAttribute('aria-label', 'Conectar Instagram');
    $('#hero-cta-text').textContent = 'CONECTAR CONTA • CONECTAR CONTA • ';
    $('#dashboard').classList.add('hidden');
    card.append(
      h('div', { class: 'profile-photo' }, h('span', { class: 'ph' }, '@')),
      h('div', { class: 'profile-meta' }, h('div', {}, h('strong', {}, 'Nenhuma conta'), h('small', {}, 'Instagram profissional')),
        h('a', { href: connect, 'aria-label': 'Conectar' }, icon('i-arrow'))),
    );
    return;
  }

  $('#dashboard').classList.remove('hidden');
  $('#hero-cta').href = '#';
  const avatar = () => a.profile_picture ? h('img', { class: 'avatar', src: a.profile_picture, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }, initials(a.username));
  nav.append(h('div', { class: 'chip-account' }, avatar(), `@${a.username}`));

  const ok = a.status === 'ok';
  const days = Math.max(0, Math.round((a.token_expires_at - Date.now()) / 86400000));
  card.append(
    h('div', { class: 'profile-photo' }, a.profile_picture
      ? h('img', { src: a.profile_picture, alt: `Foto de @${a.username}`, referrerpolicy: 'no-referrer' })
      : h('span', { class: 'ph' }, initials(a.username))),
    h('div', { class: 'profile-meta' },
      h('div', {},
        h('strong', {}, `@${a.username}`),
        h('small', { class: `status-pill ${ok ? 'ok' : 'bad'}` }, ok ? `Conectada · token ${days}d` : 'Reconectar conta'),
        h('button', { type: 'button', class: 'link-quiet', onclick: disconnect }, 'Desconectar')),
      h('a', { href: `https://www.instagram.com/${encodeURIComponent(a.username)}/`, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir perfil', 'aria-label': 'Abrir perfil no Instagram' }, icon('i-arrow'))),
  );

  if (!ok) banner.append(h('div', { class: 'banner' },
    h('span', {}, `A conexão com o Instagram precisa ser renovada. ${a.status_detail || ''}`),
    h('a', { class: 'btn small accent', href: '/auth/instagram/start' }, 'Reconectar')));
}

async function disconnect() {
  if (!confirm(`Desconectar @${state.account.username}? As automações desta conta serão apagadas.`)) return;
  try { await api('/api/account', { method: 'DELETE' }); toast('Conta desconectada'); await boot(); }
  catch (e) { toast(e.message, true); }
}

// ---------------- números e gráfico ----------------
async function renderStats() {
  const s = await api('/api/stats');
  if (!s) return;
  $('#hero-stat').textContent = (s.totals.sent || 0).toLocaleString('pt-BR');
  const total = s.totals.total || 0;
  $('#hero-cap').textContent = total
    ? `DMs enviadas em 14 dias, de ${total.toLocaleString('pt-BR')} comentários processados.`
    : 'DMs enviadas nos últimos 14 dias. Os números aparecem com os primeiros comentários.';
  $('#k-active').textContent = s.active;
  $('#k-hour').textContent = s.lastHour;
  $('#k-hour-cap').textContent = `Teto configurado: ${s.hourlyLimit}/h (a Meta permite 750). O excedente espera na fila.`;
  $('#k-failed').textContent = s.totals.failed || 0;
  $('#k-failed-label').textContent = s.totals.failed === 1 ? 'falha' : 'falhas';
  $('#k-active-label').textContent = s.active === 1 ? 'automação ativa' : 'automações ativas';

  const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d.n]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ key, label: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`, n: byDay[key] || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  const chart = $('#chart');
  chart.querySelectorAll('.bar').forEach((b) => b.remove());
  for (const d of days) {
    const bar = h('div', { class: `bar${d.n ? '' : ' zero'}` }, h('span', { class: 'tip' }, `${d.n} DM${d.n === 1 ? '' : 's'} · ${d.label}`));
    bar.style.height = d.n ? `${Math.max(6, (d.n / max) * 100)}%` : '3px';
    chart.append(bar);
  }
  $('#chart-days').replaceChildren(...days.map((d, i) => h('span', {}, i % 2 === 0 || i === 13 ? d.label : '')));
}

// ---------------- automações ----------------
async function loadAutomations() {
  state.automations = (await api('/api/automations')).items;
  const list = $('#auto-list');
  if (!state.automations.length) {
    list.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Nenhuma automação ainda'),
      'Crie a primeira: escolha um Reels, defina a palavra-chave e o link.'));
    return;
  }
  list.replaceChildren(...state.automations.map((a) => {
    const thumb = h('img', { class: 'thumb', src: a.media_thumb || '', alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    thumb.addEventListener('error', () => thumb.removeAttribute('src'), { once: true });
    const sw = h('input', { type: 'checkbox', 'aria-label': a.active ? 'Pausar automação' : 'Ativar automação' });
    sw.checked = !!a.active;
    sw.addEventListener('change', async () => {
      try { await api(`/api/automations/${a.id}`, { method: 'PATCH', body: { active: sw.checked } }); toast(sw.checked ? 'Automação ativada' : 'Automação pausada'); renderStats(); }
      catch (e) { sw.checked = !sw.checked; toast(e.message, true); }
    });
    return h('div', { class: 'auto-row' },
      thumb,
      h('div', {},
        h('div', { class: 'auto-title' }, a.media_caption || 'Publicação sem legenda'),
        h('div', { class: 'auto-sub' }, a.link)),
      h('div', { class: 'kw' }, keywords(a.keyword).map((k) => h('span', {}, k))),
      h('div', { class: 'counts' }, h('b', {}, a.sent_count), ' enviadas', h('br'), a.failed_count ? `${a.failed_count} falhas` : 'sem falhas'),
      h('div', { class: 'row-actions' },
        h('label', { class: 'switch', title: a.active ? 'Ativa' : 'Pausada' }, sw, h('span')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Editar', 'aria-label': 'Editar', onclick: () => openModal(a) }, icon('i-edit')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Excluir', 'aria-label': 'Excluir', onclick: () => removeAutomation(a) }, icon('i-trash')),
        a.media_permalink ? h('a', { class: 'icon-btn', href: a.media_permalink, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir no Instagram', 'aria-label': 'Abrir no Instagram' }, icon('i-arrow')) : null));
  }));
}

async function removeAutomation(a) {
  if (!confirm('Excluir esta automação? O histórico de envios é mantido.')) return;
  try { await api(`/api/automations/${a.id}`, { method: 'DELETE' }); toast('Automação excluída'); await Promise.all([loadAutomations(), renderStats()]); }
  catch (e) { toast(e.message, true); }
}

// ---------------- modal ----------------
const form = $('#auto-form');
const dialog = $('#modal');

function updatePreview() {
  const msg = form.message.value.trim().replaceAll('{username}', '@cliente');
  const link = form.link.value.trim() || 'https://sualoja.com/produto';
  const kw = keywords(form.keyword.value)[0] || 'QUERO';
  $('#pv-comment').textContent = `Comentou “${kw}” no seu post`;
  $('#pv-msg').textContent = `${msg || 'Sua mensagem aparece aqui.'}\n\n${link}`;
  const len = `${form.message.value.trim()}\n\n${form.link.value.trim()}`.length;
  const c = $('#msg-count');
  c.textContent = `${len}/${MAX_DM}`;
  c.style.color = len > MAX_DM ? 'var(--accent-deep)' : '';
}
form.addEventListener('input', updatePreview);

function renderMediaGrid() {
  const grid = $('#media-grid');
  if (!state.media.length) { grid.replaceChildren(h('div', { class: 'hint' }, 'Nenhuma publicação encontrada nesta conta.')); return; }
  grid.replaceChildren(...state.media.map((m) => {
    const used = m.has_automation;
    const btn = h('button', {
      type: 'button', class: 'media-item', disabled: used, title: used ? 'Já tem automação' : (m.caption || '').slice(0, 120),
      'aria-pressed': String(state.selectedMedia?.id === m.id), 'aria-label': `${mediaLabel(m.media_product_type)} ${(m.caption || '').slice(0, 60)}`,
      onclick: () => { state.selectedMedia = m; renderMediaGrid(); },
    }, h('img', { src: mediaThumb(m), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }), h('span', { class: 'tagline' }, used ? 'EM USO' : mediaLabel(m.media_product_type)));
    return btn;
  }));
  $('#media-count').textContent = state.selectedMedia ? 'selecionada ✓' : 'escolha uma';
  $('#media-more-wrap').classList.toggle('hidden', !state.mediaNext);
}

async function loadMedia(more = false) {
  try {
    const r = await api(`/api/media${more && state.mediaNext ? `?after=${encodeURIComponent(state.mediaNext)}` : ''}`);
    state.media = more ? state.media.concat(r.items) : r.items;
    state.mediaNext = r.next;
    renderMediaGrid();
  } catch (e) { $('#media-grid').replaceChildren(h('div', { class: 'hint' }, `Não foi possível carregar as publicações: ${e.message}`)); }
}
$('#media-more').addEventListener('click', () => loadMedia(true));

function openModal(auto = null) {
  state.editing = auto;
  state.selectedMedia = null;
  form.reset();
  $('#modal-title').textContent = auto ? 'Editar automação' : 'Nova automação';
  $('#media-field').classList.toggle('hidden', !!auto);
  const sel = $('#media-selected');
  sel.classList.toggle('hidden', !auto);
  sel.replaceChildren();
  if (auto) {
    form.keyword.value = auto.keyword;
    form.message.value = auto.message;
    form.link.value = auto.link;
    sel.append(h('span', {}, 'Publicação'), h('div', { class: 'selected-media' },
      h('img', { src: auto.media_thumb || '', alt: '', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'auto-sub' }, auto.media_caption || 'Publicação sem legenda')));
  } else {
    $('#media-grid').replaceChildren(h('div', { class: 'hint' }, 'Carregando publicações…'));
    loadMedia();
  }
  const a = state.account;
  $('#pv-user').textContent = a ? a.username : 'sua conta';
  $('#pv-avatar').textContent = initials(a?.username);
  updatePreview();
  dialog.showModal();
  (auto ? form.keyword : $('#media-grid')).focus?.();
}
$('#btn-new').addEventListener('click', () => openModal());
$('#hero-cta').addEventListener('click', (e) => { if (state.account) { e.preventDefault(); openModal(); } });
$('#btn-cancel').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { keyword: form.keyword.value.trim(), message: form.message.value.trim(), link: form.link.value.trim() };
  if (!state.editing && !state.selectedMedia) return toast('Escolha a publicação', true);
  if (!keywords(body.keyword).length) return toast('Informe a palavra-chave', true), form.keyword.focus();
  if (!body.message) return toast('Escreva a mensagem', true), form.message.focus();
  if (!form.link.checkValidity() || !body.link) return toast('Informe um link válido (https://…)', true), form.link.focus();
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    if (state.editing) {
      await api(`/api/automations/${state.editing.id}`, { method: 'PATCH', body });
      toast('Automação atualizada');
    } else {
      const m = state.selectedMedia;
      await api('/api/automations', { method: 'POST', body: {
        ...body, media_id: m.id, media_type: m.media_product_type || m.media_type, media_permalink: m.permalink,
        media_caption: (m.caption || '').slice(0, 300), media_thumb: mediaThumb(m),
      } });
      toast('Automação criada e ativa');
    }
    dialog.close();
    await Promise.all([loadAutomations(), renderStats()]);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

// ---------------- histórico ----------------
const STATUS = { sent: 'Enviada', failed: 'Falha', queued: 'Na fila', sending: 'Enviando', ignored: 'Ignorado' };

async function loadEvents(append = false) {
  const before = append && state.events.length ? `&before=${state.events.at(-1).id}` : '';
  const r = await api(`/api/events?limit=30${state.filter ? `&status=${state.filter}` : ''}${before}`);
  state.events = append ? state.events.concat(r.items) : r.items;
  const box = $('#events');
  if (!state.events.length) {
    box.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Nada por aqui'), 'Os comentários das publicações com automação aparecem aqui.'));
    return;
  }
  const rows = state.events.map((e) => h('tr', {},
    h('td', {}, fmtDate(e.received_at)),
    h('td', {}, e.from_username ? `@${e.from_username}` : (e.from_id || '—')),
    h('td', {}, h('div', { class: 'ev-text', title: e.text || '' }, e.text || '—'), h('div', { class: 'ev-reason' }, e.media_caption ? `em: ${e.media_caption.slice(0, 50)}` : '')),
    h('td', {}, h('span', { class: `tag ${e.status}` }, STATUS[e.status] || e.status),
      (e.reason || e.error) ? h('div', { class: 'ev-reason' }, e.error || e.reason) : null,
      e.status === 'queued' && e.attempts ? h('div', { class: 'ev-reason' }, `tentativa ${e.attempts + 1} às ${fmtDate(e.next_attempt_at)}`) : null),
    h('td', {}, e.status === 'failed'
      ? h('button', { class: 'icon-btn', type: 'button', title: 'Tentar de novo', 'aria-label': 'Tentar de novo', onclick: () => retry(e) }, icon('i-retry'))
      : null)));
  const table = h('table', { class: 'events' },
    h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'Comentário', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows));
  box.replaceChildren(table, r.items.length === 30 ? h('div', { class: 'more' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => loadEvents(true) }, 'Carregar mais')) : '');
}

async function retry(e) {
  try { await api(`/api/events/${e.id}/retry`, { method: 'POST' }); toast('Reenvio agendado'); setTimeout(refresh, 1500); }
  catch (err) { toast(err.message, true); }
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.filter');
  if (!b) return;
  state.filter = b.dataset.s;
  document.querySelectorAll('.filter').forEach((f) => f.setAttribute('aria-pressed', String(f === b)));
  loadEvents().catch((err) => toast(err.message, true));
});

// ---------------- configurações ----------------
const metaForm = $('#meta-form');
const pwForm = $('#pw-form');

function renderSettings(s) {
  metaForm.igAppId.value = s.igAppId || '';
  metaForm.igAppSecret.value = '';
  metaForm.igAppSecret.placeholder = s.igAppSecretSet ? '•••••••• (salvo, deixe vazio para manter)' : '';
  $('#secret-state').textContent = s.igAppSecretSet ? 'salvo ✓' : 'pendente';
  metaForm.webhookVerifyToken.value = s.webhookVerifyToken || '';
  for (const k of ['igAppId', 'igAppSecret', 'webhookVerifyToken']) {
    metaForm[k].disabled = s.locked[k];
    metaForm[k].title = s.locked[k] ? 'Definido no .env do servidor' : '';
  }
  $('#meta-save').disabled = s.locked.igAppId && s.locked.igAppSecret && s.locked.webhookVerifyToken;
  $('#url-webhook').value = s.urls.webhook;
  $('#url-callback').value = s.urls.callback;
  $('#url-privacy').value = s.urls.privacy;
  // Avisa quando APP_BASE_URL (do servidor) não é o endereço aberto no navegador:
  // com URL errada, o login do Instagram e o webhook não funcionam.
  const configured = (() => { try { return new URL(s.urls.webhook).origin; } catch { return ''; } })();
  const warn = $('#url-warning');
  warn.classList.toggle('hidden', configured === location.origin);
  if (configured !== location.origin) {
    $('#url-warning-text').textContent =
      `O servidor está configurado com ${configured}, mas você está acessando ${location.origin}. ` +
      `Corrija APP_BASE_URL no .env da VPS para ${location.origin} e rode "docker compose up -d" antes de colar estas URLs na Meta.`;
  }
  $('#pw-locked').classList.toggle('hidden', !s.locked.password);
  $('#pw-fields').classList.toggle('hidden', s.locked.password);
}

async function loadSettings() { renderSettings(await api('/api/settings')); }

metaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ['igAppId', 'igAppSecret', 'webhookVerifyToken']) if (!metaForm[k].disabled) body[k] = metaForm[k].value.trim();
  const btn = $('#meta-save');
  btn.disabled = true;
  try {
    renderSettings(await api('/api/settings', { method: 'PUT', body }));
    toast('Configurações salvas');
    await boot();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (pwForm.password.value.length < 10) return toast('A nova senha precisa ter ao menos 10 caracteres', true), pwForm.password.focus();
  const btn = $('#pw-save');
  btn.disabled = true;
  try {
    await api('/api/password', { method: 'POST', body: { current: pwForm.current.value, password: pwForm.password.value } });
    pwForm.reset();
    toast('Senha alterada');
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

// Clicar numa URL seleciona e copia.
document.querySelectorAll('.input.copy').forEach((el) => el.addEventListener('click', () => {
  el.select();
  navigator.clipboard?.writeText(el.value).then(() => toast('Copiado'), () => {});
}));

// ---------------- inicialização ----------------
async function refresh() {
  if (!state.account) return;
  await Promise.all([renderStats(), loadAutomations(), loadEvents()]).catch((e) => toast(e.message, true));
}

async function boot() {
  const { account, metaReady } = await api('/api/me');
  state.account = account;
  state.metaReady = metaReady;
  renderAccount();
  await refresh();
}

const params = new URLSearchParams(location.search);
if (params.get('conectado')) toast('Conta conectada com sucesso');
if (params.get('erro')) toast(params.get('erro'), true);
if (params.toString()) history.replaceState(null, '', '/');

boot().catch((e) => toast(e.message, true));
loadSettings().catch((e) => toast(e.message, true));
setInterval(() => { if (!document.hidden && !dialog.open) refresh(); }, 30000);
