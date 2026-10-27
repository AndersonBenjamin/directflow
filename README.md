# Linka — DM automática por palavra-chave no Instagram

Quando alguém comenta a palavra-chave (ex.: **QUERO**) em um post ou Reels, o app envia uma DM com o link do produto, usando **somente a API oficial da Meta** (Instagram API with Instagram Login + Private Replies).

Requisitos da Meta, permissões, limites e App Review: veja **[docs/REQUISITOS-META.md](docs/REQUISITOS-META.md)**.

## Arquitetura

```
Instagram ──webhook (comments)──▶ /webhook ──▶ valida assinatura ──▶ SQLite (fila, dedup por comment_id)
                                                                          │
                                                       worker (a cada 5s) ▼
                                         POST /{ig-id}/messages {recipient:{comment_id}}
Painel (HTML/JS) ◀──▶ API /api/* (sessão por senha)
```

- **Node.js ≥ 22.13, zero dependências** (`http`, `fetch`, `node:sqlite`, `crypto` nativos). Menos superfície de ataque, nada para atualizar.
- **SQLite** em um arquivo (`data/app.db`). Um único processo — roda numa VPS de US$ 4–6/mês, Railway, Render ou Fly.io com volume persistente.
- Webhook responde 200 em milissegundos; o envio é feito por uma fila no banco, com reenvio automático.

| Pasta | Conteúdo |
|---|---|
| `src/graph.js` | Cliente da Graph API (OAuth, mídia, webhooks, resposta privada) e classificação de erros |
| `src/automation.js` | Regras: palavra-chave, deduplicação, fila, limite por hora, renovação de token |
| `src/server.js` | Rotas HTTP, webhook, OAuth, API do painel, segurança |
| `src/db.js` | Esquema e consultas SQLite |
| `public/` | Painel (sem build) |
| `test/` | Testes ponta a ponta com Graph API simulada |

## Regras de envio

- Palavra inteira, sem diferenciar maiúsculas/acentos; aceita variações separadas por vírgula (`QUERO, EU QUERO`).
- Uma automação por publicação; pode ser pausada a qualquer momento.
- Deduplicação em três camadas: `comment_id` único (reentregas da Meta), uma DM por pessoa por automação, e trava atômica na fila.
- Ignora comentários da própria conta (evita loops).
- Respeita o prazo de 7 dias e o teto por hora (padrão 600/h, Meta permite 750/h); o excedente espera na fila.
- Erros temporários e de limite são reenviados com backoff (até 6 tentativas); token inválido marca a conta para reconexão.
- Token longo (60 dias) guardado com AES-256-GCM e renovado automaticamente.
- Histórico apagado após 90 dias.

## Configuração da Meta (passo a passo)

1. Em [developers.facebook.com](https://developers.facebook.com/apps), crie um app do tipo **Empresa** e adicione o produto **Instagram** → *API setup with Instagram login*.
2. Copie **Instagram App ID** e **Instagram App Secret** para o `.env`.
3. Em *Business login settings*, adicione o **OAuth redirect URI**: `https://SEU-DOMINIO/auth/instagram/callback`.
4. Em *Configure webhooks*: Callback URL `https://SEU-DOMINIO/webhook`, Verify token = `WEBHOOK_VERIFY_TOKEN`. Clique em verificar e **assine o campo `comments`**.
5. Em *Roles*, adicione sua conta do Instagram como **Instagram Tester** e aceite o convite no app do Instagram (Configurações > Apps e sites).
6. Na conta do Instagram: profissional, **pública**, e *Configurações > Mensagens > Ferramentas conectadas > Permitir acesso a mensagens* ligado.
7. Coloque o app em **Live**. Para receber webhooks de `comments` a Meta exige **Advanced Access** → faça Business Verification e App Review das três permissões (use `/privacy` como URL da política).

## Rodando

```bash
cp .env.example .env        # preencha
npm start                   # ou npm run dev
npm test                    # 8 testes ponta a ponta, sem acessar a Meta
```

Para testar localmente com a Meta real, exponha a porta com um túnel HTTPS (ex.: `cloudflared tunnel --url http://localhost:3000`) e use essa URL em `APP_BASE_URL`.

## Deploy na VPS com Docker

O `docker-compose.yml` sobe dois containers: o **app** (porta 3000, fechada para a internet) e o **Caddy**, que recebe nas portas 80/443 e emite o certificado HTTPS sozinho (Let's Encrypt). O banco fica no volume `app-data`.

**Pré-requisitos:** VPS com Docker + Compose (`curl -fsSL https://get.docker.com | sh`), portas 80 e 443 livres e abertas no firewall, e um registro DNS **A** do domínio apontando para o IP da VPS.

```bash
# no seu computador: enviar o projeto
scp linka-direct.zip usuario@IP-DA-VPS:~
# na VPS
unzip linka-direct.zip && cd insta-direct
cp .env.example .env && nano .env      # DOMAIN, APP_BASE_URL e o resto
docker compose up -d --build
docker compose logs -f app             # deve mostrar "rodando em https://..."
```

Abra `https://SEU-DOMINIO`. Na Meta, use `https://SEU-DOMINIO/webhook` e `https://SEU-DOMINIO/auth/instagram/callback`.

| Tarefa | Comando |
|---|---|
| Ver logs | `docker compose logs -f app` |
| Atualizar o código | substituir os arquivos e `docker compose up -d --build` |
| Reiniciar | `docker compose restart app` |
| Parar | `docker compose down` (os dados ficam no volume) |
| Backup do banco | `docker compose exec app node scripts/backup.js` |
| Copiar backups para a VPS | `docker compose cp app:/app/data/backups ./backups` |

Backup diário automático (crontab da VPS, `crontab -e`):
```
15 3 * * * cd ~/insta-direct && docker compose exec -T app node scripts/backup.js && docker compose cp app:/app/data/backups ./backups
```

**Já tem Nginx/Traefik na porta 443?** Remova o serviço `caddy` do compose, troque `expose` por `ports: ["127.0.0.1:3000:3000"]` no `app` e aponte seu proxy para `http://127.0.0.1:3000` (repassando o header `X-Forwarded-For`).

> `docker compose down -v` **apaga** os volumes, inclusive o banco. Não use o `-v` a menos que queira zerar tudo.

### Observações de produção
- Cookies ficam `Secure` automaticamente quando `APP_BASE_URL` é https.
- Um processo só (a fila não é distribuída). Para escalar, troque SQLite por Postgres e o worker por uma fila — as funções do `db.js` são o único ponto a mudar.

## Próximas melhorias (fora do MVP)
- Resposta pública automática no comentário ("te enviei no direct!").
- Botão com link (template) em vez de link em texto.
- Várias contas / multiusuário com login próprio.
- Fluxo "segue para liberar o link" usando a janela de 24h após resposta da pessoa.
