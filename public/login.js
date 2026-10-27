const f = document.getElementById('f');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  const btn = document.getElementById('go');
  btn.disabled = true; err.textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.password.value }) });
    if (res.ok) return location.replace('/');
    err.textContent = (await res.json().catch(() => ({}))).error || 'Não foi possível entrar';
    err.style.color = 'var(--accent-deep)';
  } catch { err.textContent = 'Sem conexão com o servidor'; }
  finally { btn.disabled = false; }
});
