import { logger } from "@/lib/logger";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { abrirClickUp, type ClickUpDoSistema } from "@/server/integrations/clickup/sistema";
import { mensagemDoCliente } from "@/server/nps/regras";
import { tarefasCriadasNaConversa } from "@/server/prazos/crm";
import {
  ATRIBUTO_DO_CONTATO,
  CAMPO_DO_CRM,
  decidirGravacao,
  emailGravado,
  lerEmail,
  notaDoRegistro,
  type Desfecho,
  type Resultado,
} from "./regras";

/**
 * O e-mail que o cliente digitou vai para o contato do Chatwoot e para a task do
 * CRM (regras e motivo em `regras.ts`).
 *
 * - **Pelo sistema, sem modelo, e antes de qualquer decisão de responder.** Vale
 *   com a conversa nas mãos de uma pessoa, que é onde o e-mail chega.
 * - **Nunca lança e nunca atrasa o atendimento**: a rota chama sem esperar, e
 *   falha aqui vira nota na conversa, não conversa muda.
 * - **Só preenche o que está vazio.** E-mail já gravado, de quem for, não é
 *   trocado; o novo fica só na nota.
 * - **No contato vai para o atributo `email`** ("E-mail do responsável"), não
 *   para o campo nativo do Chatwoot, que é único na conta: o mesmo e-mail em dois
 *   contatos — duas linhas da mesma pessoa — daria 422.
 * - **A task é a que um agente criou NESTA conversa** (lida das `ToolCall`), nunca
 *   achada por telefone: o telefone acharia a negociação de outro atendimento.
 * - **A nota sai pelo robô da caixa**, e só quando algo mudou ou deu errado.
 */
export async function registrarEmailDoCliente(
  payload: unknown,
  portaAgentId: string,
): Promise<{ registrado: boolean }> {
  try {
    const mensagem = mensagemDoCliente(payload);
    if (!mensagem) return { registrado: false };

    const lido = lerEmail(mensagem.texto);
    if (lido.tipo !== "um") return { registrado: false };

    const cliente = await clienteDoAgente(portaAgentId);
    if (!cliente) return { registrado: false };

    const resultado: Resultado = {
      contato: await gravarNoContato(cliente, mensagem.conversationId, lido.email),
      tarefas: await gravarNasTasks(mensagem.conversationId, lido.email),
    };

    const nota = notaDoRegistro(lido.email, resultado);
    if (nota) {
      await cliente
        .enviarMensagem(mensagem.conversationId, nota, { privado: true })
        .catch((erro: unknown) =>
          logger.warn(
            { erro: mensagemDe(erro), conversa: mensagem.conversationId },
            "e-mail do cliente: não consegui deixar a nota interna",
          ),
        );
    }

    logger.info(
      {
        conversa: mensagem.conversationId,
        contato: resultado.contato.tipo,
        tarefas: resultado.tarefas.map((t) => t.desfecho.tipo),
      },
      "e-mail do cliente registrado",
    );
    return { registrado: true };
  } catch (erro) {
    logger.error({ erro: mensagemDe(erro) }, "e-mail do cliente: o registro falhou");
    return { registrado: false };
  }
}

async function gravarNoContato(
  cliente: ChatwootClient,
  conversationId: number,
  email: string,
): Promise<Desfecho> {
  try {
    const conversa = await cliente.obterConversa(conversationId);
    if (!conversa.contactId) return { tipo: "falhou", motivo: "a conversa não trouxe o contato" };

    const contato = await cliente.obterContato(conversa.contactId);
    const veredito = decidirGravacao(contato.atributos[ATRIBUTO_DO_CONTATO], email);
    if (veredito.acao === "igual") return { tipo: "igual" };
    if (veredito.acao === "outro") return { tipo: "outro", atual: veredito.atual };

    await cliente.definirAtributosDoContato(conversa.contactId, { [ATRIBUTO_DO_CONTATO]: email });
    return { tipo: "gravado" };
  } catch (erro) {
    return { tipo: "falhou", motivo: mensagemDe(erro) };
  }
}

async function gravarNasTasks(
  conversationId: number,
  email: string,
): Promise<Resultado["tarefas"]> {
  const saida: Resultado["tarefas"] = [];
  try {
    const ids = await tarefasCriadasNaConversa(conversationId, Date.now());
    if (ids.length === 0) return saida;

    const clickup = await abrirClickUp("email-do-contato");
    if ("erro" in clickup) {
      return ids.map((id) => ({
        id,
        url: null,
        desfecho: { tipo: "falhou", motivo: clickup.erro } as Desfecho,
      }));
    }

    for (const id of ids) saida.push(await gravarEmTask(clickup, id, email));
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro), conversa: conversationId }, "e-mail do cliente: CRM não lido");
  }
  return saida;
}

async function gravarEmTask(
  clickup: ClickUpDoSistema,
  tarefaId: string,
  email: string,
): Promise<Resultado["tarefas"][number]> {
  let url: string | null = null;
  try {
    const tarefa = await clickup.cliente.obterTarefa(tarefaId);
    url = tarefa.url ?? null;

    const listaId = tarefa.list?.id;
    if (!listaId) return { id: tarefaId, url, desfecho: { tipo: "sem campo" } };

    // Exatamente "E-mail": "E-mail do responsável" é campo do CLIENTE no ClickUp
    // e não é este.
    const campo = (await clickup.cliente.listarCamposPersonalizados(listaId)).fields.find(
      (c) => semAcento(c.name ?? "") === semAcento(CAMPO_DO_CRM),
    );
    if (!campo) return { id: tarefaId, url, desfecho: { tipo: "sem campo" } };

    const atual = tarefa.custom_fields?.find((c) => c.id === campo.id)?.value;
    const veredito = decidirGravacao(emailGravado(atual), email);
    if (veredito.acao === "igual") return { id: tarefaId, url, desfecho: { tipo: "igual" } };
    if (veredito.acao === "outro") {
      return { id: tarefaId, url, desfecho: { tipo: "outro", atual: veredito.atual } };
    }

    await clickup.executar("clickup_definir_campo_personalizado", {
      tarefaId,
      campos: [{ campo: campo.name, valor: email }],
    });
    return { id: tarefaId, url, desfecho: { tipo: "gravado" } };
  } catch (erro) {
    return { id: tarefaId, url, desfecho: { tipo: "falhou", motivo: mensagemDe(erro) } };
  }
}

const semAcento = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

const mensagemDe = (erro: unknown) =>
  (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
