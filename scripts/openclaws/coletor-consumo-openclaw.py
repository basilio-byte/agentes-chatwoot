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
    args = ap.parse_args()

    t0 = time.time()
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
        for parte in partir_em_lotes(lote):
            resumo = f"{parte['desde']} -> {parte['ate']}: {len(parte['uso'])} linhas de uso, {len(parte['limites'])} de recusa"
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
