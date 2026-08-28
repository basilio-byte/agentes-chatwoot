import { z } from "zod";

/**
 * Configuração da integração com o Google Workspace.
 *
 * A credencial é o **JSON inteiro** da chave de conta de serviço, cifrado num
 * blob só — `IntegrationCredential.integrationId` é `@unique`, então não cabe
 * mais de um segredo por integração. Mesmo padrão de `AgentChatwootBot`, que
 * guarda `{token, webhookSecret}` num ciphertext só.
 */

/**
 * Escopos pedidos no JWT.
 *
 * ⚠ **`drive.file` NÃO serve aqui**, por mais que pareça o escopo prudente. Ele
 * cobre "arquivos que o app abriu", e abrir significa o Google Picker, no
 * navegador. Um worker headless nunca abre nada: a planilha compartilhada por
 * e-mail com a conta de serviço fica **invisível**, com `403
 * appNotAuthorizedToFile`. Escolher o escopo restrito "por segurança" produz um
 * agente que não enxerga nada.
 *
 * E `drive` numa conta de serviço não é "todo o Drive da empresa": é só o que
 * alguém compartilhou com aquele e-mail. Quem restringe é o compartilhamento,
 * não o escopo.
 */
export const ESCOPOS = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
] as const;

/**
 * O endpoint de token do fluxo JWT Bearer.
 *
 * ⚠ Constante, e **não** o `token_uri` que vem dentro do JSON da chave. O JSON
 * traz `https://accounts.google.com/o/oauth2/token`, que é o endereço antigo; o
 * `aud` do assertion e o destino do POST precisam ser este. Ler do arquivo
 * funciona hoje e quebra no dia em que o Google mudar o que emite.
 */
export const URL_DO_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * O que precisa existir dentro do JSON da chave para ela servir.
 *
 * Validado no momento de colar, não na hora de usar: uma chave errada
 * descoberta no meio de um atendimento vira `invalid_grant` cru no retorno da
 * tool — e o operador não tem como saber que colou o arquivo de outro projeto.
 */
export const chaveDeServicoSchema = z.object({
  type: z.literal("service_account", {
    message:
      'O JSON não é de uma conta de serviço (o campo "type" precisa ser "service_account"). Pode ser o arquivo de credencial OAuth, que é outro.',
  }),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().includes("BEGIN PRIVATE KEY", {
    message: "A chave privada do JSON parece truncada.",
  }),
  client_email: z.string().min(3),
});

export type ChaveDeServico = z.infer<typeof chaveDeServicoSchema>;

/** Um item de cadastro: o nome que o agente usa e o id que a API usa. */
const cadastroSchema = z.array(
  z.object({ nome: z.string().min(1), id: z.string().min(1) }),
);

export const googleConfigSchema = z.object({
  /**
   * Planilhas por nome — "Controle de documentos" em vez do id cru.
   *
   * O modelo nunca vê um id, aqui como no ClickUp e na ZapSign. Id no prompt é
   * frágil (muda se alguém recriar o arquivo), ilegível na revisão da execução,
   * e obrigaria o agente a gastar uma iteração de descoberta antes de toda
   * gravação — que é exatamente o defeito que derrubou os campos personalizados
   * do ClickUp.
   */
  planilhas: cadastroSchema.default([]),

  /** Documentos do Google Docs que o agente pode ler ou acrescentar texto. */
  documentos: cadastroSchema.default([]),

  /** Modelos de documento, para gerar um arquivo novo a partir deles. */
  modelos: cadastroSchema.default([]),

  /** Pastas do Drive que o agente pode listar. */
  pastas: cadastroSchema.default([]),

  /**
   * Id do Drive compartilhado onde arquivos novos são criados.
   *
   * ⚠ **Sem ele, criar arquivo é impossível — e não por configuração nossa.**
   * A conta de serviço tem quota de armazenamento **zero** e não pode ser dona
   * de arquivo nenhum; o Google devolve `403 storageQuotaExceeded`. Pôr a pasta
   * de destino em `parents` não resolve: quem cria é o dono, e quem cria é a
   * conta de serviço. Só um Drive compartilhado, onde o dono é a organização,
   * resolve.
   *
   * Vazio é estado legítimo: ler e escrever no que já existe não cria arquivo
   * nenhum e funciona sem isto. Quem cobra é só a tool de gerar documento.
   */
  driveCompartilhadoId: z.string().trim().default(""),

  /**
   * Teto de linhas/itens devolvidos numa leitura.
   *
   * Não é economia de rede, é economia de contexto: o histórico é relido
   * inteiro a cada turno, então uma planilha de mil linhas despejada no retorno
   * de uma tool é cobrada em toda mensagem seguinte da conversa.
   */
  limiteDeLinhas: z.coerce.number().int().min(10).max(2000).default(200),

  /**
   * E-mail de um usuário a personificar (domain-wide delegation).
   *
   * Nasce vazio e assim deve ficar. Existe para um cenário específico: se o
   * Admin do Workspace restringiu compartilhamento a domínios confiáveis, a
   * conta de serviço é bloqueada — o e-mail dela termina em
   * `gserviceaccount.com`, e o Google não permite cadastrar esse domínio como
   * confiável. Aí não há como compartilhar a planilha com ela, e o único
   * caminho é personificar alguém.
   *
   * ⚠ Preencher isto amplia o alcance para tudo que aquela pessoa enxerga, e
   * exige cadastrar o Client ID e os escopos no Admin console. Não é o caminho
   * padrão.
   */
  personificar: z.string().trim().default(""),
});

export type GoogleConfig = z.output<typeof googleConfigSchema>;

/**
 * Lê a config guardada, sempre com defaults.
 *
 * Nunca falha, pelo mesmo motivo de `lerConfigOpenAI` e de `atendeInbox`:
 * config pela metade tem de continuar gravando na planilha que ESTÁ cadastrada.
 * Transformar campo esquecido em silêncio é o pior desfecho possível.
 */
export function lerConfigGoogle(bruto: unknown): GoogleConfig {
  const parsed = googleConfigSchema.safeParse(bruto ?? {});
  if (parsed.success) return parsed.data;
  return googleConfigSchema.parse({});
}

/** As quatro listas de cadastro, pelo nome do campo. */
export type TipoDeCadastro = "planilhas" | "documentos" | "modelos" | "pastas";

const ROTULO: Record<TipoDeCadastro, string> = {
  planilhas: "planilha",
  documentos: "documento",
  modelos: "modelo",
  pastas: "pasta",
};

export function rotuloDoCadastro(tipo: TipoDeCadastro): string {
  return ROTULO[tipo];
}

/**
 * Acha o id pelo nome cadastrado.
 *
 * A comparação ignora caixa, acento e espaço repetido: o operador cadastra
 * "Controle de Documentos" e o modelo escreve "controle de documentos" —
 * recusar por causa disso queimaria uma iteração para nada.
 *
 * ⚠ **Não aceita id cru**, ao contrário do `resolverModelo` da ZapSign. Lá o
 * token tem forma de uuid e dá para reconhecer; aqui o id do Google é uma
 * string opaca qualquer, e aceitar "o que parece id" abriria a porta para o
 * modelo escrever numa planilha que ninguém cadastrou — inclusive uma que ele
 * alucinou. O cadastro é a allowlist de arquivos, e allowlist com porta lateral
 * não é allowlist.
 */
export function resolverCadastro(
  termo: string | undefined,
  config: GoogleConfig,
  tipo: TipoDeCadastro,
): { id?: string; nomes: string[] } {
  const lista = config[tipo];
  const nomes = lista.map((item) => item.nome);
  if (!termo) return { nomes };

  const alvo = normalizarNome(termo);
  const achado = lista.find((item) => normalizarNome(item.nome) === alvo);
  return achado ? { id: achado.id, nomes } : { nomes };
}

/**
 * Tira acento, caixa e espaço repetido — para comparar nome escrito por humano.
 *
 * ⚠ **NFKD, e não NFD como no resto do repositório.** O NFD desfaz só
 * decomposição canônica, e `º`/`ª` têm decomposição de **compatibilidade** — ele
 * não os toca. Aqui isso importa porque o que se compara é cabeçalho de planilha
 * brasileira: `"Nº do CPF"` é escrita comum, o modelo digita `"No do CPF"`, e
 * com NFD a gravação inteira aborta por "coluna desconhecida". O desfecho é
 * seguro, mas custa uma iteração e faz o agente parecer teimoso por causa de um
 * caractere.
 *
 * A diferença com `slug.ts` e `clickup/formatacao.ts` é deliberada: lá se
 * normaliza nome de pessoa e de agente, onde ordinal não aparece.
 */
export function normalizarNome(bruto: string): string {
  return bruto
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // marcas de acento separadas pela decomposição
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
