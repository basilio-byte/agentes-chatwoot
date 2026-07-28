# Deploy no Easypanel a partir do GHCR

A imagem é publicada automaticamente no GitHub Container Registry a cada push na
`main`. O Easypanel só puxa a imagem pronta — não compila nada no servidor.

```text
push na main → GitHub Actions → ghcr.io/basilio-byte/agentes-chatwoot:latest → Easypanel
```

---

## 1. O que o workflow faz

`.github/workflows/publish.yml` roda em todo push na `main`, em tags `v*` e sob
demanda. Ele:

- autentica no GHCR com o `GITHUB_TOKEN` do próprio Actions — **não precisa criar
  PAT** para publicar;
- publica com as tags `latest`, `sha-<commit>` e, em tags `v*`, também `1.2.3` e `1.2`;
- reaproveita cache entre execuções (a camada pesada do CLI do Prisma só é
  reconstruída quando as dependências mudam);
- dispara o deploy no Easypanel se o secret `EASYPANEL_DEPLOY_WEBHOOK` existir.

Use `latest` para o ambiente que acompanha a `main` e uma tag `v*` quando quiser
fixar a versão em produção.

---

## 2. Tornar a imagem acessível

O pacote nasce **privado**. Duas opções:

**a) Deixar público** (mais simples) — GitHub → repositório → *Packages* →
`agentes-chatwoot` → *Package settings* → *Change visibility* → Public.
A imagem não contém segredo nenhum: tudo vem de variável de ambiente.

**b) Manter privado** — crie um PAT clássico com escopo `read:packages` e cadastre
no Easypanel em *Settings → Registries*:

| Campo | Valor |
| --- | --- |
| Registry | `ghcr.io` |
| Username | seu usuário do GitHub |
| Password | o PAT com `read:packages` |

---

## 3. Serviços no Easypanel

Crie três serviços no mesmo projeto.

### `postgres`

Template Postgres do Easypanel, versão **16**. Anote usuário, senha e nome do
banco — viram a `DATABASE_URL`.

### `redis`

Template Redis do Easypanel, versão **7**. Ainda não é usado na Fase 1, mas o app
valida a variável no boot.

### `app`

Tipo **App** → origem **Docker Image**:

```text
ghcr.io/basilio-byte/agentes-chatwoot:latest
```

Porta interna: **3000**. Habilite o domínio e o HTTPS (o Traefik do Easypanel
cuida do certificado).

Variáveis de ambiente:

```env
DATABASE_URL=postgresql://USUARIO:SENHA@postgres:5432/BANCO?schema=public
REDIS_URL=redis://redis:6379

OPENROUTER_API_KEY=sk-or-v1-...

AUTH_SECRET=<openssl rand -base64 32>
AUTH_TRUST_HOST=true

ENCRYPTION_KEY=<openssl rand -base64 32>

BOOTSTRAP_TOKEN=<openssl rand -hex 16>

LOG_LEVEL=info
```

Os hostnames `postgres` e `redis` são os nomes dos serviços dentro do projeto —
o Easypanel resolve na rede interna.

> ⚠️ **`ENCRYPTION_KEY` não pode mudar depois.** Trocar essa chave torna ilegíveis
> todas as credenciais de integração já salvas. Guarde junto com as senhas do
> projeto.

---

## 4. Primeiro acesso

As migrations rodam sozinhas no start do container (`docker-entrypoint.sh`), então
o banco já sobe com o schema.

A conta inicial é criada pela tela: abra `https://SEU-DOMINIO/` e você cai em
**/primeiro-acesso**. Preencha nome, e-mail, senha e o `BOOTSTRAP_TOKEN`. A tela
desaparece assim que a primeira conta existir.

> Sem `BOOTSTRAP_TOKEN` definido, a tela aceita qualquer um que chegue primeiro.
> Em produção, defina o token.

---

## 5. Deploy automático (opcional)

No serviço `app` do Easypanel, em *Deploy → Webhook*, copie a URL. No GitHub, em
*Settings → Secrets and variables → Actions*, crie:

| Secret | Valor |
| --- | --- |
| `EASYPANEL_DEPLOY_WEBHOOK` | a URL copiada |

A partir daí: push na `main` → imagem publicada → Easypanel puxa e reinicia
sozinho. Sem o secret, o workflow avisa no log e você aperta *Deploy* na mão.

---

## 6. Atualizar

- **Acompanhando a `main`:** o webhook resolve, ou clique em *Deploy*.
- **Versão fixa:** `git tag v1.0.0 && git push origin v1.0.0`, depois troque a tag
  da imagem no Easypanel para `v1.0.0`.
- **Rollback:** troque a tag para o `sha-<commit>` anterior e faça deploy. As
  migrations não são revertidas automaticamente — se a versão anterior for
  incompatível com o schema, é preciso tratar à mão.

---

## 7. Worker de atendimento

Sem worker o bot **recebe e não responde**: as entregas ficam gravadas e nada
sai. Duas formas de ligar — escolha no deploy, a imagem é a mesma.

### a) Dentro do container do app (mais simples)

Basta uma variável no serviço `app`:

```env
RUN_WORKER_IN_APP=true
```

O entrypoint sobe o worker junto e o encerra junto, esperando os jobs em
andamento terminarem. Suficiente para o volume de um coworking, e não custa
serviço nem memória extra no Easypanel.

### b) Serviço separado (escala independente)

Crie um segundo serviço App com a **mesma imagem**, mudando:

| Campo | Valor |
| --- | --- |
| Comando | `node worker.mjs` |
| Variáveis | as mesmas do `app`, mais `SKIP_MIGRATIONS=true` |

O `SKIP_MIGRATIONS` evita que os dois disputem a migração na subida. Não
publique domínio para este serviço — ele não escuta HTTP.

Use esta forma quando quiser escalar worker e painel separadamente, ou isolar um
pico de atendimento do uso do painel.

---

## 8. Configurar os bots

Um Agent Bot **por agente**, para cada um ter nome e avatar próprios.

1. No painel, em **Integrações**, salve a URL da instância e o id da conta.
2. Na tela do agente, copie a **URL de webhook** dele.
3. No Chatwoot, em *Configurações → Bots → Adicionar bot*: nome, avatar e essa URL.
4. Copie o **access token** e o **secret** que aparecem e cole no card do agente.
   O secret aparece uma vez — guarde na hora.
5. Vincule o bot à inbox, em *Bot Configuration* dentro da inbox.
6. Aperte **Testar conexão** no painel.

Erros comuns: 401 costuma ser token pessoal de agente no lugar do token do bot;
404 costuma ser URL ou id de conta errados.
