import { z } from "zod";

/**
 * Configuração das notas fiscais (Spedy) — o que a tela edita.
 *
 * Por enquanto só existe o modo SOMBRA: o sistema lê as cobranças pagas no
 * Conexa e registra a nota que emitiria, sem chamar a Spedy. É o relatório que
 * a equipe confere contra as notas reais do n8n antes de qualquer corte.
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

  const clientes = lerClientes(campos.clientes ?? "");
  if ("erro" in clientes) return clientes;

  const lido = notasFiscaisConfigSchema.safeParse({
    ...atual,
    inicio: valor("inicio") || null,
    codigos,
    codigoReservaDeSala: codigoDaSala,
    clientes: clientes.clientes,
  });
  if (!lido.success) {
    const chave = String(lido.error.issues[0]?.path?.[0] ?? "");
    return { erro: `${chave === "inicio" ? "Início" : chave}: valor inválido.` };
  }
  return { config: lido.data };
}
