"use server";

import { UserRole } from "@/generated/prisma/enums";
import { exigirPapel } from "@/server/auth-guard";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { autorDaSessao } from "@/server/gestao/autor";
import {
  atualizarDocumento,
  criarDocumento,
  definirAgentesDoDocumento,
  definirDocumentosDoAgente,
  excluirDocumento,
} from "@/server/conhecimento/servico";
import type { DadosDoDocumento } from "@/server/conhecimento/regras";

/**
 * A porta do painel para os documentos de apoio: papel, formulário e a tradução
 * do resultado. A regra mora em `server/conhecimento/servico.ts`.
 *
 * ⚠ Só função assíncrona pode ser exportada daqui (`use-server.test.ts`).
 */

export type EstadoDoDocumento = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
  /** O documento recém-criado, para a tela saber que pode limpar o formulário. */
  criadoId?: string;
};

export type EstadoDoVinculo = { ok?: string; erro?: string };

function lerFormulario(formData: FormData): DadosDoDocumento {
  return {
    nome: formData.get("nome"),
    descricao: formData.get("descricao"),
    setor: formData.get("setor"),
    texto: formData.get("texto"),
    origem: formData.get("origem"),
  };
}

/** Os agentes marcados na tela — só texto, sem confiar no que não for. */
function agentesMarcados(formData: FormData): string[] {
  return formData
    .getAll("agentes")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Cria o documento e já vincula os agentes marcados. Se o documento entra e o
 * vínculo é recusado (teto de caracteres do agente), diz isso com todas as
 * letras: o documento existe, e ninguém o recebe ainda.
 */
export async function criarNovoDocumento(
  _estado: EstadoDoDocumento,
  formData: FormData,
): Promise<EstadoDoDocumento> {
  return comFalhaVisivel<EstadoDoDocumento>(
    "documento.criar",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);
      const autor = autorDaSessao(sessao);

      const criado = await criarDocumento(lerFormulario(formData), autor);
      if (!criado.ok) {
        return { erro: criado.erro, camposComErro: criado.camposComErro };
      }

      const marcados = agentesMarcados(formData);
      if (marcados.length === 0) {
        return {
          ok: "Documento criado. Nenhum agente o recebe ainda — marque os agentes nele, ou na tela de cada agente.",
          criadoId: criado.id,
        };
      }

      const vinculo = await definirAgentesDoDocumento(criado.id, marcados, autor);
      if ("erro" in vinculo) {
        return {
          ok: "Documento criado, mas nenhum agente o recebe ainda.",
          erro: vinculo.erro,
          criadoId: criado.id,
        };
      }
      return { ok: `Documento criado. ${vinculo.ok}`, criadoId: criado.id };
    },
    (falha) => ({ erro: falha.erro }),
  );
}

export async function salvarDocumento(
  id: string,
  _estado: EstadoDoDocumento,
  formData: FormData,
): Promise<EstadoDoDocumento> {
  return comFalhaVisivel<EstadoDoDocumento>(
    "documento.salvar",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);
      const autor = autorDaSessao(sessao);

      const gravado = await atualizarDocumento(id, lerFormulario(formData), autor);
      if (!gravado.ok) {
        return { erro: gravado.erro, camposComErro: gravado.camposComErro };
      }

      const vinculo = await definirAgentesDoDocumento(id, agentesMarcados(formData), autor);
      if ("erro" in vinculo) {
        return { ok: "Texto salvo.", erro: vinculo.erro };
      }
      return { ok: `Documento salvo. ${vinculo.ok}` };
    },
    (falha) => ({ erro: falha.erro }),
  );
}

export async function apagarDocumento(id: string): Promise<EstadoDoVinculo> {
  return comFalhaVisivel<EstadoDoVinculo>(
    "documento.apagar",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);
      const r = await excluirDocumento(id, autorDaSessao(sessao));
      return "erro" in r ? { erro: r.erro } : { ok: r.ok };
    },
    (falha) => ({ erro: falha.erro }),
  );
}

/** O vínculo pela tela do agente: quais documentos ele recebe. */
export async function definirDocumentosDoAgenteNaTela(
  agentId: string,
  documentoIds: string[],
): Promise<EstadoDoVinculo> {
  return comFalhaVisivel<EstadoDoVinculo>(
    "documento.vincular-ao-agente",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);
      const r = await definirDocumentosDoAgente(
        agentId,
        Array.isArray(documentoIds) ? documentoIds : [],
        autorDaSessao(sessao),
      );
      return "erro" in r ? { erro: r.erro } : { ok: r.ok };
    },
    (falha) => ({ erro: falha.erro }),
  );
}
