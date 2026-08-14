"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { decifrar } from "@/lib/crypto";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  MediaKind,
  UserRole,
} from "@/generated/prisma/enums";
import {
  lerConfigOpenAI,
  modeloDeDocumento,
  openaiConfigSchema,
} from "@/server/integrations/openai/config";
import {
  criarClienteOpenAI,
  descreverImagem,
  lerDocumento,
  listarModelosDaConta,
  transcreverAudio,
} from "@/server/integrations/openai/client";
import { salvarChaveOpenAI } from "@/server/integrations/openai/credenciais";
import { openaiIntegration } from "@/server/integrations/openai";
import {
  EXTENSOES_DE_AUDIO,
  EXTENSOES_DE_IMAGEM,
  EXTENSOES_DE_PDF,
  EXTENSOES_DE_TEXTO,
  mimeDaExtensao,
} from "@/server/integrations/openai/classificar";
import { linhaDoAnexo } from "@/server/integrations/openai/formato";

export type EstadoOpenAI = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

const PROVIDER = IntegrationProvider.OPENAI;
const ROTULO = "OpenAI — leitura de mídia";

async function registro() {
  return db.integration.findUnique({
    where: { provider: PROVIDER },
    include: { credential: true },
  });
}

export async function salvarConfigOpenAI(
  _estado: EstadoOpenAI,
  formData: FormData,
): Promise<EstadoOpenAI> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = openaiConfigSchema.safeParse({
    baseUrl: String(formData.get("baseUrl") ?? ""),
    modeloVisao: String(formData.get("modeloVisao") ?? ""),
    modeloAudio: String(formData.get("modeloAudio") ?? ""),
    modeloDocumento: String(formData.get("modeloDocumento") ?? ""),
    idiomaAudio: String(formData.get("idiomaAudio") ?? ""),
    lerImagem: formData.get("lerImagem") === "on",
    lerAudio: formData.get("lerAudio") === "on",
    lerDocumento: formData.get("lerDocumento") === "on",
    instrucaoImagem: String(formData.get("instrucaoImagem") ?? ""),
    instrucaoDocumento: String(formData.get("instrucaoDocumento") ?? ""),
    tamanhoMaximoMb: String(formData.get("tamanhoMaximoMb") ?? "20"),
    maxAnexosPorTurno: String(formData.get("maxAnexosPorTurno") ?? "8"),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { config: parsed.data, enabled: formData.get("enabled") === "on" },
    create: {
      provider: PROVIDER,
      label: ROTULO,
      config: parsed.data,
      enabled: formData.get("enabled") === "on",
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.openai.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: "Configuração salva. Lembre de ligar a leitura também na tela de cada agente que tem bot.",
  };
}

export async function salvarChaveDaOpenAI(
  _estado: EstadoOpenAI,
  formData: FormData,
): Promise<EstadoOpenAI> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const chave = String(formData.get("apiKey") ?? "").trim();
  if (chave.length < 20) {
    return {
      erro: "Confira os campos.",
      camposComErro: { apiKey: "Chave muito curta" },
    };
  }

  await salvarChaveOpenAI(chave);

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.openai.credential.rotated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Chave salva. Use o botão de testar para confirmar." };
}

export async function testarConexaoOpenAI(): Promise<EstadoOpenAI> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve a chave da OpenAI antes de testar." };

  const resultado = await openaiIntegration.testarConexao({
    provider: PROVIDER,
    config: (atual.config ?? {}) as Record<string, unknown>,
    credential: decifrar(atual.credential),
    agentId: "",
  });

  await db.integration.update({
    where: { provider: PROVIDER },
    data: {
      // Indeterminado não é falha: chave com escopo restrito não lista modelos
      // e ainda assim transcreve. Marcar erro mandaria trocar credencial boa.
      status: resultado.ok
        ? IntegrationStatus.OK
        : resultado.indeterminado
          ? IntegrationStatus.NOT_CONFIGURED
          : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  return resultado.ok ? { ok: resultado.mensagem } : { erro: resultado.mensagem };
}

/**
 * Modelos que existem na conta, para o operador cadastrar o id certo.
 *
 * A OpenAI não publica qual modelo enxerga imagem ou transcreve — então o que
 * dá para afirmar é "este id existe aqui". A escolha continua sendo de quem
 * configura; a lista só evita erro de digitação.
 */
export async function descobrirModelosOpenAI(): Promise<
  EstadoOpenAI & { modelos?: string[] }
> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve a chave antes de buscar." };

  try {
    const config = lerConfigOpenAI(atual.config);
    const cliente = criarClienteOpenAI(config, decifrar(atual.credential));
    const modelos = await listarModelosDaConta(cliente);

    return modelos.length
      ? { ok: `${modelos.length} modelo(s) nesta conta.`, modelos }
      : { erro: "A conta respondeu, mas não listou nenhum modelo." };
  } catch (erro) {
    return {
      erro:
        erro instanceof Error
          ? `Não consegui listar os modelos: ${erro.message}`
          : "Falha ao buscar modelos.",
    };
  }
}

/**
 * Teste com arquivo de verdade.
 *
 * Existe porque a alternativa é mandar um áudio pelo WhatsApp de produção para
 * saber se a configuração funciona. Mostra exatamente o texto que o agente
 * receberia, marcação e tudo.
 *
 * Não passa pelo cache de propósito: um teste não pode gravar leitura nem
 * consumir a linha de um arquivo que o atendimento vai reencontrar depois.
 */
export async function testarArquivoOpenAI(
  _estado: EstadoOpenAI,
  formData: FormData,
): Promise<EstadoOpenAI & { transcricao?: string; modelo?: string }> {
  await exigirPapel(UserRole.ADMIN);

  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return { erro: "Escolha um arquivo para testar." };
  }

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve a chave da OpenAI antes de testar." };

  const config = lerConfigOpenAI(atual.config);

  const limiteBytes = config.tamanhoMaximoMb * 1024 * 1024;
  if (arquivo.size > limiteBytes) {
    return {
      erro: `O arquivo tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB e o limite configurado é ${config.tamanhoMaximoMb} MB.`,
    };
  }

  const nome = arquivo.name || "arquivo";
  const extensao = nome.includes(".")
    ? nome.slice(nome.lastIndexOf(".") + 1).toLowerCase()
    : "";

  const kind = tipoDoTeste(extensao);
  if (!kind) {
    return {
      erro: `Não sei ler um arquivo .${extensao || "sem extensão"}. Aceito: ${[
        ...EXTENSOES_DE_AUDIO,
        ...EXTENSOES_DE_IMAGEM,
        ...EXTENSOES_DE_PDF,
        ...EXTENSOES_DE_TEXTO,
      ].join(", ")}.`,
    };
  }

  const bytes = Buffer.from(await arquivo.arrayBuffer());
  const dados = {
    bytes,
    mimeType: arquivo.type || mimeDaExtensao(extensao),
    tamanhoBytes: bytes.length,
  };

  try {
    const cliente = criarClienteOpenAI(config, decifrar(atual.credential));

    if (kind === MediaKind.AUDIO) {
      const r = await transcreverAudio({
        cliente,
        arquivo: dados,
        nome,
        model: config.modeloAudio,
        idioma: config.idiomaAudio,
      });
      return pronto(kind, nome, r.texto, r.model);
    }

    if (kind === MediaKind.IMAGE) {
      const r = await descreverImagem({
        cliente,
        arquivo: dados,
        model: config.modeloVisao,
        instrucao: config.instrucaoImagem,
      });
      return pronto(kind, nome, r.texto, r.model);
    }

    if (EXTENSOES_DE_TEXTO.includes(extensao)) {
      return pronto(kind, nome, bytes.toString("utf8"), "leitura-direta");
    }

    const r = await lerDocumento({
      cliente,
      arquivo: dados,
      nome,
      model: modeloDeDocumento(config),
      instrucao: config.instrucaoDocumento,
    });
    return pronto(kind, nome, r.texto, r.model);
  } catch (erro) {
    const status = (erro as { status?: number } | null)?.status;
    if (status === 404) {
      return {
        erro: "A OpenAI respondeu 404: o modelo configurado não existe nesta conta. Confira os ids em Modelos.",
      };
    }
    return {
      erro:
        erro instanceof Error
          ? `Falha ao ler o arquivo: ${erro.message}`
          : "Falha desconhecida ao ler o arquivo.",
    };
  }
}

function pronto(
  kind: MediaKind,
  nome: string,
  texto: string,
  modelo: string,
): EstadoOpenAI & { transcricao?: string; modelo?: string } {
  const limpo = (texto ?? "").trim();
  if (!limpo) {
    return {
      erro: "A leitura funcionou, mas não veio conteúdo nenhum — o arquivo pode estar vazio ou ilegível.",
    };
  }

  return {
    ok: `Leitura concluída com ${modelo}.`,
    // Exatamente o que o agente receberia, marcação e tudo.
    transcricao: linhaDoAnexo({ kind, nome, texto: limpo }),
    modelo,
  };
}

function tipoDoTeste(extensao: string): MediaKind | null {
  if (EXTENSOES_DE_AUDIO.includes(extensao)) return MediaKind.AUDIO;
  if (EXTENSOES_DE_IMAGEM.includes(extensao)) return MediaKind.IMAGE;
  if (EXTENSOES_DE_PDF.includes(extensao) || EXTENSOES_DE_TEXTO.includes(extensao)) {
    return MediaKind.DOCUMENT;
  }
  return null;
}

export type LeituraRecente = {
  id: string;
  kind: MediaKind;
  status: string;
  nomeArquivo: string | null;
  model: string | null;
  texto: string | null;
  erro: string | null;
  inputTokens: number;
  outputTokens: number;
  segundosDeAudio: number | null;
  duracaoMs: number | null;
  createdAt: Date;
};

/**
 * Últimas leituras, para o painel responder "está lendo mesmo?".
 *
 * O texto entra cortado: aqui a pergunta é "funcionou", não "o que dizia" — o
 * conteúdo inteiro aparece na entrada da execução, em Execuções.
 */
export async function leiturasRecentes(limite = 25): Promise<LeituraRecente[]> {
  const linhas = await db.mediaAnalysis.findMany({
    orderBy: { createdAt: "desc" },
    take: limite,
    select: {
      id: true,
      kind: true,
      status: true,
      nomeArquivo: true,
      model: true,
      texto: true,
      erro: true,
      inputTokens: true,
      outputTokens: true,
      segundosDeAudio: true,
      duracaoMs: true,
      createdAt: true,
    },
  });

  return linhas.map((l) => ({
    ...l,
    texto: l.texto ? l.texto.slice(0, 220) : null,
  }));
}
