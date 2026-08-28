import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tokensAproximadosDaTool } from "@/server/integrations/resolve";
import { googleIntegration } from "./index";

/**
 * O catálogo é contrato com duas partes: com o modelo (nome, descrição e
 * schema) e com a tela do agente (categoria e `requiresConfirmation`). Mexer
 * nele sem passar por aqui quebra uma das duas em silêncio — nome duplicado
 * some do mapa de tools, categoria faltando cai num grupo solto, e schema que o
 * `z.toJSONSchema` não converte só estoura na hora da chamada.
 */

const tools = googleIntegration.tools;
const nomes = tools.map((t) => t.name);

describe("catálogo do Google Workspace", () => {
  it("todo nome é único e prefixado pelo provider", () => {
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const nome of nomes) expect(nome.startsWith("google_"), nome).toBe(true);
  });

  it("toda tool tem categoria e descrição prescritiva", () => {
    for (const t of tools) {
      expect(t.categoria, t.name).toBeTruthy();
      // Descrição curta demais não ensina o modelo a escolher — e aqui escolher
      // errado grava numa planilha que não tem desfazer.
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });

  it("as tools de uma categoria ficam juntas — a UI agrupa na ordem do catálogo", () => {
    const sequencia = tools.map((t) => String(t.categoria));
    const primeiraOcorrencia = [...new Set(sequencia)];

    // Se uma categoria reaparecer depois de outra ter começado, a tela cria
    // dois grupos com o mesmo título e o operador liga metade das tools sem
    // perceber que existe a outra metade.
    expect(sequencia).toEqual(
      primeiraOcorrencia.flatMap((c) => sequencia.filter((s) => s === c)),
    );
  });

  /**
   * `requiresConfirmation` é o que marca "escreve" na interface. A lista fica
   * travada inteira de propósito: tool nova obriga a decidir conscientemente de
   * que lado ela está.
   */
  it("exatamente estas tools escrevem no Google", () => {
    const escrevem = tools
      .filter((t) => t.requiresConfirmation)
      .map((t) => t.name)
      .sort();

    expect(escrevem).toEqual([
      "google_docs_anexar_texto",
      "google_docs_criar_de_modelo",
      "google_sheets_adicionar_linha",
      "google_sheets_atualizar_linha",
    ]);
  });

  it("nenhuma consulta pede confirmação", () => {
    // ⚠ O verbo pode terminar o nome: `google_docs_ler` não tem sufixo nenhum.
    // Um padrão como `_(listar|ver)_` deixaria essa tool de fora justamente
    // porque ela é a mais curta, e o teste passaria sem ter olhado para ela.
    const deConsulta = /_(listar|ver|ler|buscar|procurar)(_|$)/;
    const consultas = tools.filter((t) => deConsulta.test(t.name));

    // Trava contra o regex que não casa com nada e passa vazio.
    expect(consultas.map((t) => t.name)).toContain("google_docs_ler");
    expect(consultas.length).toBeGreaterThan(4);

    for (const t of consultas) {
      expect(t.requiresConfirmation, t.name).toBeFalsy();
    }
  });

  /**
   * Política, não descuido: não existe tool de exclusão nem de
   * compartilhamento.
   *
   * Dar a um modelo que lê mensagem de cliente o poder de apagar um arquivo ou
   * de conceder acesso a terceiros é risco sem contrapartida — nenhum caso de
   * uso do atendimento precisa disso, e nenhum dos dois tem desfazer. Mesmo
   * tratamento que o `DELETE` da ZapSign recebeu.
   */
  it("não existe tool que apaga arquivo", () => {
    const perigosas = nomes.filter((n) =>
      /excluir|apagar|remover|deletar|lixeira/.test(n),
    );

    expect(perigosas).toEqual([]);
  });

  it("não existe tool que mexe em permissão ou compartilhamento", () => {
    const perigosas = nomes.filter((n) => /permiss|compartilh|acesso/.test(n));

    expect(perigosas).toEqual([]);
  });

  it("todo inputSchema vira JSON Schema — senão só estoura na hora da chamada", () => {
    for (const t of tools) {
      const gerado = () =>
        z.toJSONSchema(t.inputSchema, { io: "input" }) as Record<string, unknown>;

      expect(gerado, t.name).not.toThrow();
      expect(gerado().type, t.name).toBe("object");
    }
  });

  it("o catálogo inteiro cabe no orçamento de tokens", () => {
    const total = tools.reduce((soma, t) => soma + tokensAproximadosDaTool(t), 0);

    // As tools entram no prefixo de TODA mensagem de todo agente que tiver a
    // integração ligada. O teto existe pelo mesmo motivo do teto do bloco de
    // conduta: para a próxima pessoa pensar antes de acrescentar um parágrafo
    // numa descrição, e não para impedir que o catálogo cresça.
    //
    // Referências para calibrar: as 32 tools do ClickUp somam ~3,9k e o bloco
    // de conduta ~840. Subiu de 2400 para 2600 depois da revisão adversarial,
    // que cobrou três instruções que faltavam e custam token: consultar o
    // modelo antes de gerar documento, continuar a leitura pelo `proximaLinha`
    // e não afirmar registro depois de uma falha ambígua. Cada uma delas troca
    // tokens por um desfecho errado a menos — mas a folga é de ~220, então
    // acrescentar a quarta exige decidir o que sai.
    expect(total).toBeLessThan(2600);
  });

  it("o caminho mínimo do caso de uso existe", () => {
    // Descobrir o cabeçalho, conferir se a linha já existe e só então gravar.
    // Sem qualquer um dos três, o agente ou grava em coluna que não existe ou
    // cadastra o mesmo cliente duas vezes — e a planilha aceita duplicata sem
    // reclamar.
    for (const necessaria of [
      "google_sheets_ver_estrutura",
      "google_sheets_procurar_linha",
      "google_sheets_adicionar_linha",
    ]) {
      expect(nomes).toContain(necessaria);
    }
  });
});
