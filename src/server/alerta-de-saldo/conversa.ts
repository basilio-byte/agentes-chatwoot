import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { mesmoNumero, type Destinatario } from "./regras";

/** Só o que este módulo usa do cliente — é o que o teste imita. */
export type ClienteDeAviso = Pick<
  ChatwootClient,
  | "buscarContatos"
  | "criarContato"
  | "vincularContatoACaixa"
  | "conversasDoContato"
  | "criarConversa"
  | "enviarMensagem"
>;

type Contato = Awaited<ReturnType<ChatwootClient["buscarContatos"]>>[number];

/**
 * O identificador que a WAHA grava no contato é o chat do WhatsApp
 * (`5584999999999@s.whatsapp.net`). Só esses dois sufixos são telefone: `@lid`
 * é um número interno do WhatsApp e `@g.us` é grupo — casar os dígitos deles
 * com um telefone seria coincidência.
 */
function telefoneDoIdentificador(identificador: string | null): string | null {
  const m = /^(\d{8,15})@(s\.whatsapp\.net|c\.us)$/.exec(identificador?.trim() ?? "");
  return m ? m[1] : null;
}

/** O contato desta pessoa, se já existe. Prefere o que já está na caixa. */
export function escolherContato(
  contatos: Contato[],
  telefone: string,
  caixaId: number,
): Contato | null {
  const dela = contatos.filter((c) =>
    [c.telefone, telefoneDoIdentificador(c.identificador)].some(
      (v) => v != null && mesmoNumero(v, telefone),
    ),
  );
  return dela.find((c) => c.caixas.some((ci) => ci.caixaId === caixaId)) ?? dela[0] ?? null;
}

/**
 * A conversa em que o aviso vai: a aberta mais recente desta pessoa nesta
 * caixa, ou uma nova.
 *
 * ⚠ **Reaproveitar é o que evita duplicar contato e conversa.** A equipe já
 * conversa com essas pessoas pela caixa 31, e um contato novo com o mesmo
 * número daria 422 (o telefone é único na conta). Por isso busca antes e
 * confere o número de cada resultado: a busca do Chatwoot casa TRECHO, e sem a
 * conferência o aviso podia ir para outra pessoa cujo número contém os mesmos
 * dígitos.
 *
 * Conversa resolvida não é reaproveitada: alguém a encerrou, e reabrir o
 * assunto dela com um alerta seria misturar as duas coisas.
 *
 * ⚠ Mas na caixa 31 o Chatwoot faz isso por conta própria: ela tem
 * `lock_to_single_conversation`, e `criarConversa` devolve a ÚLTIMA conversa do
 * contato, mesmo resolvida — a mensagem entra nela e ela continua resolvida
 * (visto em 22/09/2026, conversa 14029). Quem precisa da conversa na fila reabre
 * depois (o aviso de cobrança faz isso).
 */
export async function conversaParaAviso(
  cliente: ClienteDeAviso,
  caixaId: number,
  destinatario: Destinatario,
): Promise<{ conversaId: number; nova: boolean }> {
  // Os últimos 8 dígitos acham o número com e sem o nono dígito.
  const termo = destinatario.telefone.replace(/\D/g, "").slice(-8);
  const contato = escolherContato(
    await cliente.buscarContatos(termo),
    destinatario.telefone,
    caixaId,
  );

  let contatoId: number;
  let sourceId: string | null;

  if (contato) {
    contatoId = contato.id;
    sourceId = contato.caixas.find((ci) => ci.caixaId === caixaId)?.sourceId ?? null;

    const aberta = (await cliente.conversasDoContato(contatoId))
      .filter((c) => c.caixaId === caixaId && c.status !== "resolved")
      .sort((a, b) => b.id - a.id)[0];
    if (aberta) return { conversaId: aberta.id, nova: false };
  } else {
    const criado = await cliente.criarContato({
      nome: destinatario.nome,
      telefone: destinatario.telefone,
      caixaId,
    });
    contatoId = criado.id;
    sourceId = criado.sourceId;
  }

  sourceId ??= await cliente.vincularContatoACaixa(contatoId, caixaId);
  const conversaId = await cliente.criarConversa({ sourceId, caixaId, contatoId });
  return { conversaId, nova: true };
}

export type Entrega = {
  nome: string;
  /**
   * O Chatwoot aceitou a mensagem. ⚠ Não é "chegou no WhatsApp": quem leva até
   * lá é a WAHA, pelo webhook da caixa, e isso acontece depois, fora da nossa
   * vista. O que prova o caminho inteiro é o botão de teste.
   */
  ok: boolean;
  /** O que aconteceu, para a tela. Sem telefone. */
  detalhe: string;
  conversaId: number | null;
};

/**
 * Manda o mesmo texto a cada pessoa, uma de cada vez. A falha de uma não
 * impede as outras: o alerta que chega a duas de três ainda cumpre o papel.
 */
export async function entregarAviso(
  cliente: ClienteDeAviso,
  caixaId: number,
  destinatarios: Destinatario[],
  texto: string,
): Promise<Entrega[]> {
  const entregas: Entrega[] = [];

  for (const d of destinatarios) {
    let conversaId: number | null = null;
    try {
      const conversa = await conversaParaAviso(cliente, caixaId, d);
      conversaId = conversa.conversaId;
      await cliente.enviarMensagem(conversaId, texto);
      entregas.push({
        nome: d.nome,
        ok: true,
        detalhe: conversa.nova
          ? "entregue ao Chatwoot, numa conversa nova"
          : "entregue ao Chatwoot, na conversa aberta",
        conversaId,
      });
    } catch (erro) {
      entregas.push({
        nome: d.nome,
        ok: false,
        detalhe: erro instanceof Error ? erro.message.slice(0, 300) : String(erro),
        conversaId,
      });
    }
  }

  return entregas;
}
