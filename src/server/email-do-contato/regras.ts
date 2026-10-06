/**
 * E-mail que o cliente digita na conversa — as regras puras.
 *
 * Nasceu do chamado do Diego (06/10/2026): "muita gente está mandando o e-mail,
 * mas o e-mail não está sendo atualizado no Chatwoot nem subindo para o CRM".
 * Em 14 dias foram 27 conversas com e-mail do cliente e nenhuma execução o
 * gravou em lugar nenhum: não existia ferramenta que escrevesse o e-mail do
 * contato, e os prompts pedem o e-mail justamente ao passar a conversa para uma
 * pessoa — depois disso o agente se cala por regra, e o e-mail ficava só no
 * texto da conversa.
 *
 * Por isso é do SISTEMA, não do agente: lê a mensagem na chegada, antes de
 * qualquer decisão de responder, e vale com a conversa nas mãos de uma pessoa.
 */

/** O atributo personalizado do contato, "E-mail do responsável", no Chatwoot. */
export const ATRIBUTO_DO_CONTATO = "email";

/** O campo da task do CRM. Não confundir com "E-mail do responsável" do ClickUp. */
export const CAMPO_DO_CRM = "E-mail";

/**
 * Texto maior que isto não é alguém passando o e-mail: é documento colado, e um
 * endereço no meio dele não é o do cliente.
 */
const TAMANHO_MAXIMO_DA_MENSAGEM = 600;

/** Quem é da equipe não é cliente: um encaminhamento com e-mail nosso não vale. */
const DOMINIOS_DA_EQUIPE = ["seahubcoworking.com.br", "seahubcoworking.page", "seawaycenter.com"];

const PADRAO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export type EmailLido =
  | { tipo: "nenhum" }
  | { tipo: "um"; email: string }
  /** Mais de um endereço diferente: qual é do cliente, ninguém sabe. */
  | { tipo: "varios" };

/**
 * O e-mail da mensagem, em minúsculas. Só vale quando há UM endereço (repetido
 * conta como um): com dois, o sistema não escolhe — escolher errado grava o
 * e-mail do contador no cadastro do cliente.
 */
export function lerEmail(texto: string): EmailLido {
  const limpo = texto.trim();
  if (!limpo || limpo.length > TAMANHO_MAXIMO_DA_MENSAGEM) return { tipo: "nenhum" };

  const achados = new Set(
    (limpo.match(PADRAO) ?? [])
      .map((e) => e.toLowerCase())
      .filter((e) => e.length <= 254 && !DOMINIOS_DA_EQUIPE.some((d) => e.endsWith(`@${d}`))),
  );
  if (achados.size === 0) return { tipo: "nenhum" };
  if (achados.size > 1) return { tipo: "varios" };
  return { tipo: "um", email: [...achados][0] };
}

/** `valor` como texto de e-mail, ou `null` quando está vazio ou não é texto. */
export function emailGravado(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().toLowerCase();
  return limpo ? limpo : null;
}

export type Veredito =
  /** Está vazio: grava. */
  | { acao: "gravar" }
  /** Já tem exatamente este e-mail: nada a fazer, e nada a dizer. */
  | { acao: "igual" }
  /** Já tem OUTRO: não sobrescreve — dado de quem preencheu antes é de quem preencheu. */
  | { acao: "outro"; atual: string };

export function decidirGravacao(atual: unknown, novo: string): Veredito {
  const gravado = emailGravado(atual);
  if (!gravado) return { acao: "gravar" };
  if (gravado === novo) return { acao: "igual" };
  return { acao: "outro", atual: gravado };
}

/** O que aconteceu em cada lugar, para a nota interna. */
export type Desfecho =
  | { tipo: "gravado" }
  | { tipo: "igual" }
  | { tipo: "outro"; atual: string }
  | { tipo: "sem campo" }
  | { tipo: "falhou"; motivo: string };

export type Resultado = {
  contato: Desfecho;
  tarefas: { url: string | null; id: string; desfecho: Desfecho }[];
};

/**
 * A nota interna. `null` quando nada mudou e nada deu errado — o e-mail que o
 * cliente repete não pode encher a conversa de notas.
 *
 * Sai pelo robô da caixa, nunca pelo token de uma pessoa: nota de `user` conta
 * como "a equipe escreveu" para os prazos e para o NPS, e cancelaria o prazo de
 * quem não respondeu.
 */
export function notaDoRegistro(email: string, r: Resultado): string | null {
  const linhas: string[] = [];
  const fala = (onde: string, d: Desfecho) => {
    switch (d.tipo) {
      case "gravado":
        linhas.push(`✅ ${onde}: gravado.`);
        break;
      case "outro":
        linhas.push(`⚠ ${onde}: já tem outro e-mail (${d.atual}) — não foi trocado.`);
        break;
      case "falhou":
        linhas.push(`⚠ ${onde}: não consegui gravar (${d.motivo}).`);
        break;
      case "igual":
      case "sem campo":
        break;
    }
  };

  fala("Contato no Chatwoot", r.contato);
  for (const t of r.tarefas) fala(`Task do CRM${t.url ? ` ${t.url}` : ` ${t.id}`}`, t.desfecho);
  if (linhas.length === 0) return null;
  return [`📧 E-mail informado pelo cliente (registro automático): ${email}`, ...linhas].join("\n");
}
