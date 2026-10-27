# Etapa 1 — Requisitos técnicos da Meta (verificado em 27/10/2026)

Fontes oficiais consultadas:
- Private Replies: https://developers.facebook.com/documentation/instagram-platform/private-replies
- Comment Moderation: https://developers.facebook.com/documentation/instagram-platform/comment-moderation
- Webhooks: https://developers.facebook.com/documentation/instagram-platform/webhooks
- Business Login for Instagram: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- Rate limits: https://developers.facebook.com/docs/messenger-platform/overview/rate-limiting
- Versões da Graph API: https://developers.facebook.com/docs/graph-api/changelog/versions

## 1. Caminho escolhido: "Instagram API with Instagram Login"

A Meta oferece dois caminhos. Escolhemos o **Business Login for Instagram** porque:

| | Instagram Login (escolhido) | Facebook Login |
|---|---|---|
| Página do Facebook vinculada | Não precisa | Precisa |
| Token | Instagram User token (60 dias, renovável) | Page token |
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Complexidade | Menor | Maior |

Versão da API fixada: **v26.0** (lançada em 29/07/2026). Configurável por `GRAPH_API_VERSION`.

## 2. Conta do Instagram

- Precisa ser **profissional** (Comercial ou Criador de conteúdo).
- Precisa ser **pública**: a Meta só envia webhook de comentários para contas públicas.
- Em Configurações > Mensagens, a opção **"Permitir acesso a mensagens"** (Ferramentas conectadas) deve estar ligada.

## 3. Permissões (scopes)

| Permissão | Para quê |
|---|---|
| `instagram_business_basic` | Perfil, lista de posts/Reels, assinatura de webhooks |
| `instagram_business_manage_comments` | Receber comentários (e o `username` de quem comentou) |
| `instagram_business_manage_messages` | Enviar a resposta privada (DM) |

## 4. Nível de acesso, App Review e modo Live — o ponto mais importante

- **Webhooks só chegam com o app em modo Live** no App Dashboard.
- O campo de webhook `comments` exige **Advanced Access**, que por sua vez exige **App Review** e **Business Verification**.
- **Standard Access** só serve contas que você próprio administra e adicionou ao app (testers). Para atender contas de terceiros (clientes), é obrigatório Advanced Access.
- Para o App Review você vai precisar: URL de política de privacidade (o app já expõe `/privacy`), instrução de exclusão de dados, um vídeo (screencast) mostrando o fluxo de login → criar automação → comentário → DM, e justificativa de cada permissão.

> Na prática: desenvolva e teste com a sua própria conta adicionada como tester. Antes de abrir para clientes, conclua Business Verification + App Review.

## 5. Webhooks

- Endpoint HTTPS público com certificado válido (`/webhook`).
- **Verificação (GET):** responder `hub.challenge` quando `hub.mode=subscribe` e `hub.verify_token` confere.
- **Notificações (POST):** validar o header `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o App Secret do Instagram) e responder 200 rápido.
- Depois do login, cada conta precisa ser **assinada**: `POST /me/subscribed_apps?subscribed_fields=comments`.
- Não existe filtro por post no lado da Meta: chegam todos os comentários da conta; o filtro por publicação é feito pelo app.
- A Meta pode reenviar o mesmo evento → deduplicação obrigatória por `comment_id`.

Formato (Instagram Login):
```json
{ "object": "instagram",
  "entry": [{ "id": "<IG_ID da conta>", "time": 1700000000,
    "changes": [{ "field": "comments", "value": {
      "id": "<COMMENT_ID>", "text": "QUERO",
      "from": { "id": "<IGSID>", "username": "fulano" },
      "media": { "id": "<MEDIA_ID>", "media_product_type": "REELS" } } }] }] }
```

## 6. Resposta privada (DM)

```
POST https://graph.instagram.com/v26.0/<IG_ID>/messages
Authorization: Bearer <token>
{ "recipient": { "comment_id": "<COMMENT_ID>" }, "message": { "text": "..." } }
```
Regras:
- **Uma única** resposta privada por comentário (erro 100 / subcódigo 2534025 se repetir ou se passar do prazo).
- Prazo de **7 dias** a partir do comentário (Live: só durante a transmissão — fora do escopo do MVP).
- A DM cai na caixa principal se a pessoa segue a conta; senão, em **Solicitações**.
- Mensagens seguintes só são permitidas se a pessoa responder, dentro de 24h. O MVP não envia follow-ups.

## 7. Limites

- **750 respostas privadas por hora** por conta profissional (posts e Reels). O app usa por padrão um teto de 600/h (margem) e reagenda o excedente — dentro da janela de 7 dias.
- Send API: 300 chamadas/s para texto (não é gargalo aqui).
- Código de erro de limite: 4, 17, 32, 613, 80002 → reagendar com backoff.

## 8. Token

- Código OAuth → token curto (1h) → **token longo (60 dias)** via `grant_type=ig_exchange_token` (chamada server-side com App Secret).
- Renovação com `grant_type=ig_refresh_token` (token precisa ter ≥ 24h). O app renova automaticamente quando faltam menos de 10 dias.
- Token guardado **criptografado** (AES-256-GCM) no banco.

## 9. Políticas que o app respeita

- Somente API oficial; nada de scraping ou automação de navegador.
- Só responde quem comentou de forma ativa (ação do próprio usuário) e uma vez por comentário.
- Não responde comentários da própria conta (evita loops).
- Uma DM por pessoa por automação (anti-spam), mesmo que a pessoa comente várias vezes.
- Histórico de comentários apagado automaticamente após 90 dias (minimização de dados).
