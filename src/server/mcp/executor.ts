import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserRole } from "@/generated/prisma/enums";
import { logger } from "@/lib/logger";
import { alcancaPapel, rotuloDoPapel } from "@/lib/papeis";
import type {
  AnotacoesDeFerramenta,
  Executor,
  FerramentaPublica,
  ResultadoDeFerramenta,
} from "./protocolo";

/**
 * O que liga o protocolo às ferramentas: papel, validação e falha.
 *
 * Três garantias, e todas antes de a ferramenta rodar:
 *
 * 1. **Papel relido da conta.** Leitura nem vê as ferramentas de escrita na
 *    lista; e se chamar uma pelo nome, recebe a recusa dizendo o porquê.
 * 2. **Parâmetro desconhecido é ERRO.** Toda entrada é `z.strictObject`. É o
 *    contrário do que as tools dos agentes fazem hoje — lá o Zod descarta a
 *    chave desconhecida em silêncio, e foi assim que o CRM criou tarefas sem
 *    campo nenhum por semanas. Aqui o assistente descobre na hora.
 * 3. **Falha inesperada não vira silêncio nem vazamento.** A mensagem interna
 *    vai para o log com um código; o assistente recebe o código e o aviso de
 *    que o estado pode ter mudado.
 */

export type ContextoMcp = {
  tokenId: string;
  usuario: { id: string; nome: string; email: string; papel: UserRole };
  /** `https://host`, para montar os links do painel e da mesa. */
  baseUrl: string;
};

export type FerramentaMcp = {
  name: string;
  title: string;
  description: string;
  /** Papel mínimo. Consulta é VIEWER; o que muda produção é ADMIN. */
  papel: UserRole;
  anotacoes: AnotacoesDeFerramenta;
  entrada: z.ZodType;
  executar: (args: unknown, ctx: ContextoMcp) => Promise<ResultadoDeFerramenta>;
};

/** Amarra o tipo dos argumentos ao schema de entrada. */
export function ferramenta<S extends z.ZodType>(
  definicao: Omit<FerramentaMcp, "entrada" | "executar"> & {
    entrada: S;
    executar: (
      args: z.output<S>,
      ctx: ContextoMcp,
    ) => Promise<ResultadoDeFerramenta>;
  },
): FerramentaMcp {
  return definicao as unknown as FerramentaMcp;
}

const esquemas = new WeakMap<FerramentaMcp, Record<string, unknown>>();

function esquemaDe(f: FerramentaMcp): Record<string, unknown> {
  let esquema = esquemas.get(f);
  if (!esquema) {
    esquema = z.toJSONSchema(f.entrada, { io: "input" }) as Record<string, unknown>;
    delete esquema.$schema;
    esquemas.set(f, esquema);
  }
  return esquema;
}

/** A recusa de validação escrita para quem vai corrigir a chamada. */
export function explicarRecusa(issues: z.ZodIssue[], aceitos: string[]): string {
  const linhas = issues.map((issue) => {
    const onde = issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      const nomes = issue.keys.join(", ");
      return issue.keys.length > 1
        ? `Parâmetros desconhecidos${onde ? ` em ${onde}` : ""}: ${nomes}.`
        : `Parâmetro desconhecido${onde ? ` em ${onde}` : ""}: ${nomes}.`;
    }
    // A frase padrão do Zod ("expected string, received undefined") não diz
    // ao modelo o que ele fez de errado: esqueceu o parâmetro.
    if (issue.code === "invalid_type" && /received undefined/.test(issue.message)) {
      return `${onde || "(raiz)"}: obrigatório, e não foi enviado.`;
    }
    return onde ? `${onde}: ${issue.message}` : issue.message;
  });

  return [
    "Parâmetros recusados — nada foi feito.",
    ...linhas,
    ...(aceitos.length > 0 ? [`Parâmetros aceitos: ${aceitos.join(", ")}.`] : []),
  ].join("\n");
}

export function criarExecutor(
  catalogo: FerramentaMcp[],
  ctx: ContextoMcp,
): Executor {
  // Ordem estável: a especificação pede lista determinística, e o cliente pode
  // cachear o prefixo do prompt que monta com ela.
  const ordenado = [...catalogo].sort((a, b) => a.name.localeCompare(b.name));

  return {
    listar(): FerramentaPublica[] {
      return ordenado
        .filter((f) => alcancaPapel(ctx.usuario.papel, f.papel))
        .map((f) => ({
          name: f.name,
          title: f.title,
          description: f.description,
          inputSchema: esquemaDe(f),
          annotations: { ...f.anotacoes },
        }));
    },

    async chamar(nome, argumentos) {
      const f = ordenado.find((x) => x.name === nome);
      if (!f) return null;

      const inicio = Date.now();
      const saida = await executarUma(f, argumentos, ctx);

      // Rastro de toda chamada, e não só das que alteram (essas já vão para a
      // auditoria): "o que o assistente andou lendo" também é pergunta de
      // quem investiga.
      logger.info(
        {
          ferramenta: nome,
          tokenId: ctx.tokenId,
          userId: ctx.usuario.id,
          recusada: Boolean(saida.erro),
          duracaoMs: Date.now() - inicio,
        },
        "mcp: ferramenta chamada",
      );
      return saida;
    },
  };
}

async function executarUma(
  f: FerramentaMcp,
  argumentos: unknown,
  ctx: ContextoMcp,
): Promise<ResultadoDeFerramenta> {
  if (!alcancaPapel(ctx.usuario.papel, f.papel)) {
    return {
      erro: true,
      texto: `${f.name} exige o papel ${rotuloDoPapel(f.papel)}, e o token pertence a uma conta de ${rotuloDoPapel(ctx.usuario.papel)}. Nada foi feito.`,
    };
  }

  const lido = f.entrada.safeParse(argumentos);
  if (!lido.success) {
    const propriedades = esquemaDe(f).properties;
    const aceitos =
      propriedades && typeof propriedades === "object"
        ? Object.keys(propriedades)
        : [];
    return { erro: true, texto: explicarRecusa(lido.error.issues, aceitos) };
  }

  try {
    return await f.executar(lido.data, ctx);
  } catch (erro) {
    const codigo = randomUUID().slice(0, 8);
    logger.error(
      { erro, ferramenta: f.name, tokenId: ctx.tokenId, codigo },
      "mcp: ferramenta falhou",
    );
    return {
      erro: true,
      texto: `Falha inesperada em ${f.name} (código ${codigo}, registrado no log do servidor). Não dá para garantir que nada tenha sido alterado: confira o estado com uma ferramenta de consulta antes de tentar de novo.`,
    };
  }
}
