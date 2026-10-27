const f = document.getElementById('f');
let setup = false;

// Primeiro acesso: em vez de entrar, cria a senha com o código mostrado no log do servidor.
fetch('/api/setup').then((r) => r.json()).then(({ needsSetup }) => {
  if (!needsSetup) return;
  setup = true;
  document.getElementById('title').textContent = 'Criar senha do painel';
  document.getElementById('lead').textContent = 'Primeiro acesso: informe o código de configuração e escolha uma senha (mínimo 10 caracteres).';
  document.getElementById('code-field').classList.remove('hidden');
  document.getElementById('pw-label').textContent = 'Nova senha';
  document.getElementById('go').textContent = 'Criar senha e entrar';
  f.code.required = true;
  f.password.autocomplete = 'new-password';
  f.password.minLength = 10;
  f.code.focus();
}).catch(() => {});

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  const btn = document.getElementById('go');
  btn.disabled = true; err.textContent = '';
  try {
    const [url, body] = setup
      ? ['/api/setup', { code: f.code.value, password: f.password.value }]
      : ['/api/login', { password: f.password.value }];
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return location.replace('/');
    err.textContent = (await res.json().catch(() => ({}))).error || 'Não foi possível entrar';
    err.style.color = 'var(--accent-deep)';
  } catch { err.textContent = 'Sem conexão com o servidor'; }
  finally { btn.disabled = false; }
});
