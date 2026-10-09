/**
 * Tipo de operação (`tpOper`) da NFS-e nacional — Reforma Tributária, NT 2025.002.
 *
 * Módulo PURO, sem dependência de servidor: a tela (componente de cliente), a
 * configuração e a emissão leem a mesma lista. Os valores são os do enum
 * `ibsCbs.operationType` da Spedy, na ordem que presumivelmente é a numeração
 * oficial 1 a 5 (a rejeição real E0905 de 09/10/2026, ao enviar o terceiro, é
 * coerente com isso).
 */
export const TIPOS_DE_OPERACAO = [
  "supplyWithSubsequentPayment",
  "paymentReceivedAfterSupply",
  "supplyWithPriorPayment",
  "paymentReceivedBeforeSupply",
  "simultaneousSupplyAndPayment",
] as const;

export type TipoDeOperacao = (typeof TIPOS_DE_OPERACAO)[number];

/** Quando a nota sai: ao PAGAR a cobrança (o padrão) ou ao GERÁ-LA (cliente "antes"). */
export type MomentoDaNota = "quitacao" | "geracao";

export const ROTULO_DO_TIPO_DE_OPERACAO: Record<TipoDeOperacao, string> = {
  supplyWithSubsequentPayment: "1 — Fornecimento com pagamento posterior",
  paymentReceivedAfterSupply: "2 — Recebimento do pagamento com fornecimento já realizado",
  supplyWithPriorPayment: "3 — Fornecimento com pagamento já realizado",
  paymentReceivedBeforeSupply: "4 — Recebimento do pagamento com fornecimento posterior",
  simultaneousSupplyAndPayment: "5 — Fornecimento e recebimento do pagamento concomitantes",
};

/**
 * O 2 e o 3 pedem o grupo de documentos referenciados (a NFS-e da outra perna da
 * operação); o 1, o 4 e o 5 não o aceitam. É a regra E0905/E0906 do layout
 * nacional, e a rejeição E0905 do 3 foi vista de verdade. ⚠ A Seahub NÃO consegue
 * enviar esse grupo (a API da Spedy não tem o campo e não existe nota anterior a
 * referenciar na quitação): o 2 e o 3 são rejeitados pela prefeitura.
 */
export const EXIGE_NFSE_REFERENCIADA: Record<TipoDeOperacao, boolean> = {
  supplyWithSubsequentPayment: false,
  paymentReceivedAfterSupply: true,
  supplyWithPriorPayment: true,
  paymentReceivedBeforeSupply: false,
  simultaneousSupplyAndPayment: false,
};

/**
 * O que vale por momento: a ÚLTIMA resposta do Laércio (09/10/2026, depois de
 * duas anteriores que a prefeitura não aceitaria): *"Bota a opção 1 e 4 para ver
 * se roda"*, respondendo a "A) quitação, B) geração". Quitação: fornecimento com
 * pagamento posterior (1). Geração: recebimento do pagamento com fornecimento
 * posterior (4). Os dois dispensam a NFS-e referenciada. Decisão FISCAL dele, que
 * já mudou três vezes no mesmo dia: por isso é configuração (tela de notas
 * fiscais), e não constante.
 */
export const TIPO_DE_OPERACAO_PADRAO: Record<MomentoDaNota, TipoDeOperacao> = {
  quitacao: "supplyWithSubsequentPayment",
  geracao: "paymentReceivedBeforeSupply",
};
