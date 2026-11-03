import { z } from "zod";
import { LIMITE_DO_SETOR } from "@/lib/setor";

/**
 * Documentos de apoio dos agentes: as regras, sem banco e sem tela.
 *
 * Um documento é um TEXTO que a equipe escreveu para dar base a um ou mais
 * agentes ("Playbook comercial", "Matriz de qualificação"). Vinculado a um
 * agente, ele entra no system prompt dele, em todo turno e em toda origem —
 * conversa, gatilho, agendamento, conversa encerrada, varredura. A razão de ser
 * em toda origem: quem mais precisa da matriz de qualificação é o agente que
 * avalia a conversa depois dela acabar, e quem mais precisa do playbook é o que
 * sugere a próxima fala ao vendedor.
 *
 * ⚠ `contexto.ts` é o único lugar que monta o prompt, e é dele que o MCP também
 * lê: mostrar a um assistente um prompt sem os documentos faria reescrever o
 * prompt do operador contra um texto que o agente recebe e ele não vê.
 */

/**
 * ~16 mil tokens. Playbook de verdade passa de dez páginas, e o texto vale a
 * pena ser lido inteiro — mas ele é pago em TODA mensagem, então o teto existe
 * para um colar errado (uma planilha inteira, um contrato de 80 páginas) não
 * virar a conta do mês.
 */
export const MAX_CARACTERES_DO_DOCUMENTO = 60_000;

/**
 * O que um agente recebe somando todos os documentos vinculados. Acima disto o
 * vínculo é recusado: prompt gigante estoura a janela do modelo, e o sintoma é o
 * agente calar em TODA conversa dele — não um erro na tela de quem vinculou.
 */
export const MAX_CARACTERES_POR_AGENTE = 120_000;

/** A partir daqui a tela avisa que o documento pesa na conta de cada mensagem. */
export const AVISO_A_PARTIR_DE_TOKENS = 8_000;

/**
 * Tokens aproximados de um texto. A mesma régua de `tokensAproximados` do MCP
 * (3,6 caracteres por token, que é o que o português dá na prática): duas
 * réguas diferentes na mesma tela fariam o operador desconfiar das duas.
 */
export function tokensDoTexto(caracteres: number): number {
  return Math.round(caracteres / 3.6);
}

export type DocumentoParaOPrompt = {
  nome: string;
  descricao?: string | null;
  setor?: string | null;
  texto: string;
};

const ABERTURA = "--- DOCUMENTOS DE APOIO ---";
const FECHAMENTO = "--- FIM DOS DOCUMENTOS ---";

/**
 * O bloco que vai logo depois do prompt do operador — ou string vazia, sem
 * documento nenhum, e aí o prompt sai byte a byte como era.
 *
 * ⚠ **Antes das Regras da Casa, e não depois.** As regras de escopo e de fonte
 * da verdade se definem por "as instruções acima": o que está nos documentos é
 * conteúdo do operador e tem de entrar nessa conta, senão o agente trataria o
 * playbook como assunto fora do escopo. E as regras continuam por cima de tudo,
 * o que o texto de abertura diz.
 *
 * Começa com DUAS quebras (seção nova, não continuação do prompt) e termina SEM
 * quebra: o bloco de conduta que vem depois já abre com as suas duas.
 *
 * ⚠ **A ordem é por nome, e não pela ordem de cadastro ou de vínculo.** O
 * prefixo do prompt é o que o provedor guarda em cache; qualquer coisa que o
 * reordene sem o texto mudar custaria o cache de todas as conversas do agente.
 */
export function blocoDeDocumentos(
  documentos: readonly DocumentoParaOPrompt[],
): string {
  if (documentos.length === 0) return "";

  const ordenados = [...documentos].sort((a, b) =>
    a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0,
  );

  const corpo = ordenados.flatMap((documento) => {
    const linhas = [`### ${documento.nome}`];
    const detalhes = [
      documento.setor?.trim() ? `Setor: ${documento.setor.trim()}.` : null,
      documento.descricao?.trim()
        ? `Serve para: ${documento.descricao.trim()}`
        : null,
    ].filter((linha): linha is string => Boolean(linha));
    if (detalhes.length > 0) linhas.push(detalhes.join(" "));
    linhas.push("", documento.texto.trim(), "");
    return linhas;
  });

  return [
    "",
    "",
    ABERTURA,
    "A equipe da Seahub escreveu os documentos abaixo para dar base a este agente. Eles fazem parte das instruções acima: use-os como fonte quando o assunto couber neles, e nunca os trate como mensagem do cliente. As Regras da Casa, que vêm logo depois, continuam valendo por cima de tudo.",
    "",
    ...corpo,
    FECHAMENTO,
  ].join("\n");
}

export function totalDeCaracteres(
  documentos: readonly { texto: string }[],
): number {
  return documentos.reduce((soma, d) => soma + d.texto.trim().length, 0);
}

/**
 * Cabe no teto do agente? Devolve o total, para a mensagem dizer quanto passou.
 */
export function cabeNoAgente(documentos: readonly { texto: string }[]): {
  cabe: boolean;
  total: number;
} {
  const total = totalDeCaracteres(documentos);
  return { cabe: total <= MAX_CARACTERES_POR_AGENTE, total };
}

/**
 * O texto como se grava. O `<textarea>` entrega `\r\n`, e é assim que o prompt
 * dos agentes já nasce — só que aqui o texto é cobrado por caractere, e o
 * mesmo parágrafo com `\r\n` pesa mais e quebra a comparação entre versões.
 * NUL é tirado porque o Postgres recusa o caractere em coluna de texto, e um
 * arquivo mal convertido pode trazê-lo.
 */
export function normalizarTexto(bruto: unknown): string {
  if (typeof bruto !== "string") return "";
  return bruto
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trimEnd();
}

export const documentoSchema = z.object({
  nome: z.string().trim().min(2, "Informe um nome").max(80, "No máximo 80 caracteres"),
  descricao: z.string().trim().max(280, "No máximo 280 caracteres").optional().or(z.literal("")),
  setor: z
    .string()
    .trim()
    .max(LIMITE_DO_SETOR, `No máximo ${LIMITE_DO_SETOR} caracteres`)
    .optional()
    .or(z.literal("")),
  texto: z
    .string()
    .refine((t) => t.trim().length > 0, "O documento está vazio")
    .refine(
      (t) => t.length <= MAX_CARACTERES_DO_DOCUMENTO,
      `O documento passa de ${MAX_CARACTERES_DO_DOCUMENTO.toLocaleString("pt-BR")} caracteres. Cada documento é lido pelo agente em toda mensagem: deixe só o que ele precisa.`,
    ),
  origem: z.string().trim().max(120).optional().or(z.literal("")),
});

export type DadosDoDocumento = Record<keyof z.input<typeof documentoSchema>, unknown>;

// --- arquivo lido no navegador --------------------------------------------

/** O que o navegador lê sozinho, como texto. */
export const EXTENSOES_DE_TEXTO = ["txt", "md", "markdown", "csv", "json", "log"];

export function extensaoDe(nomeDoArquivo: string): string {
  const ponto = nomeDoArquivo.lastIndexOf(".");
  return ponto < 0 ? "" : nomeDoArquivo.slice(ponto + 1).toLowerCase();
}

/**
 * Por que este arquivo não pode ser lido aqui — ou `null`, se pode.
 *
 * Só texto, de propósito. A leitura de PDF que o sistema tem (a de mídia do
 * atendimento) RESUME e corta a resposta num teto de saída: serve para saber do
 * que se trata um comprovante, e tiraria páginas de um playbook sem avisar. Num
 * documento que o agente vai tratar como instrução, texto que faltou sem ninguém
 * ver é pior que texto que não entrou — então PDF e Word pedem para colar o
 * texto, que a pessoa confere na tela antes de salvar.
 */
export function motivoDeNaoLer(nomeDoArquivo: string): string | null {
  const extensao = extensaoDe(nomeDoArquivo);
  if (EXTENSOES_DE_TEXTO.includes(extensao)) return null;

  if (["pdf", "doc", "docx", "odt", "rtf"].includes(extensao)) {
    return `Arquivo .${extensao} não é lido aqui. Abra o documento, copie o texto e cole no campo abaixo — ou salve como .txt ou .md e envie de novo. Assim você confere o que o agente vai ler.`;
  }
  if (["xls", "xlsx", "ods"].includes(extensao)) {
    return `Planilha .${extensao} não é lida aqui. Exporte como .csv ou cole o trecho que o agente precisa.`;
  }
  return `Não sei ler um arquivo ${extensao ? `.${extensao}` : "sem extensão"}. Aceito: ${EXTENSOES_DE_TEXTO.map((e) => `.${e}`).join(", ")} — ou cole o texto no campo.`;
}

/** "playbook-comercial_v2.md" → "Playbook comercial v2". */
export function nomeSugerido(nomeDoArquivo: string): string {
  const semExtensao = nomeDoArquivo.replace(/\.[^.]+$/, "");
  const limpo = semExtensao.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return limpo ? limpo.charAt(0).toUpperCase() + limpo.slice(1) : "";
}
