import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

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

/** Como o endereço das datas se comporta. `sombra` lê e registra, mas não escreve. */
export type ModoDasDatas = "desligado" | "sombra" | "ligado";

export type ConfigDaRenovacao = {
  /** Fase 2b: de `renovação` para `notificação renovação` depois de 2 dias. */
  moverParaNotificacao: boolean;
  /** Fase 4: o cliente pagou o valor reajustado, a tarefa vai para `ongoing`. */
  fecharNoPagamento: boolean;
  /** Fase 3: o endereço que a automação 8 do ClickUp chama no lugar do n8n. */
  avancarDatas: ModoDasDatas;
  /** sha256 do token do endereço das datas. O endereço inteiro aparece UMA vez. */
  tokenHash: string | null;
  /** Quando o endereço foi gerado (ISO), para a tela dizer há quanto tempo. */
  tokenGeradoEm: string | null;
};

export const CONFIG_PADRAO: ConfigDaRenovacao = {
  moverParaNotificacao: false,
  fecharNoPagamento: false,
  avancarDatas: "desligado",
  tokenHash: null,
  tokenGeradoEm: null,
};

const MODOS: readonly ModoDasDatas[] = ["desligado", "sombra", "ligado"];

/**
 * Lê a configuração gravada. Qualquer coisa que não seja exatamente o esperado
 * vira DESLIGADO — nunca ligado por engano.
 */
export function lerConfigRenovacao(
  config: unknown,
  geralLigado: boolean,
): ConfigDaRenovacao {
  if (!geralLigado) return { ...CONFIG_PADRAO, ...enderecoDe(config) };

  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const modo = MODOS.find((m) => m === c.avancarDatas) ?? "desligado";

  return {
    moverParaNotificacao: c.moverParaNotificacao === true,
    fecharNoPagamento: c.fecharNoPagamento === true,
    avancarDatas: modo,
    ...enderecoDe(config),
  };
}

function enderecoDe(config: unknown) {
  const c = (config ?? {}) as { tokenHash?: unknown; tokenGeradoEm?: unknown };
  return {
    tokenHash: typeof c.tokenHash === "string" && c.tokenHash.length > 0 ? c.tokenHash : null,
    tokenGeradoEm: typeof c.tokenGeradoEm === "string" ? c.tokenGeradoEm : null,
  };
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
