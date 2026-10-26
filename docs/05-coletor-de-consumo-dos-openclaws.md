# Coletor de consumo dos OpenClaws

Alimenta a tela **OpenClaws** do painel (só Proprietário). O coletor roda no
**servidor dos OpenClaws** (`187.77.51.109`), não neste projeto: lê o uso de cada
agente de cada contêiner e o manda para `POST /api/ingestao/openclaws`.

```text
servidor dos OpenClaws                          painel (Easypanel)
 cron a cada 2 h                                 /api/ingestao/openclaws
 └─ coletor-consumo-openclaw ──(HTTPS, Bearer)──▶ grava OpenClawUso / OpenClawLimite
    lê os SQLite, só leitura                      └─ /openclaws lê e calcula
```

O código do coletor é `scripts/openclaws/coletor-consumo-openclaw.py` (Python 3
puro, sem dependência). As regras da tela estão em `src/server/openclaws/`.

---

## 1. O que ele lê

| Fonte | Para quê |
| --- | --- |
| `transcript_events` de cada `openclaw-agent.sqlite` | Cada mensagem do assistente traz `message.usage` (`input`, `output`, `cacheRead`, `cacheWrite`), o modelo e o motivo de parada. |
| `session_windows` do mesmo banco | O tipo da sessão (`main`, `dashboard`, `cron`, `subagent`…) vem da chave. |
| Log do gateway do dia (`docker exec … cat /tmp/openclaw/openclaw-AAAA-MM-DD.log`) | Os 429 (`status=429`). O erro de alguns OpenClaws só aparece aqui, não na transcrição. |

⚠ **Não toca em credencial.** Nenhuma leitura de `auth_profile_*` nem de arquivo de
login. O único segredo é o token do painel, num arquivo `600`.

⚠ **O `model.completed` dos eventos de trajetória NÃO tem uso** na versão 2026.9.7.
Quem procurar tokens ali não acha.

⚠ **~20 mil eventos antigos ficam comprimidos** (`event_zstd`, zstd), e o Python do
host não tem módulo zstd: o coletor decodifica pelo binário `zstd`. Só a carga
inicial (`--tudo`) paga esse custo (~2 min); as rodadas normais leem as últimas
8 horas, que estão em texto.

## 2. O que a tela faz com isso

- **Custo equivalente** = tarifa pública da API × tokens (`precos.ts`). Não é
  fatura: a assinatura não cobra por token.
- **Cota semanal** = a média do gasto até o instante em que a Anthropic começou a
  recusar (429), nas semanas em que a conta travou. Medido em 26/10/2026:
  US$ 888, 1.057 e 1.221 equivalentes. A Anthropic não publica o limite, e o token
  dos OpenClaws não consegue consultá-lo (`HTTP 403: … user:profile`).
- **Reset**: domingo às 19:00 UTC (16:00 em São Paulo), medido nos quatro
  bloqueios de outubro. Editável na tela.
- **Conta compartilhada**: o OpenClaw do Guilherme (`2bpu`) usa credencial própria
  — seguiu respondendo enquanto os outros levavam 429. Aparece com o consumo dele,
  marcado, e não entra na cota nem na detecção de bloqueio.

⚠ **A conta dos OpenClaws NÃO é a do proxy Claude MAX da Seahub**: o proxy
reinicia a semana no domingo às 10:59 UTC. Não use o `plan_quota` dele como cota
dos OpenClaws.

---

## 3. Instalação no servidor dos OpenClaws

Pré-requisitos: `python3` e `zstd` (já existem), e o contêiner `docker`.

```bash
# 1. os scripts
install -m 755 coletor-consumo-openclaw.py /usr/local/bin/coletor-consumo-openclaw
install -m 755 coletor-cota-login /usr/local/bin/coletor-cota-login

# 2. o token (gerado em Painel → OpenClaws → Configuração e coletor)
install -d -m 700 /root/.config/coletor-openclaw
umask 077 && printf '%s' 'seahub_oc_…' > /root/.config/coletor-openclaw/token

# 3. o relógio: a cada 2 h, sem brigar por processador com os agentes
cat > /etc/cron.d/coletor-openclaw <<'EOF'
7 */2 * * * root nice -n 19 /usr/bin/python3 /usr/local/bin/coletor-consumo-openclaw --ignorar h8qa >> /var/log/coletor-openclaw.log 2>&1
EOF

# 4. a carga inicial (histórico inteiro, ~2 min) e a conferência
/usr/local/bin/coletor-consumo-openclaw --tudo --ignorar h8qa
```

`--ignorar` recebe ids de contêiner separados por vírgula (`h8qa` é um contêiner
de teste). `--dry-run` mostra o que enviaria; `--salvar-em arquivo.json` grava os
lotes em vez de enviar (serve para conferir ou testar contra um painel local).

## 4. A % real: o login da conta (opcional, recomendado)

Sem isto a tela **estima** a cota pelos bloqueios. Com isto ela mostra o que a
Anthropic mede (janela de 5 horas, semana, Opus, Sonnet) e o horário exato do
reset.

O token que os OpenClaws usam para conversar (`setup-token`) é **só de
inferência**: pedir a utilização com ele dá `HTTP 403 … user:profile`. A leitura
precisa de um **segundo login, completo**, feito de propósito:

```bash
coletor-cota-login            # mostra uma URL; abra, entre com a conta DOS OPENCLAWS,
                              # autorize e cole o código de volta
coletor-cota-login status     # o login vale? mostra também a leitura da cota
```

(`coletor-cota-login` fica em `/usr/local/bin`; o script é
`scripts/openclaws/coletor-cota-login`.)

⚠ **Tem que ser a MESMA conta dos OpenClaws.** A conferência é o reset: a tela
mostra um aviso se o que a Anthropic informa não bate com o configurado (o ciclo
dos OpenClaws recomeça no domingo, 16h de São Paulo). Reset diferente = conta
errada; saia e entre de novo com a certa.

⚠ **Por que não numa variável de ambiente.** O par de tokens deste login **gira**:
o acesso dura ~8 h e cada renovação emite um refresh token novo. O coletor
reescreve o arquivo (`/root/.config/coletor-openclaw/claude/.credentials.json`,
`600`, com cópia `.bak`); uma variável é fixa e guardaria um token que deixa de
valer na primeira renovação.

⚠ **O diretório é próprio de propósito.** Os contêineres dos OpenClaws montam o
`/root/.claude` do servidor, e um login ali trocaria a credencial que eles usam.

**Trocar de conta** (a que os OpenClaws usam mudou):

```bash
coletor-cota-login logout && coletor-cota-login
```

e entre no navegador com a conta NOVA. Não há variável nem arquivo para editar.
Trocar o `setup-token` dos OpenClaws **não** troca este login: são credenciais
separadas, e a leitura passa a descrever a conta antiga até alguém refazê-lo.

Se o login vencer (refresh recusado), o coletor segue enviando o consumo e a tela
mostra "leitura atrasada" depois de 6 horas, voltando à cota estimada.

**Provado em 26/10/2026, contra a Anthropic real:**

- O login Max 20x devolve `five_hour` e `seven_day` em `/api/oauth/usage`
  (percentual de 0 a 100, reset com décimos de segundo antes da hora:
  `18:59:59,6` = domingo 19:00 UTC).
- A **renovação funciona** (`platform.claude.com/v1/oauth/token`, `grant_type=
  refresh_token`, `client_id` do Claude Code): a resposta traz `access_token`,
  `refresh_token`, `expires_in` (~8 h) e `refresh_token_expires_in` (~28,6 dias).
- O refresh token **se estende a cada renovação**: enquanto o coletor rodar de
  vez em quando (ele renova a cada ~8 h), o login não vence. Parado por mais de
  ~28 dias, é preciso refazer `coletor-cota-login`.
- `coletor-consumo-openclaw --renovar-agora` força uma renovação (teste e manutenção) e
  mostra só os NOMES dos campos da resposta. O arquivo é copiado para `.bak` antes
  de qualquer troca, e nada é gravado se a resposta vier sem `access_token`.
- Primeira calibragem: 5% medidos ↔ US$ 34,88 equivalentes dos OpenClaws, ou seja,
  100% ≈ US$ 700 — abaixo dos US$ 1.050 estimados pelos bloqueios. A tela passa a
  usar a leitura e a se calibrar a cada coleta (mediana das últimas 24 leituras).

## 5. Operação

- **Rotacionar o token do painel**: gerar outro na tela e gravar em
  `/root/.config/coletor-openclaw/token`. Enquanto isso o coletor leva `401` (fica
  no log) e **não perde nada**: a rodada seguinte relê as últimas 8 horas.
- **Coletor parou**: a tela avisa quando a última coleta tem mais de 5 horas.
  Log em `/var/log/coletor-openclaw.log`.
- **OpenClaw novo**: aparece na tela sozinho, sem nome, na primeira coleta. Nomeie
  na tela. Contêiner de teste: acrescente em `--ignorar`.
- **Lotes se substituem por janela**: reenviar o mesmo lote não duplica, e uma hora
  que ficou sem uso some em vez de sobrar velha. Janela de no máximo 45 dias por
  lote (o coletor manda de 30 em 30).
- **Reinício do contêiner apaga o log do gateway** (`/tmp`). Os 429 do dia ficam só
  na transcrição, e para alguns OpenClaws isso subconta as recusas.
