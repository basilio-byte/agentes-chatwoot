import { db } from "@/lib/db";
import type { RunSource } from "@/generated/prisma/enums";
import {
  paraFerramentasOpenAI,
  resolverToolsDoAgente,
  type ToolResolvida,
} from "@/server/integrations/resolve";
import { obterModelo, type ModeloCatalogo } from "./catalogo";
import { blocoDeRoster, montarRoster } from "./equipe";
import {
  blocoDeConduta,
  podeEncaminharParaHumano,
  tipoDeTurno,
} from "./conduta";
import { semFerramentasDeCanal } from "./chamada-interna";

/**
 * O que o modelo recebe antes da primeira mensagem: ferramentas e system prompt.
 *
 * Saiu de `runner.ts` para ter DOIS leitores com uma conta só — o turno de
 * verdade e o MCP, que mostra a um assistente o prompt exatamente como o agente
 * o recebe. Recompor o prompt noutro lugar com as mesmas peças seria o jeito de
 * o assistente afirmar uma ordem ou uma linha de encaminhamento que o runner
 * não usa — e reescrever um prompt contra uma regra que não existe.
 */

export type AgenteDoContexto = {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  handoffEnabled: boolean;
};

export type ContextoDoTurno = {
  resolvidas: Map<string, ToolResolvida>;
  ferramentas: ReturnType<typeof paraFerramentasOpenAI>;
  modelo: ModeloCatalogo | null;
  /** Falso com ferramentas ligadas quando o modelo não aceita tools. */
  enviarFerramentas: boolean;
  /** As três partes do system prompt, na ordem em que são concatenadas. */
  partes: { operador: string; conduta: string; colegas: string };
  systemPrompt: string;
};

export async function prepararContexto(
  agente: AgenteDoContexto,
  source: RunSource,
  inboxId?: number | null,
): Promise<ContextoDoTurno> {
  const tipo = tipoDeTurno(source);

  // Chamada interna, conversa encerrada e conversa marcada: sem ferramenta que
  // fale com o cliente ou passe a conversa de mãos. Quem roda em segundo plano
  // não é dono do atendimento — ver `chamada-interna.ts` —, numa conversa
  // resolvida não há atendimento para passar, e na marcada ele está com a
  // pessoa que marcou o checkbox.
  const emSegundoPlano =
    tipo === "interno" || tipo === "encerrada" || tipo === "marcada";
  const todas = await resolverToolsDoAgente(agente.id);
  const resolvidas = emSegundoPlano ? semFerramentasDeCanal(todas) : todas;
  const ferramentas = paraFerramentasOpenAI(resolvidas);
  const modelo = await obterModelo(agente.model);
  const enviarFerramentas =
    ferramentas.length > 0 && (modelo?.suportaTools ?? true);

  // O roster vai DENTRO do system prompt porque é estável entre requisições:
  // só muda quando alguém mexe na equipe. Se fosse mensagem, ocuparia posição
  // depois do histórico sem ganho nenhum de cache.
  //
  // Na chamada interna e na conversa encerrada ele não vai: sem ferramenta de
  // transferência, oferecer colegas seria convite a queimar uma etapa numa tool
  // que ele não tem.
  const roster =
    emSegundoPlano
      ? []
      : montarRoster(
          await db.agent.findMany({
            // Arquivado não entra na equipe: não roteia, não recebe
            // transferência e não aparece no prompt de ninguém.
            where: { archivedAt: null },
            select: {
              id: true,
              key: true,
              name: true,
              routingDescription: true,
              active: true,
              isEntry: true,
              inboxMode: true,
              inboxIds: true,
            },
          }),
          agente.id,
          inboxId,
        );

  // Ordem: PROMPT DO OPERADOR → REGRAS DA CASA → COLEGAS.
  //
  // As Regras da Casa vêm DEPOIS do prompt do operador porque dizem "as
  // instruções acima" — é essa dêixis que faz as regras de escopo e de
  // fonte-de-verdade funcionarem, já que as duas se definem por exclusão do
  // que o operador escreveu. E vêm ANTES do roster porque, depois dele, "as
  // instruções acima" passaria a incluir a lista de colegas, autorizando o
  // agente a tratar o assunto dos outros como se fosse escopo dele.
  const conduta = blocoDeConduta({
    tipo,
    // Fato do turno, não preferência: sem como entregar a conversa a uma
    // pessoa, o bloco não manda o agente prometer que vai passar. Conta
    // também `enviarFerramentas` — modelo sem suporte a tools zera o envio
    // com a allowlist intacta, e prometer transferência sem ferramenta
    // nenhuma no request é o sintoma que este bloco combate.
    podeEncaminhar: podeEncaminharParaHumano({
      handoffEnabled: agente.handoffEnabled,
      temToolDeHandoff: resolvidas.has("transferir_para_humano"),
      ferramentasVaoNoRequest: enviarFerramentas,
    }),
  });
  const colegas = blocoDeRoster(roster, agente.name);

  return {
    resolvidas,
    ferramentas,
    modelo,
    enviarFerramentas,
    partes: { operador: agente.systemPrompt, conduta, colegas },
    systemPrompt: agente.systemPrompt + conduta + colegas,
  };
}
