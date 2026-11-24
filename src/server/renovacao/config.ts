import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

import { hostDoLink } from "./regras";
import { ATRIBUIR_A_PADRAO, recusaDoTexto } from "./whatsapp";

/**
 * As chaves da renovação automática — o que o sistema faz SOZINHO depois do
 * reajuste. Moram na linha `RENOVACAO` de `Integration` (`enabled` + `config`),
 * como as das outras funções do sistema sem modelo.
 *
 * ⚠ **Tudo nasce desligado, e é decisão de quem liga**: mover a tarefa para
 * `notificação renovação` e para `ongoing` faz as automações do ClickUp mandarem
 * e-mail AO CLIENTE, e avançar a fidelidade escreve no Conexa. Duas camadas, como
 * nas integrações: `enabled` é o interruptor geral e cada parte tem a sua chave.
 *
 * ⚠ **A propagação do reajuste (fase 2) NÃO está aqui.** Ela já estava no ar sem
 * chave quando isto nasceu, e o que ela escreve (valor, percentual e o status de
 * `notificação` para `pg pendente`) não dispara e-mail nenhum.
 */

/**
 * Como uma parte com ensaio se comporta. `sombra` lê, decide e REGISTRA o que
 * faria, mas não escreve nem fala com ninguém.
 */
export type ModoDeParte = "desligado" | "sombra" | "ligado";
/** O nome de quando só as datas tinham modo. */
export type ModoDasDatas = ModoDeParte;

export type ConfigDaRenovacao = {
  /** Fase 2b: de `renovação` para `notificação renovação` depois de 2 dias. */
  moverParaNotificacao: boolean;
  /** Fase 4: o cliente pagou o valor reajustado, a tarefa vai para `ongoing`. */
  fecharNoPagamento: boolean;
  /** Fase 3: o endereço que a automação 8 do ClickUp chama no lugar do n8n. */
  avancarDatas: ModoDasDatas;
  /**
   * Fase 5, a parte que já existia no n8n: o WhatsApp de renovação para o cliente
   * ONE quando a tarefa entra em `notificação renovação` (`whatsapp.ts`).
   */
  avisarPorWhatsapp: ModoDeParte;
  /** Quem recebe a conversa depois do envio, para a resposta chegar direto. */
  whatsappAtribuirA: string;
  /** O texto editado na tela. `null` segue o padrão (o do fluxo do n8n). */
  whatsappTexto: string | null;
  /** sha256 do token do endereço das datas. O endereço inteiro aparece UMA vez. */
  tokenHash: string | null;
  /** Quando o endereço foi gerado (ISO), para a tela dizer há quanto tempo. */
  tokenGeradoEm: string | null;
};

export const CONFIG_PADRAO: ConfigDaRenovacao = {
  moverParaNotificacao: false,
  fecharNoPagamento: false,
  avancarDatas: "desligado",
  avisarPorWhatsapp: "desligado",
  whatsappAtribuirA: ATRIBUIR_A_PADRAO,
  whatsappTexto: null,
  tokenHash: null,
  tokenGeradoEm: null,
};

const MODOS: readonly ModoDeParte[] = ["desligado", "sombra", "ligado"];

/**
 * Lê a configuração gravada. Qualquer coisa que não seja exatamente o esperado
 * vira DESLIGADO — nunca ligado por engano.
 */
export function lerConfigRenovacao(
  config: unknown,
  geralLigado: boolean,
): ConfigDaRenovacao {
  if (!geralLigado) return { ...CONFIG_PADRAO, ...enderecoDe(config), ...whatsappDe(config) };

  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const modo = MODOS.find((m) => m === c.avancarDatas) ?? "desligado";
  const modoDoWhatsapp = MODOS.find((m) => m === c.avisarPorWhatsapp) ?? "desligado";

  return {
    moverParaNotificacao: c.moverParaNotificacao === true,
    fecharNoPagamento: c.fecharNoPagamento === true,
    avancarDatas: modo,
    avisarPorWhatsapp: modoDoWhatsapp,
    ...whatsappDe(config),
    ...enderecoDe(config),
  };
}

/**
 * Quem recebe a conversa e o texto são DADO editado na tela, não chave de ligar:
 * valem mesmo com o interruptor geral desligado, para a tela mostrar o que está
 * gravado. Valor torto volta ao padrão.
 */
function whatsappDe(config: unknown) {
  const c = (config ?? {}) as { whatsappAtribuirA?: unknown; whatsappTexto?: unknown };
  const atribuirA = typeof c.whatsappAtribuirA === "string" ? c.whatsappAtribuirA.trim() : "";
  const texto = typeof c.whatsappTexto === "string" ? c.whatsappTexto.trim() : "";
  return {
    whatsappAtribuirA: atribuirA && atribuirA.length <= 80 ? atribuirA : ATRIBUIR_A_PADRAO,
    whatsappTexto: texto && !recusaDoTexto(texto) ? texto : null,
  };
}

function enderecoDe(config: unknown) {
  const c = (config ?? {}) as { tokenHash?: unknown; tokenGeradoEm?: unknown };
  return {
    tokenHash: typeof c.tokenHash === "string" && c.tokenHash.length > 0 ? c.tokenHash : null,
    tokenGeradoEm: typeof c.tokenGeradoEm === "string" ? c.tokenGeradoEm : null,
  };
}

/**
 * O host do Conexa DA SEAHUB (`seahubcoworking.conexa.app`), tirado da `baseUrl`
 * da integração — é contra ele que se reconhece a tarefa de outra empresa na
 * Base de clientes (`deOutraContaDoConexa`). Só lê a configuração, sem
 * credencial. Falha de leitura devolve nulo, e nulo não barra nada: o
 * comportamento volta a ser o de antes desta trava.
 */
export async function hostDoConexaDaSeahub(): Promise<string | null> {
  try {
    const linha = await db.integration.findUnique({
      where: { provider: IntegrationProvider.CONEXA },
      select: { config: true },
    });
    const base = (linha?.config as { baseUrl?: unknown } | null)?.baseUrl;
    return typeof base === "string" ? hostDoLink(base) : null;
  } catch {
    return null;
  }
}

/** A configuração de agora. Falha de leitura vale DESLIGADO. */
export async function configDaRenovacao(): Promise<ConfigDaRenovacao> {
  try {
    const linha = await db.integration.findUnique({
      where: { provider: IntegrationProvider.RENOVACAO },
      select: { enabled: true, config: true },
    });
    return lerConfigRenovacao(linha?.config, linha?.enabled ?? false);
  } catch {
    return CONFIG_PADRAO;
  }
}
