import { diaEmSaoPaulo } from "@/lib/tempo";

import {
  DIAS_EM_RENOVACAO,
  STATUS_NOTIFICACAO,
  STATUS_RENOVACAO,
  deveNotificar,
} from "./regras";

/**
 * Fase 2b: de `renovação` para `notificação renovação`, sozinho, depois de
 * `DIAS_EM_RENOVACAO` dias. Hoje é o Felipe quem faz esse passo, tarefa por
 * tarefa (pedido da equipe em 10/11/2026).
 *
 * ⚠⚠ **Esta troca de status não é arrumação: é a notificação em si.** As
 * automações do ClickUp mandam o e-mail de aviso do reajuste AO CLIENTE
 * exatamente na passagem `renovação` → `notificação renovação` (a 3 para quem
 * não é sala privativa, a 4 e a 5 para ONE). Por isso a chave nasce desligada e
 * cada guarda aqui existe para um e-mail que não deve sair.
 *
 * Os dois dias são a janela em que a equipe ainda pode intervir (cliente em
 * negociação, saindo, com pendência): é o que o sistema respeita, e é por isso
 * que a contagem vem do ClickUp (`tempo-no-status.ts`) e não do relógio do
 * nosso retrato.
 */

export type TarefaParaNotificar = {
  id: string;
  status: string;
  /** Milissegundos em que a tarefa entrou no status de agora, lido do ClickUp. */
  entrouEmMs: number | null;
  /** `DATA DE REAJUSTE`, `AAAA-MM-DD`. */
  dataDeReajuste: string | null;
  /** `CATEGORIA DE SERVIÇO`, pelo nome da opção. */
  categoria: string | null;
  /** `TIPO DE PRODUTO`, pelo nome da opção. */
  produto: string | null;
};

export type DecisaoDeNotificacao =
  | { mover: true; entrouEm: string; dias: number }
  /** `espera: true` é o caso normal (ainda não deu o tempo) e não é pendência. */
  | { mover: false; espera: boolean; motivo: string };

function simples(texto: string | null | undefined) {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Sala privativa fica com a equipe: a automação 3 NÃO manda e-mail para ela
 * (condição "CATEGORIA ≠ Salas privativas") e a 7 aplica um modelo de
 * checklist para quem atende conversar com o cliente DURANTE a renovação. Mover
 * sozinho pularia essa conversa.
 */
export function ehSalaPrivativa(t: Pick<TarefaParaNotificar, "categoria" | "produto">) {
  return (
    simples(t.categoria).includes("salas privativas") ||
    simples(t.produto).includes("sala privativa")
  );
}

export function diasEntre(de: string, ate: string) {
  const [a1, m1, d1] = de.split("-").map(Number);
  const [a2, m2, d2] = ate.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

/**
 * Mover esta tarefa agora?
 *
 * Na dúvida, não: tarefa sem data, ou com a data já vencida, é caso para uma
 * pessoa — avisar um cliente do reajuste de uma renovação que já passou é pior
 * do que esperar.
 */
export function decidirNotificacao(
  tarefa: TarefaParaNotificar,
  hoje: string,
): DecisaoDeNotificacao {
  if (simples(tarefa.status) !== simples(STATUS_RENOVACAO)) {
    return {
      mover: false,
      espera: false,
      motivo: `a tarefa está em "${tarefa.status}", não em "${STATUS_RENOVACAO}"`,
    };
  }

  if (ehSalaPrivativa(tarefa)) {
    return {
      mover: false,
      espera: false,
      motivo:
        "sala privativa: a equipe conversa com o cliente durante a renovação, e a notificação automática não vale para ela",
    };
  }

  if (tarefa.entrouEmMs == null) {
    return {
      mover: false,
      espera: false,
      motivo: "não consegui ler desde quando a tarefa está em renovação",
    };
  }
  const entrouEm = diaEmSaoPaulo(new Date(tarefa.entrouEmMs));

  if (!deveNotificar(entrouEm, hoje)) {
    const dias = diasEntre(entrouEm, hoje);
    return {
      mover: false,
      espera: true,
      motivo: `${dias} dia(s) em renovação; espera ${DIAS_EM_RENOVACAO}`,
    };
  }

  if (!tarefa.dataDeReajuste) {
    return {
      mover: false,
      espera: false,
      motivo: "sem DATA DE REAJUSTE: sem ela não dá para saber se o aviso ainda faz sentido",
    };
  }
  if (tarefa.dataDeReajuste < hoje) {
    return {
      mover: false,
      espera: false,
      motivo: `a DATA DE REAJUSTE (${tarefa.dataDeReajuste}) já passou — caso para uma pessoa olhar`,
    };
  }

  return { mover: true, entrouEm, dias: diasEntre(entrouEm, hoje) };
}

/** A chave da reserva: uma entrada no status, uma notificação. */
export function chaveDaNotificacao(tarefaId: string, entrouEmMs: number) {
  return `notificar:${tarefaId}:${entrouEmMs}`;
}

function dia(iso: string) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/** O comentário que fica na tarefa: diz o que o sistema fez e por quê. */
export function comentarioDaNotificacao(entrouEm: string, dias: number) {
  return [
    `🔔 **Movida pelo sistema para "${STATUS_NOTIFICACAO}"** — estava em "${STATUS_RENOVACAO}" desde ${dia(entrouEm)} (${dias} dia(s)).`,
    "",
    "É nesta passagem que a automação do ClickUp manda o e-mail de aviso do reajuste ao cliente.",
    "",
    "_Lançado pelo sistema de agentes. Se esta tarefa não devia ser notificada, volte-a para o status anterior e avise quem cuida da renovação._",
  ].join("\n");
}
