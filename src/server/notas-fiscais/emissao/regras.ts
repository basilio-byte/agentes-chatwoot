import type { CorpoDeNota } from "@/server/integrations/spedy/client";
import type { NotasFiscaisConfig } from "../config";
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

const semAcento = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

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
  if (t.cep.length !== 8) {
    p.push(t.cep ? `o CEP do cadastro (${t.cep}) não tem 8 dígitos` : "o cadastro está sem CEP");
    return p;
  }
  if (cep.estado === "inexistente") {
    p.push(`o CEP ${t.cep} do cadastro não existe`);
  } else if (cep.estado === "ok" && t.cidade && semAcento(cep.cidade) !== semAcento(t.cidade)) {
    p.push(`o CEP ${t.cep} é de ${cep.cidade}, mas o cadastro diz ${t.cidade}`);
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

export function montarCorpo(args: {
  nota: Pick<NotaPlanejada, "chave" | "codigo" | "valorCentavos" | "descricao" | "competencia">;
  tomador: Tomador;
  cep: CepLido;
  /** Dia de hoje em São Paulo (AAAA-MM-DD). */
  hoje: string;
  enviarEmailAoCliente: boolean;
}): CorpoDeNota {
  const { nota, tomador: t, cep } = args;
  const cidade = cep.estado === "ok" ? { code: cep.ibge ?? undefined, name: cep.cidade, state: cep.uf.toLowerCase() } : t.cidade
    ? { name: cortar(t.cidade, 60), state: t.uf ? t.uf.toLowerCase() : undefined }
    : undefined;

  // E-mail que não cabe não é cortado: um e-mail pela metade é outro endereço.
  const email = t.email && t.email.length <= LIMITES.email && /^\S+@\S+\.\S+$/.test(t.email) ? t.email : undefined;
  const fone = t.telefone && t.telefone.length >= 10 ? cortar(t.telefone, LIMITES.telefone) : undefined;
  const complemento = cortar(t.complemento, LIMITES.complemento);

  return {
    integrationId: cortar(nota.chave, LIMITES.integrationId),
    issue: true,
    sendEmailToCustomer: args.enviarEmailAoCliente && !!email,
    effectiveDate: dataDeCompetencia(nota.competencia, args.hoje),
    description: cortar(nota.descricao, LIMITES.descricao),
    nationalTaxationCode: codigoNacional(nota.codigo),
    receiver: {
      name: cortar(t.nome, LIMITES.nome),
      federalTaxNumber: t.documento,
      email,
      phoneNumber: fone,
      address: {
        postalCode: t.cep,
        street: cortar(t.rua, LIMITES.rua) || undefined,
        number: cortar(t.numero, LIMITES.numero) || "S/N",
        district: cortar(t.bairro, LIMITES.bairro) || undefined,
        additionalInformation: complemento || undefined,
        country: "BRA",
        city: cidade,
      },
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

/** Minutos que uma nota pode ficar na fila da prefeitura antes de virar motivo de olhar. */
export const MINUTOS_NA_FILA = 30;

export function resumoDaNota(n: { codigo: string; valorCentavos: number; chave: string }): string {
  return `${n.chave} (${n.codigo}, ${formatarReais(n.valorCentavos)})`;
}
