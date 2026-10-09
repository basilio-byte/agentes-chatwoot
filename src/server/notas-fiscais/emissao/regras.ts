import { TIPO_DE_OPERACAO_PADRAO, type MomentoDaNota, type TipoDeOperacao } from "@/lib/tipos-de-operacao";
import type { CorpoDeNota } from "@/server/integrations/spedy/client";
import type { NotasFiscaisConfig } from "../config";

export type { MomentoDaNota };
import { formatarReais, type NotaPlanejada } from "../regras";

/**
 * A emissão, em regras puras e testadas: quem pode ser emitida, como o corpo da
 * nota é montado e o que cada resposta da Spedy quer dizer.
 *
 * ⚠ Nada aqui chama a Spedy. Quem chama é `emitir.ts`, e só com a emissão
 * ligada na tela.
 */

/**
 * Tamanho máximo de cada texto que vai à Spedy. O n8n já cortava as strings
 * porque a Spedy e a prefeitura recusam o que passa — e a recusa vem como nota
 * rejeitada, depois de gastar número.
 *
 * - **Declarados no contrato da Spedy** (OpenAPI): `integrationId` 36, rua 100,
 *   bairro 100, número 10, complemento 150, CEP 15.
 * - **Nome do cliente: 80.** O contrato não declara limite, mas o fluxo do n8n
 *   corta `name` e `legalName` em `.slice(0, 80)` — e é o único corte que ele
 *   faz (lido em 07/10/2026). Cortar também aqui é o que o usuário pediu.
 * - **Não declarados e que o n8n não corta**: e-mail, telefone e discriminação.
 *   Os valores são os do layout nacional da NFS-e, por cautela.
 *
 * Mudou um limite? É aqui, e o teste confere que nenhum texto o ultrapassa.
 */
export const LIMITES = {
  integrationId: 36,
  nome: 80,
  email: 60,
  telefone: 20,
  rua: 100,
  numero: 10,
  bairro: 100,
  complemento: 150,
  cep: 8,
  descricao: 2000,
} as const;

/**
 * Corta o texto no limite. Antes, aparo e junto os espaços repetidos — o
 * cadastro do Conexa vem com "  " e quebra de linha onde não devia. Nunca
 * deixa meio caractere (par substituto cortado ao meio vira "�").
 */
export function cortar(texto: string | null | undefined, limite: number): string {
  const limpo = (texto ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (limpo.length <= limite) return limpo;
  let corte = limpo.slice(0, limite);
  const ultimo = corte.charCodeAt(corte.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) corte = corte.slice(0, -1);
  return corte.trimEnd();
}

/** Só os dígitos de um texto. */
export const soDigitos = (texto: string | null | undefined): string => (texto ?? "").replace(/\D/g, "");

/** `03.03.02` → `030302`: é assim que a Spedy guarda o Código de Tributação Nacional. */
export function codigoNacional(codigo: string): string {
  return soDigitos(codigo);
}

// ---------------------------------------------------------------------------
// Quem pode ser emitida
// ---------------------------------------------------------------------------

export type Elegibilidade = { ok: true } | { ok: false; motivo: string };

/**
 * A cobrança pode ser emitida AGORA? Três travas, todas pelo lado da cautela:
 *
 * 1. a emissão tem de estar ligada;
 * 2. a decisão tem de estar PRONTA (nada de "aguardando" nem "conferir");
 * 3. com lista de cobranças liberadas, só elas; sem lista, só o que foi pago a
 *    partir do corte com o n8n — o que é mais antigo já teve nota dele.
 */
export function podeEmitir(
  config: Pick<NotasFiscaisConfig, "emissao" | "empresas">,
  linha: {
    cobrancaId: number;
    empresaId: number;
    situacao: string;
    /** Quitada (AAAA-MM-DD), ou a data de criação nas geradas. */
    referencia: string | null;
  },
): Elegibilidade {
  const { emissao } = config;
  if (!emissao.ligada) return { ok: false, motivo: "a emissão está desligada" };
  if (linha.situacao !== "PRONTA") return { ok: false, motivo: "a cobrança não está pronta" };
  if (!config.empresas[String(linha.empresaId)]) {
    return { ok: false, motivo: `a unidade ${linha.empresaId} do Conexa não tem empresa na Spedy` };
  }
  if (emissao.soCobrancas.length) {
    return emissao.soCobrancas.includes(linha.cobrancaId)
      ? { ok: true }
      : { ok: false, motivo: "a cobrança não está na lista liberada" };
  }
  if (!emissao.aPartirDe) return { ok: false, motivo: "sem lista liberada nem dia de corte" };
  if (!linha.referencia || linha.referencia < emissao.aPartirDe) {
    return { ok: false, motivo: "é anterior ao corte com o n8n" };
  }
  return { ok: true };
}

/**
 * A cobrança está RETIDA? É quando alguma das notas dela tem um código em espera
 * (`emissao.codigosEmEspera`): então NENHUMA nota da cobrança sai — nem a de outro
 * código —, porque o cliente receberia metade das notas por e-mail e a outra
 * metade, depois. Devolve o primeiro código que segura, ou `null`.
 */
export function codigoQueSegura(
  notas: ReadonlyArray<{ codigo: string }>,
  emEspera: readonly string[],
): string | null {
  if (!emEspera.length) return null;
  return notas.find((n) => emEspera.includes(n.codigo))?.codigo ?? null;
}

// ---------------------------------------------------------------------------
// O tomador (o cliente da nota)
// ---------------------------------------------------------------------------

export type Tomador = {
  nome: string;
  /** CPF (11) ou CNPJ (14), só dígitos. */
  documento: string;
  email: string | null;
  telefone: string | null;
  cep: string;
  rua: string;
  numero: string;
  bairro: string;
  complemento: string;
  cidade: string;
  uf: string;
};

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const primeiro = (v: unknown): string => (Array.isArray(v) ? texto(v[0]) : "");

/** O cliente como `GET /customer/:id` devolve (campos aninhados, ver `formatacao.ts`). */
export function lerTomador(bruto: Record<string, unknown>): Tomador {
  const pf = (bruto.naturalPerson ?? {}) as Record<string, unknown>;
  const pj = (bruto.legalPerson ?? {}) as Record<string, unknown>;
  const ende = (bruto.address ?? {}) as Record<string, unknown>;
  const estado = ende.state;
  const uf =
    typeof estado === "string"
      ? estado
      : estado && typeof estado === "object"
        ? texto((estado as Record<string, unknown>).abbreviation)
        : "";
  const fone = primeiro(bruto.phones) || texto(bruto.cellNumber);
  return {
    nome: texto(bruto.name),
    documento: soDigitos(texto(pj.cnpj) || texto(pf.cpf)),
    email: primeiro(bruto.emailsMessage) || null,
    telefone: fone ? soDigitos(fone) : null,
    cep: soDigitos(texto(ende.zipCode)),
    rua: texto(ende.street),
    numero: texto(ende.number),
    bairro: texto(ende.neighborhood),
    complemento: texto(ende.additionalDetails),
    cidade: texto(ende.city),
    uf: uf.toUpperCase(),
  };
}

/** O que a consulta do CEP disse. `desconhecido` = a consulta falhou: não é prova de nada. */
export type CepLido =
  | { estado: "ok"; ibge: number | null; cidade: string; uf: string }
  | { estado: "inexistente" }
  | { estado: "desconhecido" };

/**
 * Tudo que impede a nota de sair, ANTES de gastar número. Cada item é uma frase
 * para quem vai corrigir o cadastro no Conexa.
 *
 * ⚠ O caso que motivou: nota rejeitada em 07/10/2026 com "o CEP do tomador não
 * existe ou não pertence ao município" (E0240). Quando a consulta do CEP falha
 * (`desconhecido`), NÃO se conclui que o CEP é ruim: segue, e a prefeitura diz.
 */
export function problemasDoTomador(t: Tomador, cep: CepLido): string[] {
  const p: string[] = [];
  if (!t.nome) p.push("o cadastro do cliente está sem nome");
  if (t.documento.length !== 11 && t.documento.length !== 14) {
    p.push(t.documento ? "o CPF/CNPJ do cadastro não tem 11 nem 14 dígitos" : "o cadastro está sem CPF ou CNPJ");
  }
  // Sem CEP nenhum, a nota vai sem endereço (ver `montarCorpo`): o n8n mandou assim
  // uma nota de pessoa física em 07/10/2026 e a Spedy completou do cadastro dela.
  // CEP preenchido e torto é outra coisa: é endereço errado, e a nota não sai.
  if (!t.cep) return p;
  if (t.cep.length !== 8) {
    p.push(`o CEP do cadastro (${t.cep}) não tem 8 dígitos`);
    return p;
  }
  // ⚠ Cidade do cadastro diferente da do CEP NÃO segura a nota (08/10/2026): o
  // corpo manda a cidade DO CEP (com o código IBGE dele), então CEP e cidade vão
  // coerentes — que é o que a prefeitura confere (E0240). O caso real foi um
  // cadastro com o endereço do prédio em Natal e "Acari" digitado no campo cidade;
  // muitos clientes de endereço fiscal usam o CEP do prédio.
  if (cep.estado === "inexistente") {
    p.push(`o CEP ${t.cep} do cadastro não existe`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// O corpo da nota
// ---------------------------------------------------------------------------

/**
 * A data de competência que vai à Spedy: o PRIMEIRO dia do mês da cobrança
 * (decisão do Laercio, 06/10/2026). Mês que ainda não chegou fica de fora — a
 * Spedy usa o dia da emissão —, para a prefeitura não recusar data futura.
 */
export function dataDeCompetencia(competencia: string | null, hoje: string): string | undefined {
  if (!competencia || !/^\d{4}-\d{2}$/.test(competencia)) return undefined;
  if (competencia > hoje.slice(0, 7)) return undefined;
  return `${competencia}-01`;
}

/**
 * Itens da LC 116 em que a prefeitura (NFS-e nacional, NT 2025.002 da Reforma
 * Tributária) exige o TIPO DE OPERAÇÃO. Vem da própria rejeição E0903 de Natal, em
 * 09/10/2026: "deve ser informado quando se tratar de uma compra governamental ou um
 * dos serviços da LC 116/2003 listados: 25.05; 15.09; 17.12; 10.05". A sala privativa
 * (10.05.01) é o único que a Seahub usa; os outros entram por segurança, porque o
 * código de uma categoria pode mudar na tela.
 */
export const ITENS_COM_TIPO_DE_OPERACAO = ["10.05", "15.09", "17.12", "25.05"] as const;

export function exigeTipoDeOperacao(codigo: string): boolean {
  return ITENS_COM_TIPO_DE_OPERACAO.some((item) => codigo.startsWith(`${item}.`));
}

export function montarCorpo(args: {
  nota: Pick<NotaPlanejada, "chave" | "codigo" | "valorCentavos" | "descricao" | "competencia">;
  tomador: Tomador;
  cep: CepLido;
  /** Dia de hoje em São Paulo (AAAA-MM-DD). */
  hoje: string;
  enviarEmailAoCliente: boolean;
  /** Sem isto vale a quitação, que é a nota da maioria. */
  momento?: MomentoDaNota;
  /**
   * O tipo de operação de cada momento (`emissao.tipoDeOperacao`, decisão fiscal do
   * Laércio). Sem isto vale o padrão. Só entra nos itens em que a prefeitura exige.
   */
  tiposDeOperacao?: Record<MomentoDaNota, TipoDeOperacao>;
}): CorpoDeNota {
  const { nota, tomador: t, cep } = args;
  const cidade = cep.estado === "ok" ? { code: cep.ibge ?? undefined, name: cep.cidade, state: cep.uf.toLowerCase() } : t.cidade
    ? { name: cortar(t.cidade, 60), state: t.uf ? t.uf.toLowerCase() : undefined }
    : undefined;

  // E-mail que não cabe não é cortado: um e-mail pela metade é outro endereço.
  const email = t.email && t.email.length <= LIMITES.email && /^\S+@\S+\.\S+$/.test(t.email) ? t.email : undefined;
  const complemento = cortar(t.complemento, LIMITES.complemento);

  return {
    integrationId: cortar(nota.chave, LIMITES.integrationId),
    issue: true,
    sendEmailToCustomer: args.enviarEmailAoCliente && !!email,
    effectiveDate: dataDeCompetencia(nota.competencia, args.hoje),
    description: cortar(nota.descricao, LIMITES.descricao),
    nationalTaxationCode: codigoNacional(nota.codigo),
    // Só onde a prefeitura exige: mandar a todas mudaria a nota comum (03.03.02),
    // que o Natal já autoriza sem o campo.
    ...(exigeTipoDeOperacao(nota.codigo)
      ? { ibsCbs: { operationType: (args.tiposDeOperacao ?? TIPO_DE_OPERACAO_PADRAO)[args.momento ?? "quitacao"] } }
      : {}),
    receiver: {
      name: cortar(t.nome, LIMITES.nome),
      federalTaxNumber: t.documento,
      email,
      // Sem telefone, como o n8n: a nota não o usa, e um formato que a Spedy
      // recuse seria uma nota a menos por nada.
      address: t.cep
        ? {
            postalCode: t.cep,
            street: cortar(t.rua, LIMITES.rua) || undefined,
            number: cortar(t.numero, LIMITES.numero) || "S/N",
            district: cortar(t.bairro, LIMITES.bairro) || undefined,
            additionalInformation: complemento || undefined,
            country: "BRA",
            city: cidade,
          }
        : undefined,
    },
    total: { invoiceAmount: Math.round(nota.valorCentavos) / 100 },
  };
}

// ---------------------------------------------------------------------------
// O que a Spedy respondeu
// ---------------------------------------------------------------------------

export type SituacaoDaNotaLida = "ENVIADA" | "AUTORIZADA" | "REJEITADA" | "CANCELADA";

/**
 * O status da Spedy na nossa situação. `created` depois de um envio com
 * `issue: true` é só "ainda não enfileirou" — espera. `inContingent` é a nota
 * autorizada em contingência: ainda não vale, espera.
 */
export function situacaoDoStatus(status: string): SituacaoDaNotaLida {
  switch (status) {
    case "authorized":
      return "AUTORIZADA";
    case "rejected":
    case "denied":
      return "REJEITADA";
    case "canceled":
    case "removed":
    case "disabled":
      return "CANCELADA";
    default:
      return "ENVIADA";
  }
}

/** A recusa da prefeitura em uma frase, sem o ruído da resposta. */
export function motivoDaRecusa(detalhe: { message?: string; code?: string } | null): string {
  if (!detalhe?.message) return "a prefeitura recusou, sem dizer o motivo";
  const texto = detalhe.message.replace(/\s+/g, " ").trim();
  return cortar(detalhe.code ? `${detalhe.code}: ${texto}` : texto, 400);
}

// ---------------------------------------------------------------------------
// O aviso à equipe
// ---------------------------------------------------------------------------

export type NotaComProblema = {
  chave: string;
  cobrancaId: number;
  empresa: string;
  codigo: string;
  valorCentavos: number;
  situacao: "REJEITADA" | "FALHOU";
  motivo: string | null;
  /**
   * Quando a nota foi mandada pela última vez (ISO). Entra na chave de idempotência
   * do e-mail: a mesma nota rejeitada DE NOVO, depois de "Tentar de novo", é outro
   * fato e merece outro aviso, e não o mesmo e-mail já enviado.
   */
  tentativaEm?: string;
};

const escaparHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** O que a pessoa que recebe o aviso precisa fazer, conforme a causa. */
function oQueFazer(n: NotaComProblema): string {
  if (n.situacao === "FALHOU" && n.motivo?.startsWith("Cadastro do cliente:")) {
    return "Corrija o cadastro do cliente no Conexa. A nota sai sozinha na próxima conferência (a cada 5 minutos).";
  }
  if (n.situacao === "FALHOU") {
    return "A Spedy recusou o pedido e repetir igual dá no mesmo. Precisa de ajuda técnica. Resolvida a causa, use \"Tentar de novo\" na lista de notas (Integrações → Notas fiscais).";
  }
  return "A prefeitura recusou a nota; ela fica guardada. Corrija a causa e use \"Tentar de novo\" na lista de notas (Integrações → Notas fiscais): a mesma nota é reenviada, sem gastar outro número.";
}

/**
 * Cobrança PAGA que ainda não gerou nota e espera uma pessoa. É o outro lado do
 * "nota com problema": aqui nem chegou a existir nota. `chave` é o que impede o
 * mesmo caso de ser avisado duas vezes.
 */
export type CobrancaSemNota = {
  /** `retida:<cobrança>:<códigos>` ou `decisao:<cobrança>:<situação>`. */
  chave: string;
  cobrancaId: number;
  empresa: string;
  valorCentavos: number;
  tipo: "retida" | "conferir" | "aguardando código";
  detalhe: string;
};

const TITULO_DO_TIPO: Record<CobrancaSemNota["tipo"], string> = {
  retida: "retida (código em espera)",
  conferir: "para conferir",
  "aguardando código": "aguardando código",
};

function oQueFazerSemNota(c: CobrancaSemNota): string {
  if (c.tipo === "retida") {
    return "Fica guardada, já paga. Quando a decisão fiscal chegar, tire o código da lista \"Códigos em espera\" (Integrações → Notas fiscais): ela sai sozinha na rodada seguinte.";
  }
  if (c.tipo === "aguardando código") {
    return "Dê um código à categoria (ou à regra do produto) em Integrações → Notas fiscais e salve: a cobrança volta a ser avaliada na hora.";
  }
  return "Uma pessoa precisa decidir esta cobrança (multa, venda que não soma, parcela...). Veja o motivo e ajuste as regras em Integrações → Notas fiscais.";
}

/**
 * O e-mail para quem cuida das notas. Uma mensagem só com tudo que está
 * pendente, e não um e-mail por nota: um lote ruim não pode encher a caixa.
 * Sem nome nem documento do cliente — só a cobrança, que se acha no Conexa.
 *
 * Leva duas listas: as NOTAS com problema (rejeitada, parada) e as cobranças
 * PAGAS que ainda nem geraram nota (retida, para conferir, aguardando código).
 */
export function montarAviso(
  notas: NotaComProblema[],
  semNota: CobrancaSemNota[] = [],
): { assunto: string; texto: string; html: string } {
  const total = notas.length + semNota.length;
  const assunto =
    semNota.length === 0
      ? `NFS-e: ${total} nota${total === 1 ? "" : "s"} precisa${total === 1 ? "" : "m"} de atenção`
      : notas.length === 0
        ? `NFS-e: ${total} cobrança${total === 1 ? " paga" : "s pagas"} sem nota`
        : `NFS-e: ${total} ${total === 1 ? "item precisa" : "itens precisam"} de atenção`;

  const linhas = notas.map((nota) => {
    const situacao = nota.situacao === "REJEITADA" ? "rejeitada pela prefeitura" : "parada antes de enviar";
    return {
      titulo: `Cobrança #${nota.cobrancaId} (${nota.empresa}) — ${formatarReais(nota.valorCentavos)}, código ${nota.codigo}`,
      situacao,
      motivo: nota.motivo ?? "sem motivo registrado",
      fazer: oQueFazer(nota),
    };
  });
  const sem = semNota.map((c) => ({
    titulo: `Cobrança #${c.cobrancaId} (${c.empresa}) — ${formatarReais(c.valorCentavos)}`,
    situacao: TITULO_DO_TIPO[c.tipo],
    motivo: c.detalhe,
    fazer: oQueFazerSemNota(c),
  }));

  const cabecalhoDasNotas = notas.length === 1 ? "Uma nota fiscal precisa de atenção:" : `${notas.length} notas fiscais precisam de atenção:`;
  const cabecalhoDasSemNota =
    semNota.length === 1
      ? "Uma cobrança paga ainda não gerou nota (fica guardada, nada se perde):"
      : `${semNota.length} cobranças pagas ainda não geraram nota (ficam guardadas, nada se perde):`;
  const item = (l: { titulo: string; situacao: string; motivo: string; fazer: string }) => [
    `• ${l.titulo}`,
    `  Situação: ${l.situacao}`,
    `  Motivo: ${l.motivo}`,
    `  O que fazer: ${l.fazer}`,
    "",
  ];
  const itemHtml = (l: { titulo: string; situacao: string; motivo: string; fazer: string }) =>
    `<li><strong>${escaparHtml(l.titulo)}</strong><br>Situação: ${escaparHtml(l.situacao)}<br>Motivo: ${escaparHtml(l.motivo)}<br>O que fazer: ${escaparHtml(l.fazer)}</li>`;

  const texto = [
    ...(notas.length ? [cabecalhoDasNotas, "", ...linhas.flatMap(item)] : []),
    ...(semNota.length ? [cabecalhoDasSemNota, "", ...sem.flatMap(item)] : []),
    "Aviso automático do sistema de notas fiscais da Seahub.",
  ].join("\n");
  const html = [
    ...(notas.length ? [`<p>${cabecalhoDasNotas}</p>`, "<ul>", ...linhas.map(itemHtml), "</ul>"] : []),
    ...(semNota.length ? [`<p>${cabecalhoDasSemNota}</p>`, "<ul>", ...sem.map(itemHtml), "</ul>"] : []),
    "<p><small>Aviso automático do sistema de notas fiscais da Seahub.</small></p>",
  ].join("");
  return { assunto, texto, html };
}

/** Minutos que uma nota pode ficar na fila da prefeitura antes de virar motivo de olhar. */
export const MINUTOS_NA_FILA = 30;

export function resumoDaNota(n: { codigo: string; valorCentavos: number; chave: string }): string {
  return `${n.chave} (${n.codigo}, ${formatarReais(n.valorCentavos)})`;
}

// ---------------------------------------------------------------------------
// A cautela: as primeiras notas saem uma de cada vez, e problema desliga tudo
// ---------------------------------------------------------------------------

/**
 * Quantas notas NOVAS podem sair agora. Na cautela (menos de `cautela` notas
 * nossas autorizadas) é uma por vez: a próxima só depois de a anterior terminar
 * — autorizada, e conferida. Passada a cautela, sem limite além do da rodada.
 *
 * ⚠ "Em voo" é nota enviada que a prefeitura ainda não respondeu. Nota que
 * voltou para "tente depois" não conta: ela nunca saiu, e contá-la travaria a
 * fila inteira para sempre.
 */
export function vagasNaCautela(args: { cautela: number; autorizadas: number; emVoo: number }): number {
  if (args.cautela <= 0 || args.autorizadas >= args.cautela) return Number.POSITIVE_INFINITY;
  return args.emVoo > 0 ? 0 : 1;
}

/**
 * O que a Spedy registrou contra o que planejamos. Valor diferente é a única
 * divergência que desliga: é dinheiro e é nota fiscal. `null` = conferido, ou a
 * Spedy não disse o valor (não dá para concluir nada).
 */
export function divergenciaDeValor(args: {
  cobrancaId: number;
  valorCentavos: number;
  valorNaSpedy: number | null | undefined;
}): string | null {
  if (args.valorNaSpedy == null) return null;
  if (Math.round(args.valorNaSpedy * 100) === args.valorCentavos) return null;
  return (
    `cobrança ${args.cobrancaId}: a Spedy registrou R$ ${args.valorNaSpedy.toFixed(2).replace(".", ",")}` +
    ` e o planejado era R$ ${(args.valorCentavos / 100).toFixed(2).replace(".", ",")}`
  );
}

/**
 * Um problema desta rodada, com a causa dita pelo TIPO e não adivinhada do texto:
 * - `divergencia`: nota AUTORIZADA com valor diferente do planejado. Já é nota
 *   fiscal errada no mundo, e o erro tende a se repetir na próxima.
 * - `recusa`: a Spedy recusou o pedido (4xx). Uma recusa é caso de uma nota; várias
 *   na mesma rodada dizem que é a chave, o formato ou a conta.
 * - `rejeitada`: a prefeitura rejeitou a nota. É caso daquela nota: ela fica
 *   guardada e avisada, e não há motivo para parar as outras.
 */
export type Problema = { tipo: "divergencia" | "recusa" | "rejeitada"; texto: string };

/** Recusas da Spedy numa mesma rodada que passam a ser sinal de defeito geral. */
export const RECUSAS_ATE_DESLIGAR = 3;

/**
 * Se a emissão deve ser desligada, e por quê (frase para quem vai ler na tela).
 *
 * ⚠ Nota NÃO EMITIDA não desliga a emissão (pedido do usuário, 09/10/2026): a
 * rejeição da prefeitura, o cadastro do cliente e a cobrança retida viram aviso
 * por e-mail e ficam guardadas para emitir depois do ajuste, enquanto as outras
 * notas seguem. O que desliga é só o que se repetiria nas próximas:
 * 1. na CAUTELA (menos de `cautela` notas nossas autorizadas), qualquer problema;
 * 2. valor registrado diferente do planejado, sempre — é nota fiscal errada;
 * 3. três recusas da Spedy numa rodada — chave, formato ou conta, não uma nota.
 */
export function motivoParaPausar(args: { emCautela: boolean; problemas: Problema[] }): string | null {
  const { emCautela, problemas } = args;
  if (!problemas.length) return null;

  const divergencias = problemas.filter((p) => p.tipo === "divergencia");
  const recusas = problemas.filter((p) => p.tipo === "recusa");
  let causa: Problema[];
  let abertura: string;
  if (emCautela) {
    causa = problemas;
    abertura = "nas primeiras notas";
  } else if (divergencias.length) {
    causa = divergencias;
    abertura = "valor diferente do planejado";
  } else if (recusas.length >= RECUSAS_ATE_DESLIGAR) {
    causa = recusas;
    abertura = `${recusas.length} recusas da Spedy numa rodada`;
  } else {
    return null;
  }
  const quais = causa.slice(0, 3).map((p) => p.texto).join(" | ");
  const resto = causa.length > 3 ? ` (+${causa.length - 3})` : "";
  return `${abertura}: ${quais}${resto}`.slice(0, 450);
}
