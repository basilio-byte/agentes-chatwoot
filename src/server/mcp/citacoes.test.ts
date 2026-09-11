import { describe, expect, it } from "vitest";
import { conferirCitacoes } from "./citacoes";

const catalogo = new Set([
  "clickup_criar_tarefa",
  "clickup_excluir_tarefa",
  "registrar_nota_interna",
  "transferir_para_agente",
]);

describe("o que o prompt cita e o agente não consegue fazer", () => {
  it("separa o que está ligado do que existe mas não está ligado", () => {
    const prompt =
      "Crie com clickup_criar_tarefa, registre com registrar_nota_interna e devolva com transferir_para_agente.";
    const r = conferirCitacoes(
      prompt,
      catalogo,
      new Set(["clickup_criar_tarefa", "transferir_para_agente"]),
    );
    expect(r.ligadas).toEqual(["clickup_criar_tarefa", "transferir_para_agente"]);
    expect(r.naoLigadas).toEqual(["registrar_nota_interna"]);
  });

  it("não inventa ferramenta a partir de palavra com sublinhado que não está no catálogo", () => {
    const r = conferirCitacoes("use o campo nome_cliente", catalogo, new Set());
    expect(r.naoLigadas).toEqual([]);
  });

  it("pega os parâmetros do n8n que o CRM de Atendimentos usava", () => {
    // O caso real: a tarefa nascia com sucesso e sem campo nenhum.
    const prompt =
      "Envie na criação: custom_fields com os IDs, e assignee com o ID do membro. Use o conversation_id.";
    const r = conferirCitacoes(prompt, catalogo, new Set());
    expect(r.parametrosSuspeitos.map((p) => p.citado).sort()).toEqual([
      "assignee",
      "conversation_id",
      "custom_fields",
    ]);
    expect(r.parametrosSuspeitos.find((p) => p.citado === "custom_fields")?.certo).toMatch(
      /camposPersonalizados/,
    );
  });

  it("não confunde assignee com assignees nem com palavra maior", () => {
    const r = conferirCitacoes("o reassignee não conta", catalogo, new Set());
    expect(r.parametrosSuspeitos).toEqual([]);
  });
});
