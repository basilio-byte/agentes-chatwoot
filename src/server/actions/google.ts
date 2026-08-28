"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { cifrar, decifrar, gerarHint } from "@/lib/crypto";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import {
  chaveDeServicoSchema,
  googleConfigSchema,
  lerConfigGoogle,
  normalizarNome,
  rotuloDoCadastro,
  type TipoDeCadastro,
} from "@/server/integrations/google/config";
import { GoogleClient } from "@/server/integrations/google/client";
import { lerChave } from "@/server/integrations/google";

export type EstadoGoogle = {
  ok?: string;
  erro?: string;
  /**
   * Nem sucesso nem falha — o teste não conseguiu decidir.
   *
   * Existe porque `GoogleClient.testar()` devolve `indeterminado` quando a
   * chave funciona e não há arquivo cadastrado para provar mais nada. Pintar
   * isso de vermelho mandaria o operador rotacionar uma credencial que está
   * boa; pintar de verde afirmaria um acesso que ninguém verificou.
   */
  atencao?: string;
  camposComErro?: Record<string, string>;
  /**
   * `client_email` da chave recém-salva.
   *
   * Volta no estado do formulário para o endereço aparecer na hora, sem
   * esperar a página recarregar: é ele que o operador precisa colar no
   * compartilhamento de cada arquivo, e é o passo que costuma ser esquecido.
   */
  contaEmail?: string;
};

const PROVIDER = IntegrationProvider.GOOGLE;
const ROTULO = "Google Workspace";

async function registro() {
  return db.integration.findUnique({
    where: { provider: PROVIDER },
    include: { credential: true },
  });
}

/**
 * Lê uma lista de cadastro do textarea: `nome = id`, uma por linha.
 *
 * Mesmo formato das listas nomeadas do ClickUp, do Conexa e da ZapSign, e pelo
 * mesmo motivo: o id do arquivo do Google só aparece na URL dele, é opaco, e
 * id cru no prompt é frágil e ilegível na revisão da execução.
 *
 * O corte é no PRIMEIRO sinal de igual e o `join` devolve todo o resto: é o id
 * inteiro, sem risco de cortar um sinal fora e gravar um id que dá 404.
 *
 * ⚠ **Linha malformada não é mais descartada em silêncio.** Era, e o silêncio
 * saía caro: a caixa continua exibindo a linha que NÃO foi gravada — o texto
 * vive no estado do cliente e a ação não o rebobina —, e a mensagem de sucesso
 * somava tudo num número só. O operador saía convencido de ter cadastrado a
 * planilha, e semanas depois o agente respondia que ela não existe, sem erro
 * nenhum no meio do caminho.
 *
 * ⚠ **Nome com `=` dentro também é recusado, e é o id que denuncia**: o id do
 * Google é base64url e nunca traz esse sinal, então um segundo `=` na linha só
 * pode ter vindo do nome — que o corte no primeiro sinal partiu ao meio.
 * Gravado assim, ficaria meio nome apontando para um id que não existe.
 */
function lerCadastro(texto: string): {
  itens: { nome: string; id: string }[];
  descartadas: string[];
} {
  const itens: { nome: string; id: string }[] = [];
  const descartadas: string[] = [];

  for (const bruto of texto.split(/[\r\n]+/)) {
    const linha = bruto.trim();
    if (!linha) continue; // linha em branco é digitação, não erro

    const [nomeBruto, ...resto] = linha.split("=");
    const nome = (nomeBruto ?? "").trim();
    const id = resto.join("=").trim();

    if (!nome || !id || id.includes("=")) {
      descartadas.push(linha);
      continue;
    }

    itens.push({ nome, id });
  }

  return { itens, descartadas };
}

/** Quantas linhas recusadas cabem na mensagem antes de ela virar um muro. */
const LINHAS_NA_MENSAGEM = 5;

/**
 * O que há de errado numa lista de cadastro, em texto para o operador.
 *
 * Duas recusas, e as duas acabam no mesmo lugar quando passam batido: o agente
 * sem alcançar o arquivo — ou alcançando o errado — com a tela dizendo que
 * está tudo salvo.
 *
 * 1. Linha fora do formato `nome = id`. Devolvida **nomeando a linha**: "3
 *    linhas foram ignoradas" não diz qual, e o operador reenvia o mesmo texto.
 * 2. Dois cadastros com o mesmo nome. `resolverCadastro` faz `lista.find`, e
 *    `find` para no primeiro: acrescentar `Controle = 1NOVO` na virada de ano
 *    sem apagar `Controle = 1VELHO` manda toda gravação para a planilha do ano
 *    passado, com o agente confirmando que gravou. A comparação usa a **mesma**
 *    `normalizarNome` que resolve em tempo de execução — validar por outra
 *    regra (igualdade crua, por exemplo) deixaria passar justamente a colisão
 *    que morde na hora de gravar, que é a de acento, caixa e espaço repetido.
 */
function conferirLista(
  lida: { itens: { nome: string }[]; descartadas: string[] },
  tipo: TipoDeCadastro,
): string | null {
  const problemas: string[] = [];

  if (lida.descartadas.length > 0) {
    const mostradas = lida.descartadas
      .slice(0, LINHAS_NA_MENSAGEM)
      .map((linha) => `"${linha}"`)
      .join(", ");
    const resto =
      lida.descartadas.length > LINHAS_NA_MENSAGEM
        ? ` e mais ${lida.descartadas.length - LINHAS_NA_MENSAGEM}`
        : "";

    problemas.push(
      `Nada foi gravado: ${lida.descartadas.length} linha(s) fora do formato nome = id — ${mostradas}${resto}. Confira se o nome tem "=" dentro: o id do Google não usa esse sinal, então o segundo "=" da linha parte o nome ao meio.`,
    );
  }

  const vistos = new Map<string, string>();
  for (const item of lida.itens) {
    const chave = normalizarNome(item.nome);
    const anterior = vistos.get(chave);

    if (anterior !== undefined) {
      problemas.push(
        `Dois cadastros de ${rotuloDoCadastro(tipo)} com o mesmo nome: "${anterior}" e "${item.nome}". Na hora de gravar vence sempre o primeiro, em silêncio — apague o que não vale mais, ou dê nomes de verdade diferentes (a comparação ignora acento, caixa e espaço repetido).`,
      );
      break;
    }

    vistos.set(chave, item.nome);
  }

  return problemas.length > 0 ? problemas.join(" ") : null;
}

/**
 * Campo numérico vazio é AUSENTE, nunca zero.
 *
 * ⚠ `formData.get` devolve `""` para um input em branco, e não `null`: o `??`
 * não protege nada, e `z.coerce.number()` faz `Number("") === 0`, que o
 * `.min(10)` recusa. Quem apagasse o número para redigitá-lo e salvasse perdia
 * o formulário inteiro — as quatro listas, o Drive compartilhado e o checkbox —
 * por causa de um campo em branco. Com `undefined` vale o `.default()` do
 * schema, que é o mesmo valor que a tela mostrava antes de ele apagar.
 */
function numeroOuPadrao(valor: FormDataEntryValue | null): string | undefined {
  const texto = String(valor ?? "").trim();
  return texto === "" ? undefined : texto;
}

/**
 * Mensagem de validação por CAMPO, e não pelo caminho inteiro do Zod.
 *
 * O `path` de uma issue numa lista de cadastro vem como `planilhas.0.id`, que
 * não casa com o `name` de campo nenhum da tela. O formulário anunciaria
 * "confira os campos" sem destacar nenhum — exatamente o defeito que o `Field`
 * de `ui.tsx` existe para não repetir.
 */
function camposComErro(issues: { path: PropertyKey[]; message: string }[]) {
  return Object.fromEntries(
    issues.map((i) => [String(i.path[0] ?? ""), i.message]),
  );
}

export async function salvarConfigGoogle(
  _estado: EstadoGoogle,
  formData: FormData,
): Promise<EstadoGoogle> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const listas = {
    planilhas: lerCadastro(String(formData.get("planilhas") ?? "")),
    documentos: lerCadastro(String(formData.get("documentos") ?? "")),
    modelos: lerCadastro(String(formData.get("modelos") ?? "")),
    pastas: lerCadastro(String(formData.get("pastas") ?? "")),
  };

  const errosDasListas: Record<string, string> = {};
  for (const tipo of Object.keys(listas) as TipoDeCadastro[]) {
    const problema = conferirLista(listas[tipo], tipo);
    if (problema) errosDasListas[tipo] = problema;
  }

  const parsed = googleConfigSchema.safeParse({
    planilhas: listas.planilhas.itens,
    documentos: listas.documentos.itens,
    modelos: listas.modelos.itens,
    pastas: listas.pastas.itens,
    driveCompartilhadoId: String(formData.get("driveCompartilhadoId") ?? ""),
    // ⚠ Não é `?? "200"`: um input vazio chega como `""`, e o `??` só pega
    // `null`. Ver `numeroOuPadrao` — o `""` cru fazia o formulário INTEIRO ser
    // recusado, com a mensagem em inglês do Zod.
    limiteDeLinhas: numeroOuPadrao(formData.get("limiteDeLinhas")),
    personificar: String(formData.get("personificar") ?? ""),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      // As duas origens de recusa no mesmo objeto: o Zod fala dos campos
      // simples e `errosDasListas` fala das quatro caixas de cadastro. O do Zod
      // entra por último de propósito — tendo os dois algo a dizer sobre a
      // mesma lista, quem manda é o schema, que é quem decide o que é gravado.
      camposComErro: {
        ...errosDasListas,
        ...camposComErro(parsed.error.issues),
      },
    };
  }

  // Recusa que o Zod não vê: as listas passam pelo schema (são pares válidos),
  // e o que está errado é o que ficou de FORA delas — a linha que não virou par
  // e o nome cadastrado duas vezes. Gravar assim é gravar pela metade dizendo
  // que deu certo, que é o defeito de origem desta tela.
  if (Object.keys(errosDasListas).length > 0) {
    return { erro: "Confira os campos.", camposComErro: errosDasListas };
  }

  // Lido ANTES do upsert: é a única chance de saber que `personificar` mudou.
  const anterior = await registro();
  const personificarAntes = lerConfigGoogle(anterior?.config).personificar;

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
      action: "integration.google.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  // ⚠ `personificar` é o único campo deste formulário que muda QUEM a
  // credencial é: preenchido, toda chamada passa a agir como aquela pessoa e
  // alcança tudo o que ela enxerga — inclusive arquivo que ninguém compartilhou
  // com a conta de serviço. Dentro de `integration.google.updated` isso fica
  // indistinguível de uma troca de limite de linhas; à parte, a auditoria
  // responde quando a personificação começou e quando parou.
  if (parsed.data.personificar !== personificarAntes) {
    await db.auditLog.create({
      data: {
        userId: sessao.user.id,
        action: parsed.data.personificar
          ? "integration.google.impersonation.set"
          : "integration.google.impersonation.cleared",
        entity: "Integration",
        entityId: PROVIDER,
        diff: { de: personificarAntes, para: parsed.data.personificar },
      },
    });
  }

  revalidatePath("/integracoes");

  const total =
    parsed.data.planilhas.length +
    parsed.data.documentos.length +
    parsed.data.modelos.length +
    parsed.data.pastas.length;

  // A mensagem NOMEIA o que foi gravado e lembra dos três passos que ficam fora
  // desta tela, cada um capaz de fazer o agente parecer quebrado:
  //
  // 1. Cadastrar o id não concede acesso nenhum — quem concede é o
  //    compartilhamento no Drive, e é ele que falta quando o agente diz que não
  //    encontrou o arquivo.
  // 2. O toggle é de dois níveis: ligado aqui e desligado no agente, nenhuma
  //    tool do Google chega ao modelo (molde de `actions/openai.ts`).
  // 3. ⚠ Sem a LEITURA DE MÍDIA ligada — global e no agente da porta —, o caso
  //    de uso principal morre antes de começar: mensagem que chega só com um
  //    PDF ou um áudio não vira job nenhum, e o sintoma é silêncio. Não dá para
  //    inferir isso de tela nenhuma, por isso vai escrito aqui.
  return {
    ok: `Configuração salva: ${total} arquivo(s) cadastrado(s). Cada um precisa estar compartilhado com a conta de serviço, como Editor — cadastrar aqui não dá acesso. Lembre de ligar esta integração também na tela de cada agente, e a leitura de mídia junto: sem ela, a mensagem que chega só com um PDF ou um áudio não vira atendimento nenhum.`,
  };
}

export async function salvarChaveGoogle(
  _estado: EstadoGoogle,
  formData: FormData,
): Promise<EstadoGoogle> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const bruto = String(formData.get("chaveJson") ?? "").trim();
  if (!bruto) {
    return {
      erro: "Confira os campos.",
      camposComErro: { chaveJson: "Cole o JSON da chave." },
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(bruto);
  } catch {
    return {
      erro: "Confira os campos.",
      camposComErro: {
        chaveJson:
          "Isto não é um JSON válido. Cole o arquivo baixado do Google Cloud inteiro, da primeira à última chave, sem editar nada.",
      },
    };
  }

  // ⚠ Validar ANTES de cifrar. Chave errada guardada só falha quando já há um
  // cliente do outro lado, e o que chega lá é um `invalid_grant` cru — que não
  // diz ao operador que ele colou o arquivo de outro projeto.
  const parsed = chaveDeServicoSchema.safeParse(json);
  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: {
        chaveJson: parsed.error.issues.map((i) => i.message).join(" "),
      },
    };
  }

  const integracao = await db.integration.upsert({
    where: { provider: PROVIDER },
    update: {},
    create: { provider: PROVIDER, label: ROTULO, config: {}, enabled: false },
  });

  // Guarda o texto COLADO, e não o objeto validado reserializado: o schema
  // declara só os cinco campos que usamos, e reserializar jogaria fora o resto
  // do arquivo sem ninguém pedir. `lerChave` valida de novo na leitura.
  const cifrado = cifrar(bruto);

  // ⚠ O hint padrão do `cifrar` são os 4 últimos caracteres do texto plano, e
  // num JSON isso é a chave de fechamento e uma quebra de linha: igual para
  // toda credencial, inútil para conferir qual está guardada. O
  // `private_key_id` é o que muda numa rotação, então é ele que responde
  // "qual chave é esta?".
  const hint = gerarHint(parsed.data.private_key_id);

  await db.integrationCredential.upsert({
    where: { integrationId: integracao.id },
    update: { ...cifrado, hint, rotatedAt: new Date() },
    create: { integrationId: integracao.id, ...cifrado, hint },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.google.credential.rotated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: "Chave salva. Agora compartilhe cada planilha e documento com o e-mail acima, como Editor, e use o botão de testar.",
    contaEmail: parsed.data.client_email,
  };
}

export async function testarConexaoGoogle(): Promise<EstadoGoogle> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) {
    return { erro: "Salve o JSON da chave de conta de serviço antes de testar." };
  }

  const config = lerConfigGoogle(atual.config);

  let cliente: GoogleClient;
  try {
    cliente = new GoogleClient(config, lerChave(decifrar(atual.credential)));
  } catch (erro) {
    return {
      erro:
        erro instanceof Error
          ? erro.message
          : "A chave guardada não pôde ser lida. Cadastre o JSON de novo.",
    };
  }

  const resultado = await cliente.testar();

  await db.integration.update({
    where: { provider: PROVIDER },
    data: {
      // ⚠ `indeterminado` é conferido PRIMEIRO, e chega com `ok: true` junto —
      // ao contrário do teste da OpenAI, onde ele vem com `ok: false`. Aqui
      // significa "o Google devolveu token, mas não havia arquivo cadastrado
      // para provar acesso a coisa nenhuma". Gravar OK poria "conexão ok" numa
      // integração que ainda não abriu um único arquivo — e o que costuma
      // faltar é o compartilhamento, não a chave.
      status: resultado.indeterminado
        ? IntegrationStatus.NOT_CONFIGURED
        : resultado.ok
          ? IntegrationStatus.OK
          : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");

  if (resultado.indeterminado) return { atencao: resultado.mensagem };
  return resultado.ok ? { ok: resultado.mensagem } : { erro: resultado.mensagem };
}

export type ContaGoogle = { contaEmail: string; projectId: string };

/**
 * Quem é a conta de serviço guardada — lido do JSON DECIFRADO a cada abertura.
 *
 * ⚠ **Não é persistido em `Integration.config`**, e isso não é economia de
 * coluna. A config é substituída INTEIRA a cada save (`config: parsed.data`),
 * então o primeiro "Salvar configuração" de um ADMIN apagaria o e-mail que o
 * OWNER gravou junto com a chave. Recuperá-lo exigiria colar de novo um JSON
 * que o Google Cloud só deixa baixar uma vez, na criação. É a mesma armadilha
 * do "ler, mesclar, escrever" dos `custom_attributes` do Chatwoot — aqui
 * evitada não guardando dado derivado.
 */
export async function dadosDaContaGoogle(): Promise<ContaGoogle | null> {
  // Num arquivo "use server" toda função exportada é endpoint, inclusive a que
  // existe só para a página chamar na renderização. Esta devolve o e-mail e o
  // projeto da conta de serviço — dados de infraestrutura, não de vitrine.
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return null;

  try {
    const chave = lerChave(decifrar(atual.credential));
    return { contaEmail: chave.client_email, projectId: chave.project_id };
  } catch {
    // Chave ilegível não é "não há chave", e a tela sabe a diferença: ela
    // recebe `temChave` à parte e avisa para recadastrar. Devolver o erro por
    // aqui pediria um segundo canal para um caso que só acontece se alguém
    // trocar a ENCRYPTION_KEY.
    return null;
  }
}
