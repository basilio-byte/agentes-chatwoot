import { z } from "zod";

/**
 * Configuração das notas fiscais (Spedy) — o que a tela edita.
 *
 * O modo SOMBRA lê as cobranças pagas no Conexa e registra a nota que
 * emitiria, sem chamar a Spedy. É o relatório que a equipe confere contra as
 * notas reais do n8n antes de qualquer corte.
 *
 * A EMISSÃO (`emissao`) é outra chave, e nasce desligada: ligar a integração
 * não emite nada. Ver `emissao/`.
 */

/**
 * Código de serviço no formato da task (`03.03.02`): item, subitem e
 * desdobramento. Quem converte para o formato que o município aceita é a
 * emissão, não a tela.
 */
export const FORMATO_DO_CODIGO = /^\d{2}\.\d{2}\.\d{2}$/;

/** `030302`, `03.03.02` e `03 03 02` viram `03.03.02`; o resto, `null`. */
export function normalizarCodigo(texto: string): string | null {
  const digitos = texto.replace(/[\s.]/g, "");
  if (!/^\d{6}$/.test(digitos)) return null;
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 4)}.${digitos.slice(4, 6)}`;
}

const codigo = z.string().regex(FORMATO_DO_CODIGO);

export const EMPRESAS_DA_SPEDY = ["SEAHUB", "SEATECH"] as const;
export type EmpresaDaSpedy = (typeof EMPRESAS_DA_SPEDY)[number];

/**
 * A emissão de verdade. ⚠ Tudo aqui nasce DESLIGADO e restrito, porque não
 * existe ambiente de teste na Spedy: nota emitida é nota fiscal real e gasta
 * número da sequência da empresa.
 */
export const emissaoSchema = z.object({
  /** Chave geral. Desligada, a rodada nunca chama a Spedy. */
  ligada: z.boolean().default(false),
  /**
   * Emitir SÓ estas cobranças (id no Conexa). É como se faz a primeira nota
   * real: uma cobrança escolhida por uma pessoa, com o n8n sem emitir essa.
   */
  soCobrancas: z.array(z.number().int().positive()).max(200).default([]),
  /**
   * Sem lista, só emite cobrança quitada a partir deste dia (AAAA-MM-DD). É o
   * CORTE com o n8n: o que foi pago antes já teve nota dele, e emitir de novo
   * seria nota em dobro. Sem lista E sem data, nada é emitido.
   */
  aPartirDe: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  /**
   * Deixa a Spedy mandar o e-mail da nota ao tomador. Ligado por padrão porque
   * é o que o n8n faz hoje (`sendEmailToCustomer: true`): o corte não pode
   * tirar do cliente a nota que ele já recebe.
   */
  enviarEmailAoCliente: z.boolean().default(true),
  /**
   * Quem recebe o aviso quando uma nota é REJEITADA pela prefeitura, é recusada
   * pela Spedy ou fica parada por cadastro do cliente. Sem ninguém aqui, o aviso
   * não sai e o problema só aparece na lista da tela.
   */
  emailsDeAviso: z.array(z.string().email().max(120)).max(5).default([]),
  /**
   * CAUTELA: enquanto menos de `cautela` notas NOSSAS tiverem sido autorizadas,
   * as notas saem uma de cada vez — a próxima só depois de a anterior terminar —
   * e qualquer problema (rejeição, recusa da Spedy, valor diferente do
   * planejado) DESLIGA a emissão sozinha. 0 = sem cautela.
   */
  cautela: z.number().int().min(0).max(50).default(3),
  /** Por que a emissão foi desligada sozinha. Salvar a tela apaga: é a pessoa dizendo que viu. */
  pausadaMotivo: z.string().max(500).nullable().default(null),
});

export type EmissaoConfig = z.infer<typeof emissaoSchema>;

export const REGRAS_DE_CLIENTE = ["antes", "nunca"] as const;
export type RegraDeCliente = (typeof REGRAS_DE_CLIENTE)[number];

export const notasFiscaisConfigSchema = z.object({
  /** Só "sombra" por enquanto. Os modos que emitem entram com a Spedy. */
  modo: z.enum(["sombra"]).default("sombra"),
  /**
   * Cobranças pagas a partir deste dia (AAAA-MM-DD, São Paulo). A rodada nunca
   * volta mais que `DIAS_PARA_TRAS`, mesmo com uma data antiga aqui.
   */
  inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  /**
   * Categoria de serviço do Conexa (id) → código de serviço. Categoria fora
   * daqui deixa a cobrança "aguardando classificação": código não é chutado.
   */
  codigos: z.record(z.string().regex(/^\d+$/), codigo).default({}),
  /**
   * O item de reserva de sala não tem categoria: o "produto" dele é a sala, e
   * sala não existe no cadastro de produtos. Vazio = aguardando classificação.
   */
  codigoReservaDeSala: z.union([codigo, z.literal("")]).default(""),
  /**
   * O código da cobrança que NÃO tem venda ligada: parcela de uma venda
   * parcelada (a venda fica na primeira parcela) e pagamento de renegociação.
   * É o "03.03.02 — demais serviços" da task do Laercio, que ele confirmou para
   * este caso (07/10/2026). Vazio = essas cobranças ficam em conferência.
   */
  codigoSemVenda: z.union([codigo, z.literal("")]).default("03.03.02"),
  /**
   * Regras por cliente do Conexa, no lugar dos ids escritos dentro dos `If` do
   * n8n. "antes": a nota sai quando a cobrança é GERADA, e não quando é paga.
   * "nunca": sem nota automática.
   */
  clientes: z
    .array(
      z.object({
        clienteId: z.number().int().positive(),
        regra: z.enum(REGRAS_DE_CLIENTE),
        observacao: z.string().trim().max(120).default(""),
      }),
    )
    .max(300)
    .default([]),
  /**
   * Exceções POR PRODUTO, que vencem a categoria. Existem porque a categoria do
   * Conexa não separa o que a Seahub separa: bebida, Frigobar, Multa e Taxa de
   * reserva estão todos em "Outros Serviços". "sem nota": o item não leva nota
   * de serviço (não há CNAE para ele). "conferir": uma pessoa decide (a multa
   * segue o código do contrato). Ou um código, para esse produto só.
   */
  produtos: z
    .array(
      z.object({
        produtoId: z.number().int().positive(),
        regra: z.union([z.literal("sem nota"), z.literal("conferir"), codigo]),
        observacao: z.string().trim().max(120).default(""),
      }),
    )
    .max(300)
    .default([]),
  /**
   * Qual empresa da Spedy emite as notas de cada unidade do Conexa (`companyId`
   * da cobrança). Conferido na configuração do Conexa em 07/10/2026: 3 é a
   * SEAHUB COWORKING e 4 é a SEATECH. Unidade fora daqui não emite.
   */
  empresas: z
    .record(z.string().regex(/^\d+$/), z.enum(EMPRESAS_DA_SPEDY))
    .default({ "3": "SEAHUB", "4": "SEATECH" }),
  emissao: emissaoSchema.default({
    ligada: false,
    soCobrancas: [],
    aPartirDe: null,
    enviarEmailAoCliente: true,
    emailsDeAviso: [],
    cautela: 3,
    pausadaMotivo: null,
  }),
  /**
   * O aviso do Conexa (`/api/webhooks/conexa/<token>`): a nota sai na hora do
   * pagamento. Guardamos SÓ o hash do token — o endereço inteiro aparece uma vez,
   * quando é gerado. Nulo = o endereço ainda não foi gerado.
   */
  aviso: z
    .object({
      tokenHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .default(null),
      geradoEm: z.string().nullable().default(null),
    })
    .default({ tokenHash: null, geradoEm: null }),
});

export type NotasFiscaisConfig = z.infer<typeof notasFiscaisConfigSchema>;

/**
 * A config gravada, com os padrões no que faltar. Só o formulário grava, e ele
 * valida antes: config inválida aqui é linha mexida à mão, e cai nos padrões.
 */
export function lerConfigNotasFiscais(bruto: unknown): NotasFiscaisConfig {
  const lido = notasFiscaisConfigSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : notasFiscaisConfigSchema.parse({});
}

/** A regra do cliente, ou `null` quando ele segue o padrão (nota ao pagar). */
export function regraDoCliente(
  config: Pick<NotasFiscaisConfig, "clientes">,
  clienteId: number,
): RegraDeCliente | null {
  return config.clientes.find((c) => c.clienteId === clienteId)?.regra ?? null;
}

/** As regras por cliente como a tela mostra: uma por linha, `3245 antes observação`. */
export function clientesEmTexto(config: Pick<NotasFiscaisConfig, "clientes">): string {
  return config.clientes
    .map((c) => [c.clienteId, c.regra, c.observacao].filter(Boolean).join(" "))
    .join("\n");
}

/**
 * Lê as regras por cliente do texto da tela. Uma linha inválida recusa tudo,
 * dizendo qual: gravar só as linhas boas apagaria em silêncio a regra que a
 * pessoa digitou errado.
 */
export function lerClientes(
  texto: string,
): { clientes: NotasFiscaisConfig["clientes"] } | { erro: string } {
  const clientes: NotasFiscaisConfig["clientes"] = [];
  const vistos = new Set<number>();
  const linhas = texto.replace(/\r\n/g, "\n").split("\n");
  for (const [i, bruta] of linhas.entries()) {
    const linha = bruta.trim();
    if (!linha) continue;
    const m = /^(\d+)\s+(antes|nunca)\b\s*(.*)$/i.exec(linha);
    if (!m) {
      return {
        erro: `Regras por cliente, linha ${i + 1} ("${linha.slice(0, 40)}"): use "id do cliente no Conexa", espaço, "antes" ou "nunca".`,
      };
    }
    const clienteId = Number(m[1]);
    if (vistos.has(clienteId)) {
      return { erro: `Regras por cliente: o cliente ${clienteId} aparece mais de uma vez.` };
    }
    vistos.add(clienteId);
    clientes.push({
      clienteId,
      regra: m[2].toLowerCase() as RegraDeCliente,
      observacao: m[3].trim().slice(0, 120),
    });
  }
  return { clientes };
}

/** Ids de cobrança, separados por espaço, vírgula ou linha. Um inválido recusa tudo. */
export function lerCobrancasLiberadas(
  texto: string,
): { ids: number[] } | { erro: string } {
  const ids: number[] = [];
  for (const parte of texto.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(parte) || Number(parte) <= 0) {
      return { erro: `Cobranças liberadas: "${parte.slice(0, 20)}" não é um id de cobrança do Conexa.` };
    }
    const id = Number(parte);
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

/** E-mails de aviso, separados por espaço, vírgula, ponto e vírgula ou linha. */
export function lerEmailsDeAviso(texto: string): { emails: string[] } | { erro: string } {
  const emails: string[] = [];
  for (const parte of texto.split(/[\s,;]+/).filter(Boolean)) {
    if (!z.string().email().safeParse(parte).success) {
      return { erro: `E-mails de aviso: "${parte.slice(0, 40)}" não é um e-mail válido.` };
    }
    const normal = parte.toLowerCase();
    if (!emails.includes(normal)) emails.push(normal);
  }
  if (emails.length > 5) return { erro: "E-mails de aviso: no máximo 5 destinatários." };
  return { emails };
}

export type RegraDeProduto = NotasFiscaisConfig["produtos"][number]["regra"];

/** A exceção do produto, ou `null` quando vale a categoria. */
export function regraDoProduto(
  config: Pick<NotasFiscaisConfig, "produtos">,
  produtoId: number | null,
): RegraDeProduto | null {
  if (produtoId === null) return null;
  return config.produtos.find((p) => p.produtoId === produtoId)?.regra ?? null;
}

/** As exceções por produto como a tela mostra: uma por linha, `2799 sem nota Red Bull`. */
export function produtosEmTexto(config: Pick<NotasFiscaisConfig, "produtos">): string {
  return config.produtos
    .map((p) => [p.produtoId, p.regra, p.observacao].filter(Boolean).join(" "))
    .join("\n");
}

/**
 * Lê as exceções por produto do texto da tela. Mesma doutrina das regras por
 * cliente: uma linha inválida recusa tudo, dizendo qual.
 */
export function lerProdutos(
  texto: string,
): { produtos: NotasFiscaisConfig["produtos"] } | { erro: string } {
  const produtos: NotasFiscaisConfig["produtos"] = [];
  const vistos = new Set<number>();
  for (const [i, bruta] of texto.split(/\r?\n/).entries()) {
    const linha = bruta.trim();
    if (!linha) continue;
    const m = /^(\d+)\s+(sem\s+nota|conferir|\d{2}\.\d{2}\.\d{2}|\d{6})(?=\s|$)\s*(.*)$/i.exec(linha);
    if (!m) {
      return {
        erro: `Regras por produto, linha ${i + 1} ("${linha.slice(0, 40)}"): use "id do produto no Conexa", espaço, "sem nota", "conferir" ou um código como 03.03.02.`,
      };
    }
    const produtoId = Number(m[1]);
    if (vistos.has(produtoId)) {
      return { erro: `Regras por produto: o produto ${produtoId} aparece mais de uma vez.` };
    }
    vistos.add(produtoId);
    const palavra = m[2].toLowerCase().replace(/\s+/g, " ");
    const regra = palavra === "sem nota" || palavra === "conferir" ? palavra : normalizarCodigo(palavra)!;
    produtos.push({ produtoId, regra, observacao: m[3].trim().slice(0, 120) });
  }
  return { produtos };
}

/**
 * O formulário vira config, ou a primeira recusa em texto para quem preencheu.
 *
 * Os códigos chegam em campos `codigo_<id da categoria>`; campo vazio tira a
 * categoria da tabela. O que a tela não mostra fica como estava.
 */
export function configDoFormulario(
  campos: Record<string, string>,
  atual: NotasFiscaisConfig,
): { config: NotasFiscaisConfig } | { erro: string } {
  const valor = (campo: string) => (campos[campo] ?? "").trim();

  const codigos: Record<string, string> = {};
  for (const [campo, bruto] of Object.entries(campos)) {
    const m = /^codigo_(\d+)$/.exec(campo);
    if (!m || !bruto.trim()) continue;
    const normal = normalizarCodigo(bruto);
    if (!normal) {
      return { erro: `Categoria ${m[1]}: "${bruto.trim()}" não é um código no formato 03.03.02.` };
    }
    codigos[m[1]] = normal;
  }

  const sala = valor("codigoReservaDeSala");
  const codigoDaSala = sala ? normalizarCodigo(sala) : "";
  if (codigoDaSala === null) {
    return { erro: `Reserva de sala: "${sala}" não é um código no formato 03.03.02.` };
  }

  // Formulário que não traz o campo (versão antiga da tela) não apaga o código.
  const semVenda = campos.codigoSemVenda === undefined ? atual.codigoSemVenda : valor("codigoSemVenda");
  const codigoSemVenda = semVenda ? normalizarCodigo(semVenda) : "";
  if (codigoSemVenda === null) {
    return { erro: `Cobrança sem venda: "${semVenda}" não é um código no formato 03.03.02.` };
  }

  const clientes = lerClientes(campos.clientes ?? "");
  if ("erro" in clientes) return clientes;

  const produtos = lerProdutos(campos.produtos ?? "");
  if ("erro" in produtos) return produtos;

  const cobrancas = lerCobrancasLiberadas(campos.soCobrancas ?? "");
  if ("erro" in cobrancas) return cobrancas;

  const emails = lerEmailsDeAviso(campos.emailsDeAviso ?? "");
  if ("erro" in emails) return emails;

  const emissao = {
    emailsDeAviso: emails.emails,
    ligada: campos.emissaoLigada === "on",
    soCobrancas: cobrancas.ids,
    aPartirDe: valor("aPartirDe") || null,
    enviarEmailAoCliente: campos.enviarEmailAoCliente === "on",
    cautela: valor("cautela") === "" ? 3 : Number(valor("cautela")),
    pausadaMotivo: null,
  };
  if (!Number.isInteger(emissao.cautela) || emissao.cautela < 0 || emissao.cautela > 50) {
    return { erro: "Cautela: informe um número inteiro de 0 a 50 (0 = sem cautela)." };
  }
  if (emissao.ligada && !emissao.soCobrancas.length && !emissao.aPartirDe) {
    return {
      erro: "Emissão ligada: informe as cobranças liberadas OU o dia do corte com o n8n. Sem nenhum dos dois nada seria emitido.",
    };
  }

  const lido = notasFiscaisConfigSchema.safeParse({
    ...atual,
    emissao,
    inicio: valor("inicio") || null,
    codigos,
    codigoReservaDeSala: codigoDaSala,
    codigoSemVenda,
    clientes: clientes.clientes,
    produtos: produtos.produtos,
  });
  if (!lido.success) {
    const chave = String(lido.error.issues[0]?.path?.[0] ?? "");
    return { erro: `${chave === "inicio" ? "Início" : chave}: valor inválido.` };
  }
  return { config: lido.data };
}
