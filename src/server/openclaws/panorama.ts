import type { PontoDoDia } from "@/server/consumo/agregacao";
import {
  serieDiaria,
  totalizar,
  totalizarPor,
  usdPorHora,
  type LinhaDeLimite,
  type LinhaDeUso,
  type Totais,
} from "./agregacao";
import { detectarBloqueios, horasBloqueadasEntre, type Bloqueio } from "./bloqueios";
import { amostrasDeCota, estimarCota } from "./calibragem";
import { ciclosRecentes, fimDoCiclo, inicioDoCiclo, type Ciclo, type Reset } from "./ciclo";
import {
  idsDaContaCompartilhada,
  nomeDoConteiner,
  type ConteinerConfigurado,
} from "./config";
import { normalizarModelo } from "./precos";

/**
 * Tudo que a tela `/openclaws` mostra, calculado de uma vez e SEM tocar em
 * banco — para dar para testar com a história real de outubro/2026 inteira.
 *
 * Duas escalas de tempo convivem de propósito. O **ciclo semanal** (o que a
 * cota mede) responde "quanto da semana já foi"; o **período** do filtro
 * responde "quanto cada um usou nesse intervalo". Misturar as duas faria o
 * percentual da cota mudar quando alguém troca o filtro para "30 dias".
 */

export type EntradaDoPanorama = {
  agora: Date;
  linhas: readonly LinhaDeUso[];
  limites: readonly LinhaDeLimite[];
  conteineres: readonly ConteinerConfigurado[];
  reset: Reset;
  /** Cota informada à mão, em US$ equivalentes. Vence a estimada. */
  cotaManualUsd: number | null;
  /** Recorte do filtro da tela. `null` numa ponta = sem limite. */
  periodo: { inicio: Date | null; fim: Date | null };
  /** Os dias civis (São Paulo) do período, para o gráfico não pular dia. */
  dias: readonly string[];
  /** Quantos ciclos a tabela de histórico mostra. */
  quantosCiclos?: number;
};

export type Cota = {
  /** Nula quando ainda não houve bloqueio para medir e ninguém informou. */
  usd: number | null;
  origem: "manual" | "estimada" | "nenhuma";
  minimo: number | null;
  maximo: number | null;
  /** Quantos bloqueios entraram na estimativa. */
  amostras: number;
  /** De onde veio cada número, para a tela mostrar a conta e não só o resultado. */
  detalhe: {
    cicloInicio: Date;
    bloqueioInicio: Date;
    usd: number;
    /** Ficou de fora da média por parecer ciclo incompleto. */
    descartada: boolean;
  }[];
};

export type AgenteNoPanorama = {
  agente: string;
  ciclo: Totais;
  periodo: Totais;
};

export type PessoaNoPanorama = {
  conteiner: string;
  nome: string;
  /** Gasta da conta compartilhada? Falso = credencial própria, fora da cota dos demais. */
  compartilhada: boolean;
  ciclo: Totais;
  periodo: Totais;
  /** Fração da COTA que esta pessoa gastou no ciclo. Nulo sem cota ou fora da conta. */
  fracaoDaCota: number | null;
  /** Fração do que a conta gastou no ciclo. Nulo fora da conta ou sem gasto. */
  parteDoCiclo: number | null;
  agentes: AgenteNoPanorama[];
};

export type CicloNoHistorico = Ciclo & {
  atual: boolean;
  /** Só a conta compartilhada. */
  totais: Totais;
  fracaoDaCota: number | null;
  horasBloqueadas: number;
  porPessoa: { conteiner: string; nome: string; compartilhada: boolean; usd: number }[];
};

export type Projecao = {
  /** Gasto por hora no ciclo até agora. */
  usdPorHora: number;
  /** Quando a cota acaba, se o ritmo se mantiver e isso acontecer antes do reset. */
  acabaEm: Date | null;
};

export type Panorama = {
  agora: Date;
  cicloAtual: Ciclo;
  proximoReset: Date;
  cota: Cota;
  /** O ciclo atual, só da conta compartilhada. */
  doCiclo: { totais: Totais; fracaoDaCota: number | null };
  projecao: Projecao | null;
  bloqueadoAgora: boolean;
  bloqueios: Bloqueio[];
  pessoas: PessoaNoPanorama[];
  porModelo: { modelo: string; totais: Totais }[];
  porTipo: { tipo: string; totais: Totais }[];
  serieDiaria: PontoDoDia[];
  historico: CicloNoHistorico[];
  /** Chamadas do período que ficaram fora do custo (modelo sem tarifa ou de outra fatura). */
  foraDoCusto: { semTarifa: number; foraDaConta: number };
};

/** Antes disto o ritmo da semana ainda é ruído: um heartbeat vira "vai estourar". */
const HORAS_MINIMAS_PARA_PROJETAR = 12;

const HORA_MS = 3_600_000;

const porUsdDecrescente = (a: Totais, b: Totais) =>
  b.usd - a.usd || b.chamadas - a.chamadas;

export function montarPanorama(e: EntradaDoPanorama): Panorama {
  const { agora, linhas, limites, conteineres, reset } = e;

  const ids = new Set<string>([
    ...conteineres.map((c) => c.id),
    ...linhas.map((l) => l.conteiner),
    ...limites.map((l) => l.conteiner),
  ]);
  const compartilhados = idsDaContaCompartilhada(conteineres, ids);

  // --- A cota: medida pelos bloqueios da conta compartilhada ----------------
  const daConta = linhas.filter((l) => compartilhados.has(l.conteiner));
  const bloqueios = detectarBloqueios(limites, agora, compartilhados);
  const amostras = amostrasDeCota(bloqueios, usdPorHora(daConta), reset);
  const estimativa = estimarCota(amostras);
  const detalhe = amostras.map((a) => ({
    cicloInicio: a.cicloInicio,
    bloqueioInicio: a.bloqueioInicio,
    usd: a.usd,
    descartada: !estimativa || estimativa.descartadas.includes(a),
  }));

  const cota: Cota =
    e.cotaManualUsd != null && e.cotaManualUsd > 0
      ? {
          usd: e.cotaManualUsd,
          origem: "manual",
          minimo: null,
          maximo: null,
          amostras: 0,
          detalhe,
        }
      : estimativa
        ? {
            usd: estimativa.usd,
            origem: "estimada",
            minimo: estimativa.minimo,
            maximo: estimativa.maximo,
            amostras: estimativa.amostras.length,
            detalhe,
          }
        : { usd: null, origem: "nenhuma", minimo: null, maximo: null, amostras: 0, detalhe };

  const fracaoDe = (usd: number) => (cota.usd ? usd / cota.usd : null);

  // --- O ciclo em curso ------------------------------------------------------
  const inicio = inicioDoCiclo(agora, reset);
  const cicloAtual: Ciclo = { inicio, fim: fimDoCiclo(inicio) };
  const noCiclo = (l: LinhaDeUso) =>
    l.hora.getTime() >= cicloAtual.inicio.getTime() &&
    l.hora.getTime() < cicloAtual.fim.getTime();

  const noPeriodo = (l: LinhaDeUso) =>
    (e.periodo.inicio === null || l.hora.getTime() >= e.periodo.inicio.getTime()) &&
    (e.periodo.fim === null || l.hora.getTime() < e.periodo.fim.getTime());

  const doCicloCompartilhado = totalizar(daConta.filter(noCiclo));

  const horasDecorridas = (agora.getTime() - cicloAtual.inicio.getTime()) / HORA_MS;
  let projecao: Projecao | null = null;
  if (horasDecorridas >= HORAS_MINIMAS_PARA_PROJETAR && doCicloCompartilhado.usd > 0) {
    const porHora = doCicloCompartilhado.usd / horasDecorridas;
    let acabaEm: Date | null = null;
    if (cota.usd && doCicloCompartilhado.usd < cota.usd) {
      const horasAteAcabar = (cota.usd - doCicloCompartilhado.usd) / porHora;
      const quando = new Date(agora.getTime() + horasAteAcabar * HORA_MS);
      if (quando.getTime() < cicloAtual.fim.getTime()) acabaEm = quando;
    }
    projecao = { usdPorHora: porHora, acabaEm };
  }

  // --- Por pessoa -------------------------------------------------------------
  const doPeriodo = linhas.filter(noPeriodo);
  const pessoas: PessoaNoPanorama[] = [...ids].map((id) => {
    const dele = linhas.filter((l) => l.conteiner === id);
    const compartilhada = compartilhados.has(id);
    const ciclo = totalizar(dele.filter(noCiclo));
    const periodo = totalizar(dele.filter(noPeriodo));

    const nomesDosAgentes = [...new Set(dele.filter((l) => noCiclo(l) || noPeriodo(l)).map((l) => l.agente))];
    const agentes = nomesDosAgentes
      .map((agente) => {
        const doAgente = dele.filter((l) => l.agente === agente);
        return {
          agente,
          ciclo: totalizar(doAgente.filter(noCiclo)),
          periodo: totalizar(doAgente.filter(noPeriodo)),
        };
      })
      .sort((a, b) => porUsdDecrescente(a.ciclo, b.ciclo) || porUsdDecrescente(a.periodo, b.periodo));

    return {
      conteiner: id,
      nome: nomeDoConteiner(id, conteineres),
      compartilhada,
      ciclo,
      periodo,
      fracaoDaCota: compartilhada ? fracaoDe(ciclo.usd) : null,
      parteDoCiclo:
        compartilhada && doCicloCompartilhado.usd > 0
          ? ciclo.usd / doCicloCompartilhado.usd
          : null,
      agentes,
    };
  });

  // Quem divide a conta primeiro, do maior gasto do ciclo para o menor; quem tem
  // credencial própria vem depois, separado.
  pessoas.sort(
    (a, b) =>
      Number(b.compartilhada) - Number(a.compartilhada) ||
      porUsdDecrescente(a.ciclo, b.ciclo) ||
      porUsdDecrescente(a.periodo, b.periodo) ||
      a.nome.localeCompare(b.nome, "pt-BR"),
  );

  // --- Cortes do período ------------------------------------------------------
  const porModelo = [...totalizarPor(doPeriodo, (l) => normalizarModelo(l.modelo)).entries()]
    .map(([modelo, totais]) => ({ modelo, totais }))
    .sort((a, b) => porUsdDecrescente(a.totais, b.totais));
  const porTipo = [...totalizarPor(doPeriodo, (l) => l.tipo).entries()]
    .map(([tipo, totais]) => ({ tipo, totais }))
    .sort((a, b) => porUsdDecrescente(a.totais, b.totais));
  const doPeriodoTotal = totalizar(doPeriodo);

  // --- Histórico de ciclos -----------------------------------------------------
  const historico: CicloNoHistorico[] = ciclosRecentes(agora, reset, e.quantosCiclos ?? 8).map(
    (ciclo, i) => {
      const dentro = (l: LinhaDeUso) =>
        l.hora.getTime() >= ciclo.inicio.getTime() && l.hora.getTime() < ciclo.fim.getTime();
      const doCiclo = linhas.filter(dentro);
      const totais = totalizar(doCiclo.filter((l) => compartilhados.has(l.conteiner)));
      const porPessoa = [...ids]
        .map((id) => ({
          conteiner: id,
          nome: nomeDoConteiner(id, conteineres),
          compartilhada: compartilhados.has(id),
          usd: totalizar(doCiclo.filter((l) => l.conteiner === id)).usd,
        }))
        .filter((p) => p.usd > 0)
        .sort((a, b) => b.usd - a.usd);

      return {
        ...ciclo,
        atual: i === 0,
        totais,
        fracaoDaCota: fracaoDe(totais.usd),
        horasBloqueadas: horasBloqueadasEntre(
          bloqueios,
          ciclo.inicio,
          new Date(Math.min(ciclo.fim.getTime(), agora.getTime())),
        ),
        porPessoa,
      };
    },
  );

  return {
    agora,
    cicloAtual,
    proximoReset: cicloAtual.fim,
    cota,
    doCiclo: {
      totais: doCicloCompartilhado,
      fracaoDaCota: fracaoDe(doCicloCompartilhado.usd),
    },
    projecao,
    bloqueadoAgora: bloqueios[0]?.emCurso ?? false,
    bloqueios,
    pessoas,
    porModelo,
    porTipo,
    serieDiaria: serieDiaria(doPeriodo, e.dias),
    historico,
    foraDoCusto: {
      semTarifa: doPeriodoTotal.chamadasSemTarifa,
      foraDaConta: doPeriodoTotal.chamadasForaDaConta,
    },
  };
}
