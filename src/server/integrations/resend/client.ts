/**
 * Envio de e-mail pela Resend (API HTTP, a mesma assinatura que a Seahub já
 * tem). Escrito à mão, como os outros clientes: `fetch` e nada mais — um SMTP
 * exigiria uma biblioteca a mais num bundle que lista as dependências à mão.
 *
 * - **A chave e o remetente são variáveis do SERVIDOR**: `RESEND_API_KEY` e
 *   `EMAIL_REMETENTE` (ex.: `Seahub <notas@seahubcoworking.com.br>`). O domínio
 *   do remetente precisa estar verificado na Resend, senão ela recusa.
 * - **`Idempotency-Key`**: a Resend não manda o mesmo pedido duas vezes dentro
 *   de 24 h. Um reenvio depois de um timeout não vira e-mail em dobro.
 * - Só serve para AVISO À EQUIPE. Nada daqui escreve para cliente.
 */

const BASE_PADRAO = "https://api.resend.com";
const PRAZO_MS = 15_000;

export class ResendError extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ResendError";
  }
}

export type ConfiguracaoDeEmail = { chave: string; remetente: string };

/** A configuração do servidor, ou `null` quando falta a chave ou o remetente. */
export function configuracaoDeEmail(
  env: Record<string, string | undefined> = process.env,
): ConfiguracaoDeEmail | null {
  const chave = env.RESEND_API_KEY?.trim();
  const remetente = env.EMAIL_REMETENTE?.trim();
  return chave && remetente ? { chave, remetente } : null;
}

export async function enviarEmail(
  config: ConfiguracaoDeEmail,
  email: { para: string[]; assunto: string; texto: string; html?: string; idempotencia?: string },
  base: string = process.env.RESEND_BASE_URL ?? BASE_PADRAO,
): Promise<{ id: string }> {
  let resposta: Response;
  try {
    resposta = await fetch(`${base}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.chave}`,
        "Content-Type": "application/json",
        ...(email.idempotencia ? { "Idempotency-Key": email.idempotencia.slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: config.remetente,
        to: email.para,
        subject: email.assunto,
        text: email.texto,
        ...(email.html ? { html: email.html } : {}),
      }),
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch (erro) {
    throw new ResendError(0, erro instanceof Error ? erro.message : String(erro));
  }

  const texto = await resposta.text();
  let json: Record<string, unknown> = {};
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!resposta.ok) {
    const detalhe = typeof json.message === "string" ? json.message : texto.slice(0, 200);
    throw new ResendError(resposta.status, `Resend respondeu ${resposta.status}: ${detalhe}`.slice(0, 300));
  }
  return { id: typeof json.id === "string" ? json.id : "" };
}
