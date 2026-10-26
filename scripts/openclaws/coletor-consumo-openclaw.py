#!/usr/bin/env python3
"""
Coletor de consumo dos OpenClaws — roda no SERVIDOR DOS OPENCLAWS (não aqui).

Lê, só para leitura, o banco SQLite de cada agente de cada contêiner, soma o uso
por hora e manda para o painel (`/api/ingestao/openclaws`). Sem modelo, sem
rede além do POST, sem escrever em nada do OpenClaw.

Instalação e operação: docs/05-coletor-de-consumo-dos-openclaws.md.

O que é lido
- `transcript_events`: cada mensagem do assistente traz `message.usage`
  (input, output, cacheRead, cacheWrite), o modelo e o motivo de parada. O
  `model.completed` dos eventos de trajetória NÃO tem uso nesta versão.
- Eventos antigos ficam comprimidos (`event_zstd`, zstd). O Python do host não
  tem módulo zstd, então decodifica pelo binário `zstd`. Só eventos recentes
  são lidos a cada rodada, então a decodificação é rara (a carga inicial,
  com `--tudo`, é a exceção: ~20 mil linhas, ~2 minutos).
- Recusas (429): da própria transcrição (`stopReason: error`) e do log do
  gateway do dia (`status=429`). O erro de alguns OpenClaws só aparece no log.

Credenciais: NÃO toca em `auth_profile_*` nem em nenhum arquivo de credencial.
O único segredo é o token do painel, lido de um arquivo 600.
"""

import argparse
import collections
import datetime
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

PASTA_PADRAO = "/docker"
ARQUIVO_DO_TOKEN = "/root/.config/coletor-openclaw/token"
ARQUIVO_DA_URL = "/root/.config/coletor-openclaw/url"
URL_PADRAO = "https://agentes.seahubcoworking.com.br/api/ingestao/openclaws"

HORA = datetime.timedelta(hours=1)
# O painel recusa janela de mais de 45 dias; 30 deixa folga.
DIAS_POR_LOTE = 30
LINHAS_POR_LOTE = 5000

ID_DO_CONTEINER = re.compile(r"^[a-z0-9]{2,16}$")
AGENTE_VALIDO = re.compile(r"^[\w.-]{1,64}$")
TIPO_VALIDO = re.compile(r"^[\w.:-]{1,40}$")


def agora_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def inicio_da_hora(d):
    return d.replace(minute=0, second=0, microsecond=0)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def analisar_data(texto):
    return datetime.datetime.fromisoformat(texto.replace("Z", "+00:00")).astimezone(
        datetime.timezone.utc
    )


def tipo_da_sessao(chave):
    """`agent:main:cron:123` -> `cron`. Chave fora do padrão vira `outro`."""
    partes = (chave or "").split(":")
    if len(partes) >= 3 and partes[0] == "agent" and TIPO_VALIDO.match(partes[2]):
        return partes[2]
    return "outro"


def categoria_do_erro(mensagem):
    if "rate_limit" in mensagem or mensagem.startswith("429"):
        return "rate_limit"
    if "prompt is too long" in mensagem:
        return "prompt_too_long"
    return "outro"


def descomprimir(blob):
    r = subprocess.run(["zstd", "-dc"], input=blob, capture_output=True)
    if r.returncode != 0:
        return None
    return r.stdout.decode("utf-8", "replace")


def ler_conteiner(pasta, conteiner, desde, ate, vistos, uso, limites, falhas):
    """Soma o uso e as recusas de um contêiner na janela [desde, ate)."""
    ini_ms = int((desde - HORA).timestamp() * 1000)  # folga: created_at ~ timestamp
    fim_ms = int((ate + HORA).timestamp() * 1000)

    for banco in sorted(
        glob.glob(f"{pasta}/openclaw-{conteiner}/data/.openclaw/agents/*/agent/openclaw-agent.sqlite")
    ):
        agente = banco.split("/agents/")[1].split("/")[0]
        if not AGENTE_VALIDO.match(agente):
            falhas.append(f"{conteiner}: agente com nome fora do padrão ({agente}) ignorado")
            continue
        try:
            con = sqlite3.connect(f"file:{banco}?mode=ro", uri=True, timeout=20)
            sessoes = dict(con.execute("select session_id, session_key from session_windows"))
            consulta = (
                "select session_id, event_json, event_zstd from transcript_events "
                "where created_at >= ? and created_at < ? "
                "and (event_json like '%\"role\":\"assistant\"%' or event_zstd is not null)"
            )
            for sid, ej, ez in con.execute(consulta, (ini_ms, fim_ms)):
                if ej is None:
                    ej = descomprimir(ez)
                    if ej is None:
                        falhas.append(f"{conteiner}/{agente}: evento comprimido ilegível")
                        continue
                if '"role":"assistant"' not in ej:
                    continue
                try:
                    evento = json.loads(ej)
                except ValueError:
                    continue
                msg = evento.get("message") or {}
                if msg.get("role") != "assistant":
                    continue

                chave = msg.get("responseId") or evento.get("id")
                if chave in vistos:
                    continue
                vistos.add(chave)

                try:
                    quando = analisar_data(evento["timestamp"])
                except (KeyError, ValueError):
                    continue
                if not (desde <= quando < ate):
                    continue
                hora = iso(inicio_da_hora(quando))

                if msg.get("stopReason") == "error":
                    cat = categoria_do_erro(str(msg.get("errorMessage") or ""))
                    limites[(hora, conteiner, cat)] += 1
                    continue

                u = msg.get("usage")
                if not isinstance(u, dict):
                    continue
                tokens = [int(u.get(c) or 0) for c in ("input", "output", "cacheRead", "cacheWrite")]
                # `delivery-mirror` e afins vêm com uso zerado: não são chamadas ao modelo.
                if sum(tokens) <= 0:
                    continue
                modelo = str(msg.get("model") or "").strip()
                if not modelo:
                    continue
                k = (hora, conteiner, agente, tipo_da_sessao(sessoes.get(sid)), modelo[:120])
                a = uso[k]
                a[0] += 1
                for i, t in enumerate(tokens, start=1):
                    a[i] += t
            con.close()
        except sqlite3.Error as erro:
            falhas.append(f"{conteiner}/{agente}: {erro}")


def recusas_do_log(conteiner, dia, desde, ate, limites, falhas):
    """429 do log do gateway no dia `dia` (AAAA-MM-DD). Vale o MAIOR entre log e transcrição."""
    nome = f"openclaw-{conteiner}-openclaw-1"
    arquivo = f"/tmp/openclaw/openclaw-{dia}.log"
    try:
        r = subprocess.run(
            ["docker", "exec", nome, "cat", arquivo], capture_output=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired) as erro:
        falhas.append(f"{conteiner}: log do dia {dia} não lido ({erro})")
        return
    if r.returncode != 0:
        return  # sem log desse dia (contêiner reiniciado, ou dia sem registro)

    contagem = collections.Counter()
    for linha in r.stdout.decode("utf-8", "replace").splitlines():
        if "status=429" not in linha or "provider=anthropic" not in linha:
            continue
        try:
            data = json.loads(linha).get("_meta", {}).get("date")
            quando = analisar_data(data)
        except (ValueError, AttributeError, TypeError):
            continue
        if desde <= quando < ate:
            contagem[iso(inicio_da_hora(quando))] += 1

    for hora, n in contagem.items():
        k = (hora, conteiner, "rate_limit")
        limites[k] = max(limites[k], n)


# --- A cota REAL da conta ----------------------------------------------------
#
# O token de inferência dos OpenClaws (setup-token) só serve para inferir: pedir a
# utilização com ele dá `HTTP 403 ... user:profile`. Por isso a leitura usa um
# SEGUNDO login, completo, feito de propósito por `coletor-cota-login` num
# diretório próprio — nunca no `/root/.claude`, que os contêineres montam.
#
# Esse login tem um par de tokens que GIRA: o acesso dura umas 8 h e cada
# renovação emite um refresh token novo. Por isso ele mora num arquivo que o
# coletor reescreve, e não numa variável de ambiente, que é fixa.

DIRETORIO_DO_LOGIN = "/root/.config/coletor-openclaw/claude"
URL_DO_USO = "https://api.anthropic.com/api/oauth/usage"
URL_DA_RENOVACAO = "https://platform.claude.com/v1/oauth/token"
# Cliente público do próprio Claude Code (o mesmo do login que gerou o arquivo).
CLIENT_ID_DO_CLAUDE_CODE = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
# Renova com folga: um token que vence no meio da leitura daria 401 à toa.
MARGEM_DA_RENOVACAO_MS = 10 * 60 * 1000
ULTIMA_RENOVACAO = {}
JANELAS_CONHECIDAS = ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps")
CHAVE_VALIDA = re.compile(r"^[\w:.-]{1,60}$")


def _json_http(url, metodo="GET", corpo=None, cabecalhos=None, tempo=30):
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(url, data=dados, method=metodo, headers=cabecalhos or {})
    try:
        with urllib.request.urlopen(req, timeout=tempo) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as erro:
        try:
            return erro.code, json.loads(erro.read().decode("utf-8") or "{}")
        except ValueError:
            return erro.code, {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as erro:
        return 0, {"erro": str(erro)}


def _gravar_credencial(caminho, dados):
    """Reescreve o arquivo do login sem nunca deixá-lo pela metade: cópia, temporário, troca atômica."""
    if os.path.exists(caminho):
        copia = caminho + ".bak"
        with open(caminho, "rb") as origem, open(copia, "wb") as destino:
            destino.write(origem.read())
        os.chmod(copia, 0o600)
    temporario = caminho + ".novo"
    with open(temporario, "w", encoding="utf-8") as saida:
        json.dump(dados, saida)
    os.chmod(temporario, 0o600)
    os.replace(temporario, caminho)


def _renovar(caminho, dados, avisos):
    """Troca o refresh token por um acesso novo e guarda o par novo. `None` se não deu."""
    oauth = dados.get("claudeAiOauth") or {}
    refresh = oauth.get("refreshToken")
    if not refresh:
        avisos.append("cota real: o login não tem refresh token; refaça com coletor-cota-login")
        return None
    status, resposta = _json_http(
        URL_DA_RENOVACAO,
        "POST",
        {"grant_type": "refresh_token", "refresh_token": refresh, "client_id": CLIENT_ID_DO_CLAUDE_CODE},
        {"Content-Type": "application/json", "User-Agent": "claude-code/2.1"},
    )
    acesso = resposta.get("access_token") if isinstance(resposta, dict) else None
    if status != 200 or not acesso:
        avisos.append(f"cota real: a renovação do login falhou (HTTP {status}); refaça com coletor-cota-login")
        return None
    oauth["accessToken"] = acesso
    # A Anthropic gira o refresh token; se vier um novo, é ele que vale a partir de agora.
    if resposta.get("refresh_token"):
        oauth["refreshToken"] = resposta["refresh_token"]
    if isinstance(resposta.get("expires_in"), (int, float)):
        oauth["expiresAt"] = int(time.time() * 1000 + resposta["expires_in"] * 1000)
    # A validade do próprio refresh token, quando a resposta a informa (o nome varia).
    for chave, valor in resposta.items():
        if "refresh" in chave and "expires" in chave and isinstance(valor, (int, float)) and not isinstance(valor, bool):
            if chave.endswith("_in"):
                oauth["refreshTokenExpiresAt"] = int(time.time() * 1000 + valor * 1000)
            else:
                oauth["refreshTokenExpiresAt"] = int(valor * 1000 if valor < 1e12 else valor)
    # Só os NOMES dos campos, para diagnóstico (`--renovar-agora`): nunca os valores.
    ULTIMA_RENOVACAO["campos"] = sorted(resposta.keys())
    dados["claudeAiOauth"] = oauth
    _gravar_credencial(caminho, dados)
    return acesso


def _janelas_da_resposta(corpo):
    """Aceita o corpo cru do endpoint e o embrulhado em `rate_limits`. Devolve só o que tem percentual."""
    limites = corpo.get("rate_limits") if isinstance(corpo.get("rate_limits"), dict) else corpo
    janelas = []

    def acrescentar(chave, bruto):
        if not isinstance(bruto, dict) or not CHAVE_VALIDA.match(chave):
            return
        uso = bruto.get("utilization")
        if isinstance(uso, bool) or not isinstance(uso, (int, float)):
            return
        reseta = None
        if isinstance(bruto.get("resets_at"), str) and bruto["resets_at"]:
            try:
                # A Anthropic informa o reset com décimos ANTES da hora (18:59:59,6): vale o segundo mais próximo.
                reseta = iso(datetime.datetime.fromtimestamp(round(analisar_data(bruto["resets_at"]).timestamp()), datetime.timezone.utc))
            except ValueError:
                reseta = None
        janelas.append({"chave": chave, "utilizacao": float(uso), "resetaEm": reseta})

    for chave in JANELAS_CONHECIDAS:
        acrescentar(chave, limites.get(chave))
    escopadas = limites.get("model_scoped")
    if isinstance(escopadas, list):
        for entrada in escopadas:
            nome = entrada.get("display_name") if isinstance(entrada, dict) else None
            if isinstance(nome, str) and nome.strip():
                acrescentar("model:" + re.sub(r"[^\w.-]+", "-", nome.strip().lower()), entrada)
    return janelas


def ler_cota(avisos, diretorio=DIRETORIO_DO_LOGIN):
    """A cota real da conta, ou `None` (sem login, login vencido ou a Anthropic não respondeu)."""
    caminho = os.path.join(diretorio, ".credentials.json")
    if not os.path.exists(caminho):
        return None  # sem o login da conta: a tela segue na cota estimada, sem reclamar

    try:
        import fcntl

        trava = open(os.path.join(diretorio, ".trava"), "w")
        fcntl.flock(trava, fcntl.LOCK_EX | fcntl.LOCK_NB)  # duas rodadas ao mesmo tempo girariam o token em dobro
    except (ImportError, OSError):
        avisos.append("cota real: outra rodada está lendo a cota; pulei")
        return None

    try:
        with open(caminho, encoding="utf-8") as f:
            dados = json.load(f)
        oauth = dados.get("claudeAiOauth") or {}
        acesso = oauth.get("accessToken")
        vence = oauth.get("expiresAt")
        if not acesso:
            avisos.append("cota real: o arquivo do login não tem token; refaça com coletor-cota-login")
            return None
        if isinstance(vence, (int, float)) and vence - time.time() * 1000 < MARGEM_DA_RENOVACAO_MS:
            acesso = _renovar(caminho, dados, avisos)
            if not acesso:
                return None

        cabecalhos = {
            "Authorization": f"Bearer {acesso}",
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
            "User-Agent": "claude-code/2.1",
        }
        status, corpo = _json_http(URL_DO_USO, "GET", None, cabecalhos)
        if status == 401:
            acesso = _renovar(caminho, dados, avisos)
            if not acesso:
                return None
            cabecalhos["Authorization"] = f"Bearer {acesso}"
            status, corpo = _json_http(URL_DO_USO, "GET", None, cabecalhos)
        if status != 200 or not isinstance(corpo, dict):
            avisos.append(f"cota real: a leitura de uso falhou (HTTP {status})")
            return None

        janelas = _janelas_da_resposta(corpo)
        if not janelas:
            avisos.append("cota real: a resposta não trouxe nenhuma janela com percentual")
            return None
        plano = corpo.get("subscription_type") or oauth.get("subscriptionType")
        return {
            "lidaEm": iso(agora_utc()),
            "plano": str(plano)[:40] if plano else None,
            "janelas": janelas,
        }
    except (OSError, ValueError) as erro:
        avisos.append(f"cota real: {erro}")
        return None
    finally:
        trava.close()


def montar_lote(desde, ate, conteineres, uso, limites):
    return {
        "desde": iso(desde),
        "ate": iso(ate),
        "conteineres": conteineres,
        "uso": [
            {
                "hora": h,
                "conteiner": c,
                "agente": ag,
                "tipo": tp,
                "modelo": md,
                "chamadas": v[0],
                "entrada": v[1],
                "saida": v[2],
                "cacheLeitura": v[3],
                "cacheEscrita": v[4],
            }
            for (h, c, ag, tp, md), v in sorted(uso.items())
        ],
        "limites": [
            {"hora": h, "conteiner": c, "categoria": cat, "quantidade": n}
            for (h, c, cat), n in sorted(limites.items())
            if n > 0
        ],
    }


def enviar(url, token, lote):
    corpo = json.dumps(lote, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=corpo,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as erro:
        detalhe = erro.read().decode("utf-8", "replace")[:300]
        return erro.code, {"erro": detalhe}
    except (urllib.error.URLError, TimeoutError, OSError) as erro:
        return 0, {"erro": str(erro)}


def partir_em_lotes(lote):
    """Divide um lote com linhas demais, sempre em fronteira de hora."""
    if len(lote["uso"]) <= LINHAS_POR_LOTE and len(lote["limites"]) <= LINHAS_POR_LOTE:
        return [lote]
    desde, ate = analisar_data(lote["desde"]), analisar_data(lote["ate"])
    meio = inicio_da_hora(desde + (ate - desde) / 2)
    if meio <= desde or meio >= ate:
        raise SystemExit("lote com linhas demais numa janela de uma hora só")
    divide = lambda linhas, a, b: [l for l in linhas if a <= analisar_data(l["hora"]) < b]
    esquerda = dict(lote, ate=iso(meio), uso=divide(lote["uso"], desde, meio), limites=divide(lote["limites"], desde, meio))
    direita = dict(lote, desde=iso(meio), uso=divide(lote["uso"], meio, ate), limites=divide(lote["limites"], meio, ate))
    return partir_em_lotes(esquerda) + partir_em_lotes(direita)


def main():
    ap = argparse.ArgumentParser(description="Envia o consumo dos OpenClaws para o painel.")
    ap.add_argument("--horas", type=int, default=8, help="janela, em horas para trás (padrão 8)")
    ap.add_argument("--tudo", action="store_true", help="o histórico inteiro (carga inicial)")
    ap.add_argument("--dry-run", action="store_true", help="mostra o que enviaria, sem enviar")
    ap.add_argument("--salvar-em", default=None, help="grava os lotes (JSON) neste arquivo em vez de enviar; serve para conferir ou testar")
    ap.add_argument("--pasta", default=PASTA_PADRAO)
    ap.add_argument("--ignorar", default=os.environ.get("COLETOR_IGNORAR", ""), help="ids de contêiner, separados por vírgula")
    ap.add_argument("--url", default=None)
    ap.add_argument("--arquivo-do-token", default=ARQUIVO_DO_TOKEN)
    ap.add_argument("--sem-cota", action="store_true", help="não lê a cota real, mesmo com o login da conta feito")
    ap.add_argument("--ver-cota", action="store_true", help="só lê e mostra a cota real da conta; não lê nem envia o consumo")
    ap.add_argument("--diretorio-do-login", default=DIRETORIO_DO_LOGIN)
    ap.add_argument("--renovar-agora", action="store_true", help="força a renovação do login da cota (teste e manutenção); mostra só os nomes dos campos da resposta")
    args = ap.parse_args()

    t0 = time.time()

    if args.renovar_agora:
        caminho = os.path.join(args.diretorio_do_login, ".credentials.json")
        avisos = []
        try:
            with open(caminho, encoding="utf-8") as f:
                dados = json.load(f)
        except (OSError, ValueError) as erro:
            print(f"login não lido: {erro}", file=sys.stderr)
            return 1
        acesso = _renovar(caminho, dados, avisos)
        for a in avisos:
            print(f"aviso: {a}", file=sys.stderr)
        if not acesso:
            print("a renovação FALHOU; o arquivo do login não foi alterado")
            return 1
        oauth = dados.get("claudeAiOauth") or {}
        agora_ms = time.time() * 1000
        print("renovado. campos da resposta:", ", ".join(ULTIMA_RENOVACAO.get("campos", [])))
        print("acesso vale mais %.1f h" % ((oauth.get("expiresAt", 0) - agora_ms) / 3600000))
        r = oauth.get("refreshTokenExpiresAt")
        if isinstance(r, (int, float)):
            print("refresh token vence em %.1f dias" % ((r - agora_ms) / 86400000))
        return 0

    if args.ver_cota:
        avisos = []
        cota = ler_cota(avisos, args.diretorio_do_login)
        for a in avisos:
            print(f"aviso: {a}", file=sys.stderr)
        if not cota:
            print("sem leitura da cota real (login da conta ausente, vencido ou sem resposta)")
            return 1
        print(f"lida em {cota['lidaEm']}, plano {cota['plano']}")
        for j in cota["janelas"]:
            print(f"  {j['chave']}: {j['utilizacao']:g}% — recomeça {j['resetaEm']}")
        return 0

    ignorar = {i.strip() for i in args.ignorar.split(",") if i.strip()}
    conteineres = sorted(
        c
        for c in (os.path.basename(p)[len("openclaw-"):] for p in glob.glob(f"{args.pasta}/openclaw-*"))
        if ID_DO_CONTEINER.match(c) and c not in ignorar
    )
    if not conteineres:
        print("nenhum contêiner encontrado", file=sys.stderr)
        return 1

    ate = inicio_da_hora(agora_utc()) + HORA
    desde = (
        datetime.datetime(2026, 7, 1, tzinfo=datetime.timezone.utc)
        if args.tudo
        else inicio_da_hora(agora_utc()) - datetime.timedelta(hours=max(1, args.horas))
    )

    url = args.url
    if not url and os.path.exists(ARQUIVO_DA_URL):
        url = open(ARQUIVO_DA_URL, encoding="utf-8").read().strip()
    url = url or URL_PADRAO

    token = None
    if not args.dry_run and not args.salvar_em:
        try:
            token = open(args.arquivo_do_token, encoding="utf-8").read().strip()
        except OSError as erro:
            print(f"token não lido ({erro})", file=sys.stderr)
            return 1

    # A janela é lida em pedaços de DIAS_POR_LOTE dias: o painel recusa mais que isso por lote.
    janelas = []
    inicio = desde
    while inicio < ate:
        fim = min(inicio + datetime.timedelta(days=DIAS_POR_LOTE), ate)
        janelas.append((inicio, fim))
        inicio = fim

    falhas, falhou_envio, enviados, guardados = [], False, 0, []

    # A cota real vai SÓ no último lote (o que cobre agora). Sem o login da conta,
    # ou com ele vencido, o lote segue sem ela e o painel fica na cota estimada.
    cota = None if args.sem_cota else ler_cota(falhas, args.diretorio_do_login)

    for (a, b) in janelas:
        vistos, uso, limites = set(), collections.defaultdict(lambda: [0, 0, 0, 0, 0]), collections.defaultdict(int)
        for c in conteineres:
            ler_conteiner(args.pasta, c, a, b, vistos, uso, limites, falhas)

        # Logs do gateway só existem para os dias recentes; o resto do histórico vem da transcrição.
        dia = a.date()
        while dia <= (b - datetime.timedelta(seconds=1)).date():
            if (agora_utc().date() - dia).days <= 3:
                for c in conteineres:
                    recusas_do_log(c, dia.isoformat(), a, b, limites, falhas)
            dia += datetime.timedelta(days=1)

        lote = montar_lote(a, b, conteineres, uso, limites)
        partes = partir_em_lotes(lote)
        if cota and b == ate:
            partes[-1]["cota"] = cota
        for parte in partes:
            resumo = (
                f"{parte['desde']} -> {parte['ate']}: {len(parte['uso'])} linhas de uso, {len(parte['limites'])} de recusa"
                + (f", cota real de {len(parte['cota']['janelas'])} janela(s)" if parte.get("cota") else "")
            )
            if args.dry_run or args.salvar_em:
                print(f"[sem envio] {resumo}")
                guardados.append(parte)
                continue
            status, resposta = enviar(url, token, parte)
            if status == 200:
                enviados += 1
                print(f"enviado: {resumo}")
            else:
                falhou_envio = True
                print(f"FALHOU ({status}): {resumo} — {resposta.get('erro', resposta)}", file=sys.stderr)

    if args.salvar_em:
        with open(args.salvar_em, "w", encoding="utf-8") as saida:
            json.dump(guardados, saida, separators=(",", ":"))
        os.chmod(args.salvar_em, 0o600)

    for f in falhas[:20]:
        print(f"aviso: {f}", file=sys.stderr)
    print(f"{len(conteineres)} contêineres, {enviados} lote(s) em {time.time() - t0:.1f}s")
    return 1 if falhou_envio else 0


if __name__ == "__main__":
    sys.exit(main())
