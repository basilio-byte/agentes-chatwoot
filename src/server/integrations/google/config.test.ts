import { describe, expect, it } from "vitest";
import {
  chaveDeServicoSchema,
  lerConfigGoogle,
  normalizarNome,
  resolverCadastro,
} from "./config";

/**
 * A configuração é a **allowlist de arquivos** desta integração.
 *
 * Duas coisas se testam aqui, e as duas são de segurança antes de serem de
 * conveniência: que ler config quebrada nunca derruba o turno (config pela
 * metade tem de continuar gravando na planilha que ESTÁ cadastrada), e que a
 * resolução por nome **não** tem porta lateral por id — allowlist com porta
 * lateral não é allowlist.
 */

const PADRAO = {
  planilhas: [],
  documentos: [],
  modelos: [],
  pastas: [],
  driveCompartilhadoId: "",
  limiteDeLinhas: 200,
  personificar: "",
};

describe("lerConfigGoogle", () => {
  it("nunca lança: ausente, nulo e vazio viram os defaults", () => {
    // Esta função roda dentro do turno, com cliente esperando. Uma exceção
    // aqui não é "config inválida" na tela: é o atendimento morrendo antes de
    // chamar o modelo, com um erro que ninguém relaciona à integração.
    expect(lerConfigGoogle(undefined)).toEqual(PADRAO);
    expect(lerConfigGoogle(null)).toEqual(PADRAO);
    expect(lerConfigGoogle({})).toEqual(PADRAO);
  });

  it("nunca lança com campo de tipo errado nem com lixo no lugar do objeto", () => {
    expect(() => lerConfigGoogle({ planilhas: "não é lista" })).not.toThrow();
    expect(lerConfigGoogle({ planilhas: "não é lista" })).toEqual(PADRAO);
    expect(lerConfigGoogle({ planilhas: [{ nome: "", id: "" }] })).toEqual(PADRAO);
    expect(lerConfigGoogle("texto solto")).toEqual(PADRAO);
    expect(lerConfigGoogle(42)).toEqual(PADRAO);
    expect(lerConfigGoogle([])).toEqual(PADRAO);
  });

  it("config pela metade continua servindo a planilha que ESTÁ cadastrada", () => {
    // Este é o caso real: alguém cadastrou a planilha e nunca abriu o resto da
    // tela. Recusar a config inteira por causa dos campos que ninguém tocou
    // transformaria campo esquecido em silêncio — o pior desfecho possível.
    const config = lerConfigGoogle({
      planilhas: [{ nome: "Controle de Documentos", id: "abc123" }],
    });

    expect(config.planilhas).toEqual([
      { nome: "Controle de Documentos", id: "abc123" },
    ]);
    expect(config.documentos).toEqual([]);
    expect(config.limiteDeLinhas).toBe(200);
    expect(config.driveCompartilhadoId).toBe("");
  });

  it("limite de linhas fora da faixa cai no default", () => {
    // O teto não é economia de rede, é de contexto: o histórico é relido
    // inteiro a cada turno, então uma planilha despejada no retorno da tool é
    // cobrada em toda mensagem seguinte da conversa.
    expect(lerConfigGoogle({ limiteDeLinhas: 5 }).limiteDeLinhas).toBe(200);
    expect(lerConfigGoogle({ limiteDeLinhas: 0 }).limiteDeLinhas).toBe(200);
    expect(lerConfigGoogle({ limiteDeLinhas: 5000 }).limiteDeLinhas).toBe(200);
    expect(lerConfigGoogle({ limiteDeLinhas: 12.5 }).limiteDeLinhas).toBe(200);
  });

  it("limite dentro da faixa é respeitado, inclusive vindo do formulário como texto", () => {
    // `<input type="number">` entrega string. Sem a coerção, todo salvamento
    // da tela devolveria a config ao default sem ninguém pedir.
    expect(lerConfigGoogle({ limiteDeLinhas: 50 }).limiteDeLinhas).toBe(50);
    expect(lerConfigGoogle({ limiteDeLinhas: "50" }).limiteDeLinhas).toBe(50);
  });

  it("as strings vêm com trim", () => {
    // Id de Drive colado da barra de endereço vem com espaço na ponta, e um
    // `driveCompartilhadoId` com espaço vira 404 na criação do arquivo — erro
    // que aponta para o id errado em vez de para o espaço invisível.
    const config = lerConfigGoogle({
      driveCompartilhadoId: "  0ALtY9x7Kq  ",
      personificar: " pessoa@seahub.com.br \n",
    });

    expect(config.driveCompartilhadoId).toBe("0ALtY9x7Kq");
    expect(config.personificar).toBe("pessoa@seahub.com.br");
  });
});

describe("chaveDeServicoSchema", () => {
  const CHAVE = {
    type: "service_account",
    project_id: "seahub-agentes",
    private_key_id: "0d1f7a3c9b2e4f5a6b7c8d9e0f1a2b3c4d5e6f70",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----\n",
    client_email: "agentes@seahub-agentes.iam.gserviceaccount.com",
    client_id: "112233445566778899000",
    token_uri: "https://accounts.google.com/o/oauth2/token",
  };

  const mensagemDe = (bruto: unknown, campo: string): string => {
    const parsed = chaveDeServicoSchema.safeParse(bruto);
    expect(parsed.success).toBe(false);
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((i) => i.path[0] === campo);
    expect(issue, `nenhum problema apontado em "${campo}"`).toBeDefined();
    return issue!.message;
  };

  it("aceita um JSON de conta de serviço bem formado", () => {
    const parsed = chaveDeServicoSchema.safeParse(CHAVE);
    expect(parsed.success).toBe(true);
  });

  it("⚠ não carrega o `token_uri` do arquivo adiante", () => {
    // O JSON do Google traz o endereço ANTIGO
    // (`accounts.google.com/o/oauth2/token`), e tanto o `aud` do assertion
    // quanto o destino do POST precisam ser a constante `URL_DO_TOKEN`. Ler do
    // arquivo funciona hoje e quebra no dia em que o Google mudar o que emite.
    const parsed = chaveDeServicoSchema.parse(CHAVE);
    expect(parsed).not.toHaveProperty("token_uri");
    expect(parsed).not.toHaveProperty("client_id");
  });

  it("recusa o arquivo de credencial OAuth, dizendo que é outro arquivo", () => {
    // É o erro mais comum de quem baixa credencial no Google Cloud: os dois
    // são JSON, os dois se chamam "chave". "Inválido" mandaria o operador
    // rotacionar uma credencial que está boa — só é do tipo errado.
    const mensagem = mensagemDe({ ...CHAVE, type: "authorized_user" }, "type");
    expect(mensagem).toContain("OAuth");
    expect(mensagem).toContain("service_account");
  });

  it("recusa chave privada truncada", () => {
    // Colar só o miolo do PEM, sem as linhas de BEGIN/END, é o que acontece
    // quando alguém copia do meio do arquivo. Descoberto na hora de usar, isso
    // viraria `invalid_grant` cru no retorno da tool, no meio de um
    // atendimento — e o operador não teria como saber o que colou errado.
    const soOMiolo = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ==";
    expect(mensagemDe({ ...CHAVE, private_key: soOMiolo }, "private_key")).toContain(
      "truncada",
    );
    expect(mensagemDe({ ...CHAVE, private_key: "" }, "private_key")).toContain(
      "truncada",
    );
  });

  it("cobra os campos que o fluxo JWT usa", () => {
    // `private_key_id` vira o `kid` do cabeçalho e `client_email` vira o
    // `iss`: sem eles a assinatura sai, o Google recusa, e a mensagem de lá
    // fala em assinatura inválida — apontando para a chave, não para o campo
    // que faltou.
    for (const campo of ["project_id", "private_key_id", "client_email"]) {
      const parsed = chaveDeServicoSchema.safeParse({ ...CHAVE, [campo]: "" });
      expect(parsed.success, campo).toBe(false);
    }
  });
});

describe("resolverCadastro", () => {
  const ID_DA_PLANILHA = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

  const CONFIG = lerConfigGoogle({
    planilhas: [
      { nome: "Controle de Documentos", id: ID_DA_PLANILHA },
      { nome: "Relatório Mensal", id: "1zZ7QxYtPlanilha" },
    ],
    documentos: [{ nome: "Manual da Recepção", id: "1DocManual" }],
  });

  it("acha ignorando caixa, acento e espaço repetido", () => {
    // O operador cadastra "Controle de Documentos" e o modelo escreve o que
    // leu na conversa. Recusar por causa de uma maiúscula queimaria uma
    // iteração — e `maxToolIterations` é o teto que já derrubou os campos
    // personalizados do ClickUp.
    expect(resolverCadastro("controle de documentos", CONFIG, "planilhas").id).toBe(
      ID_DA_PLANILHA,
    );
    expect(resolverCadastro("Relatorio  Mensal", CONFIG, "planilhas").id).toBe(
      "1zZ7QxYtPlanilha",
    );
    expect(resolverCadastro("  MANUAL DA RECEPCAO  ", CONFIG, "documentos").id).toBe(
      "1DocManual",
    );
  });

  it("⚠ NÃO aceita id cru, mesmo o id verdadeiro de uma planilha cadastrada", () => {
    // Ao contrário do `resolverModelo` da ZapSign, onde o token tem forma de
    // uuid e dá para reconhecer. Aqui o id do Google é uma string opaca
    // qualquer: aceitar "o que parece id" deixaria o modelo escrever numa
    // planilha que ninguém cadastrou — inclusive uma cujo id ele alucinou.
    const achado = resolverCadastro(ID_DA_PLANILHA, CONFIG, "planilhas");
    expect(achado.id).toBeUndefined();
    expect(achado.nomes).toEqual(["Controle de Documentos", "Relatório Mensal"]);
  });

  it("termo ausente devolve só os nomes, sem escolher um por conta própria", () => {
    // É como a tool descobre o que existe. Devolver a primeira planilha aqui
    // faria uma chamada exploratória gravar em algum lugar.
    const r = resolverCadastro(undefined, CONFIG, "planilhas");
    expect(r.id).toBeUndefined();
    expect(r.nomes).toEqual(["Controle de Documentos", "Relatório Mensal"]);
    expect(resolverCadastro("", CONFIG, "planilhas").id).toBeUndefined();
  });

  it("devolve a lista de nomes junto, mesmo quando acha", () => {
    // A recusa precisa nomear o que existe para o modelo se corrigir no mesmo
    // turno; devolver sempre evita que quem chama tenha de montar a lista.
    expect(resolverCadastro("Controle de Documentos", CONFIG, "planilhas")).toEqual({
      id: ID_DA_PLANILHA,
      nomes: ["Controle de Documentos", "Relatório Mensal"],
    });
    expect(resolverCadastro("Planilha que não existe", CONFIG, "planilhas")).toEqual({
      nomes: ["Controle de Documentos", "Relatório Mensal"],
    });
  });

  it("cada tipo enxerga só a própria lista", () => {
    // Documento cadastrado não vira planilha por acidente: a API é outra e o
    // erro do lado do Google seria opaco.
    expect(resolverCadastro("Manual da Recepção", CONFIG, "planilhas").id).toBeUndefined();
    expect(resolverCadastro("qualquer coisa", CONFIG, "modelos").nomes).toEqual([]);
    expect(resolverCadastro("qualquer coisa", CONFIG, "pastas").nomes).toEqual([]);
  });
});

describe("normalizarNome", () => {
  it("tira acento, caixa e espaço repetido", () => {
    expect(normalizarNome("Relatório  MENSAL ")).toBe("relatorio mensal");
    expect(normalizarNome("  ÁÉÍÓÚ Ç Ã  ")).toBe("aeiou c a");
    expect(normalizarNome("Observação\tdo\ncliente")).toBe("observacao do cliente");
  });

  it("`º` e `ª` viram letra — é por isso que a decomposição aqui é NFKD", () => {
    // NFD desfaz só decomposição CANÔNICA, e `º` (U+00BA) tem decomposição de
    // COMPATIBILIDADE. Com NFD, o cabeçalho "Nº do CPF" de uma planilha
    // brasileira não casava com "No do CPF", que é o que o modelo digita, e a
    // gravação inteira era recusada por "coluna desconhecida".
    //
    // A diferença para `slug.ts` e `clickup/formatacao.ts`, que usam NFD, é
    // deliberada: lá se normaliza nome de pessoa e de agente, onde ordinal não
    // aparece. Aqui se normaliza cabeçalho de planilha, onde aparece.
    expect(normalizarNome("Nº do CPF")).toBe("no do cpf");
    expect(normalizarNome("Nº do CPF")).toBe(normalizarNome("No do CPF"));
    expect(normalizarNome("1ª Parcela")).toBe(normalizarNome("1a parcela"));
  });
});
