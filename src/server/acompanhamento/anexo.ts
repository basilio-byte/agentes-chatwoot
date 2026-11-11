/**
 * O contrato assinado vai para o campo "Contrato Assinado" da task.
 *
 * ⚠⚠ **Por que isto existe.** Uma trava do ClickBot só deixa a task ficar em
 * `ongoing` quando esse campo tem arquivo. Ela foi criada porque os contratos
 * vinham sendo gerados à mão e nem sempre chegavam. Em 11/11/2026 a primeira
 * contratação completa foi devolvida de `ongoing` para `🏃‍♂️onboarding` pelo
 * ClickBot, segundos depois de o sistema movê-la, com contrato, cobrança,
 * pagamento e assinatura todos confirmados — só faltava o anexo. Quem fazia
 * isso à mão era o Felipe, que está saindo.
 *
 * A escolha foi CUMPRIR a trava, não afrouxá-la: ela diz "só é cliente ativo
 * quando o contrato existe de verdade", e isso continua sendo verdade.
 */
import { zapsignConfigSchema } from "@/server/integrations/zapsign/config";
import { ZapSignClient } from "@/server/integrations/zapsign/client";

import type { ClickUpClient } from "@/server/integrations/clickup/client";

/**
 * O campo e o workspace são da conta da Seahub, como as listas do CRM.
 * `Contrato Assinado` é do tipo `attachment` — conferido em 11/11/2026.
 */
export const CAMPO_CONTRATO_ASSINADO = "04047e09-391d-4b43-9357-ddd15a2b9531";
export const WORKSPACE = "3089014";

/** Contrato assinado é PDF de poucas páginas; o teto é folga, não expectativa. */
export const LIMITE_BYTES = 15 * 1_048_576;

export type Anexacao =
  | { feito: "anexado" }
  | { feito: "jaTinha" }
  | { feito: "falhou"; motivo: string };

/**
 * Lê o campo de volta e diz se ele tem arquivo.
 *
 * ⚠ É isto que torna o passo honesto: a associação do anexo ao campo **não
 * está documentada** pela ClickUp (ver `associarAnexoAoCampo`), então "a
 * chamada não deu erro" não prova que o campo ficou preenchido — e é o campo
 * que a trava do ClickBot lê. Só a leitura de volta prova.
 */
export function campoTemArquivo(
  campos: Array<{ id?: string; value?: unknown }> | null | undefined,
): boolean {
  const campo = (campos ?? []).find((c) => c.id === CAMPO_CONTRATO_ASSINADO);
  if (!campo) return false;
  const v = campo.value;
  if (Array.isArray(v)) return v.length > 0;
  return v != null && v !== "";
}

/** Nome do arquivo na task. Sem acento nem barra: é nome de arquivo. */
export function nomeDoArquivo(cliente: string | null | undefined): string {
  const limpo = (cliente ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return limpo ? `contrato-assinado-${limpo}.pdf` : "contrato-assinado.pdf";
}

export type ZapSignAberta = { cliente: ZapSignClient };

/**
 * Abre o cliente cru da ZapSign a partir da credencial cifrada.
 *
 * Existe ao lado de `abrirZapSign` (que entrega a FERRAMENTA
 * `zapsign_ver_documento`) porque a ferramenta não devolve `signed_file`.
 */
export async function abrirZapSignCru(): Promise<ZapSignAberta | null> {
  const { db } = await import("@/lib/db");
  const { IntegrationProvider } = await import("@/generated/prisma/enums");
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.ZAPSIGN },
    include: { credential: true },
  });
  if (!integracao?.enabled || !integracao.credential) return null;

  try {
    const { decifrar } = await import("@/lib/crypto");
    const credencial = decifrar(integracao.credential);
    const config = zapsignConfigSchema.parse(integracao.config ?? {});
    return { cliente: new ZapSignClient(config, credencial) };
  } catch {
    return null;
  }
}

/**
 * Baixa o PDF assinado da ZapSign.
 *
 * ⚠ `signed_file` **expira em 60 minutos**, e por isso a URL é lida AQUI, na
 * hora de usar, e nunca guardada. É também por isso que `zapsign_ver_documento`
 * não devolve esse campo ao modelo: ali a URL morreria antes do uso.
 */
export async function baixarAssinado(
  zapsign: ZapSignAberta,
  documentoToken: string,
): Promise<{ bytes: Buffer } | { erro: string }> {
  let url: string | null = null;
  try {
    const doc = await zapsign.cliente.detalhar(documentoToken);
    url = doc.signed_file ?? null;
    if (doc.deleted) return { erro: "o documento foi excluído na ZapSign" };
  } catch (e) {
    return { erro: `não consegui ler o documento na ZapSign: ${(e as Error).message}` };
  }
  if (!url) return { erro: "a ZapSign ainda não tem o arquivo assinado" };

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return { erro: `o arquivo assinado respondeu ${r.status}` };

    const declarado = Number(r.headers.get("content-length") ?? "");
    if (Number.isFinite(declarado) && declarado > LIMITE_BYTES) {
      return { erro: "o arquivo assinado passou do teto de tamanho" };
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > LIMITE_BYTES) {
      return { erro: "o arquivo assinado passou do teto de tamanho" };
    }
    return { bytes };
  } catch (e) {
    return { erro: `não consegui baixar o assinado: ${(e as Error).message}` };
  }
}

/**
 * Põe o contrato assinado no campo, e **confere lendo de volta**.
 *
 * Nunca lança: quem chama usa o desfecho para decidir se move o status. Mover
 * sem o anexo faz a task quicar de volta e o nosso registro dizer "concluído"
 * sobre algo que não concluiu.
 */
export async function anexarContratoAssinado(args: {
  clickup: Pick<
    ClickUpClient,
    "obterTarefa" | "enviarArquivoParaCampo" | "associarAnexoAoCampo"
  >;
  zapsign: ZapSignAberta | null;
  taskId: string;
  documentoToken: string | null;
  cliente: string | null;
}): Promise<Anexacao> {
  // Já anexado (pela equipe, ou por uma rodada anterior que caiu depois de
  // anexar): não sobe de novo. Dois contratos no campo confundem quem lê.
  try {
    const tarefa = await args.clickup.obterTarefa(args.taskId);
    if (campoTemArquivo(tarefa.custom_fields)) return { feito: "jaTinha" };
  } catch (e) {
    return { feito: "falhou", motivo: `não consegui ler a task: ${(e as Error).message}` };
  }

  if (!args.zapsign) return { feito: "falhou", motivo: "ZapSign desligada ou sem credencial" };
  if (!args.documentoToken) {
    return { feito: "falhou", motivo: "não sei qual é o documento desta contratação" };
  }

  const baixado = await baixarAssinado(args.zapsign, args.documentoToken);
  if ("erro" in baixado) return { feito: "falhou", motivo: baixado.erro };

  let anexoId: string;
  try {
    const enviado = await args.clickup.enviarArquivoParaCampo({
      workspaceId: WORKSPACE,
      campoId: CAMPO_CONTRATO_ASSINADO,
      nome: nomeDoArquivo(args.cliente),
      bytes: baixado.bytes,
      mimeType: "application/pdf",
    });
    anexoId = enviado.id;
  } catch (e) {
    return { feito: "falhou", motivo: `o upload falhou: ${(e as Error).message}` };
  }

  // A associação é o passo não documentado. Ela pode ser desnecessária (o
  // upload é feito NO campo), então o erro dela não condena nada sozinho:
  // quem decide é a leitura de volta, logo abaixo.
  let erroDaAssociacao: string | null = null;
  try {
    await args.clickup.associarAnexoAoCampo(args.taskId, CAMPO_CONTRATO_ASSINADO, anexoId);
  } catch (e) {
    erroDaAssociacao = (e as Error).message;
  }

  try {
    const tarefa = await args.clickup.obterTarefa(args.taskId);
    if (campoTemArquivo(tarefa.custom_fields)) return { feito: "anexado" };
  } catch (e) {
    return {
      feito: "falhou",
      motivo: `subi o arquivo (${anexoId}) mas não consegui conferir o campo: ${(e as Error).message}`,
    };
  }

  return {
    feito: "falhou",
    motivo: `subi o arquivo (${anexoId}) e o campo continua vazio${
      erroDaAssociacao ? ` — a associação devolveu: ${erroDaAssociacao}` : ""
    }`,
  };
}
