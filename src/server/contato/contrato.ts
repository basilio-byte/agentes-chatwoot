import { somarDias } from "@/lib/tempo";
import { lerEmail } from "@/server/email-do-contato/regras";

/**
 * Venda de Endereço Fiscal fechada pelo próprio agente: o que a task do CRM
 * Comercial precisa para subir ao contrato, e o que o sistema já sabe preencher.
 *
 * Nasceu da conversa 14818 (26/10/2026, pedido do Diego). O Everton fechou a
 * venda, criou a task com os dados que coleta, e o ClickBot não a passou à Base
 * de clientes: cobrou Razão Social, Responsável, E-mail do responsável, as datas
 * do contrato, o vencimento, o ramo de atividade e o RG. A equipe refez a venda
 * à mão duas horas depois, e o cliente esperou o contrato esse tempo todo.
 *
 * ⚠ **Só a venda que o agente fechou** (VENDEDOR "Auto Venda" + produto de
 * endereço). A task do CRM nasce, muitas vezes, no início da negociação, e
 * "início do contrato = hoje" seria mentira para um lead; e a reserva de sala
 * também é "Auto Venda", mas não tem contrato.
 * ⚠ **Só preenche o VAZIO**, como o resto do cadastro completo: o que o agente
 * confirmou com o cliente e o que a equipe escreveu valem mais que o cálculo.
 * ⚠ **Dado que só o cliente sabe NÃO é inventado** (RG, CPF de quem assina,
 * endereço do sócio): entra em `faltamParaOContrato`, para o agente e a equipe
 * saberem que a venda ainda não sobe sozinha.
 *
 * Os campos exigidos foram lidos de duas fontes em 26/10/2026: os avisos do
 * ClickBot na task da 14818 e o mapeamento do prompt do agente de contratos (EV).
 * Se a automação do ClickUp mudar, a lista muda aqui — e só aqui.
 */

export const LISTA_DO_CRM_COMERCIAL = "901302419821";

type Campo = { campo: string; valor: unknown };
type CampoDaLista = { name?: string };

const normalizar = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const vazio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());

function valorDe(campos: Campo[], nome: string): unknown {
  const alvo = normalizar(nome);
  return campos.find((c) => normalizar(c.campo) === alvo)?.valor;
}

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/** Checkbox desmarcado não conta como preenchido: a regra "is checked" o recusaria. */
const desmarcado = (v: unknown) =>
  v === false || (typeof v === "string" && ["false", "nao", "não", "0", "no"].includes(v.trim().toLowerCase()));

/**
 * Os campos da LISTA que já têm valor, pelo nome normalizado. O agente escreve o
 * campo como o conhece ("Razão Social"), e a lista o chama de "✍️ Razão Social":
 * casa por nome exato e, depois, por trecho — só quando um campo único contém o
 * trecho, a mesma regra de quem grava (`resolverCampo`). Sem isso o sistema
 * acrescentaria um segundo valor para o campo que o agente já preencheu.
 */
function camposPreenchidos(campos: Campo[], camposDaLista: CampoDaLista[]): Set<string> {
  const nomes = camposDaLista.flatMap((c) => (c.name ? [normalizar(c.name)] : []));
  const preenchidos = new Set<string>();
  for (const { campo, valor } of campos) {
    if (vazio(valor) || desmarcado(valor)) continue;
    const alvo = normalizar(campo);
    if (nomes.includes(alvo)) {
      preenchidos.add(alvo);
      continue;
    }
    const parciais = nomes.filter((n) => n.includes(alvo));
    if (parciais.length === 1) preenchidos.add(parciais[0]);
  }
  return preenchidos;
}

/** Quem chama já sabe se a task é de venda autônoma de endereço. */
export function ehVendaDeEnderecoDoAgente(campos: Campo[]): boolean {
  return (
    normalizar(texto(valorDe(campos, "VENDEDOR"))) === "auto venda" &&
    normalizar(texto(valorDe(campos, "TIPO DE PRODUTO"))).startsWith("endereco")
  );
}

/**
 * A duração que o agente escreveu na descrição ("contrato de 24 meses", como o
 * prompt manda). Só 12 e 24, que são os contratos que existem: outro número
 * vindo de texto livre deixa a data de fim em branco, e o ClickBot avisa.
 */
export function mesesDoContrato(descricao?: string | null): 12 | 24 | undefined {
  const t = descricao ?? "";
  const m =
    t.match(/contrato\s+de\s+(\d{1,2})\s*meses/i) ??
    t.match(/(\d{1,2})\s*meses\s+de\s+(?:contrato|vig[eê]ncia)/i);
  const n = m ? Number(m[1]) : NaN;
  return n === 12 || n === 24 ? n : undefined;
}

/**
 * O último dia do contrato: o início mais N meses, menos um dia — 26/10/2026 por
 * 24 meses termina em 25/10/2028, que é o que a equipe gravou na venda da 14818
 * (uma única amostra: a convenção do "menos um dia" é lida dela). Quando o dia
 * não existe no mês de chegada (29/02, por exemplo), vale o último dia daquele mês.
 */
export function fimDoContrato(inicioIso: string, meses: number): string {
  const [ano, mes, dia] = inicioIso.split("-").map(Number);
  const alvo = mes - 1 + meses;
  const anoAlvo = ano + Math.floor(alvo / 12);
  const mesAlvo = ((alvo % 12) + 12) % 12;
  const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo + 1, 0)).getUTCDate();
  const chegada = new Date(Date.UTC(anoAlvo, mesAlvo, Math.min(dia, ultimoDia)))
    .toISOString()
    .slice(0, 10);
  return somarDias(chegada, -1);
}

type Exigido = {
  /** Como a equipe e o agente chamam o campo. */
  rotulo: string;
  /** Casa o nome do campo na lista do ClickUp. */
  casa: (nomeNormalizado: string) => boolean;
  /** Só vale para empresa (CNPJ)? */
  soEmpresa?: boolean;
};

const igual = (alvo: string) => (n: string) => n === alvo;

/**
 * Tudo que a venda precisa ter na task para subir ao contrato.
 *
 * Lido da regra "EV SB SP" do ClickBot (Configurações → Automações do CRM
 * Comercial), que cria a task na Base de clientes: quando o status vira
 * "Aguardando pagamento" E estes campos estão preenchidos — RESPONSÁVEL, CELULAR,
 * E-mail do responsável, VALOR CONTRATO, CPF ou CNPJ Preenchidos (marcado), Estado
 * Civil, DATA INICIO CONTRATO, FATURAMENTO, RAMO DE ATIVIDADE, DATA DE
 * ENCERRAMENTO, Endereço Sócio, RG / ID / RNE e Razão Social. Faltando um só, a
 * regra não faz nada, e nada reavalia depois.
 *
 * Mais três que a regra da Base não confere mas travam logo adiante: VENCIMENTO
 * (outra regra do ClickBot devolve a task ao Backlog sem ele) e CPF e Sede da
 * Empresa (o agente de contratos os exige para gerar o documento).
 *
 * ⚠ Nenhum campo da lista está marcado como obrigatório na configuração do
 * ClickUp: a lista mora DENTRO da regra. Mudou a regra? Muda aqui, e só aqui.
 * A ordem é a de leitura da mensagem à equipe.
 */
const EXIGIDOS: Exigido[] = [
  { rotulo: "Razão Social", casa: (n) => n.includes("razao social") },
  { rotulo: "RESPONSÁVEL", casa: igual("responsavel") },
  { rotulo: "E-mail do responsável", casa: igual("e-mail do responsavel") },
  { rotulo: "CELULAR", casa: igual("celular") },
  { rotulo: "VALOR CONTRATO", casa: igual("valor contrato") },
  { rotulo: "CPF ou CNPJ Preenchidos", casa: igual("cpf ou cnpj preenchidos") },
  { rotulo: "Estado Civil", casa: igual("estado civil") },
  { rotulo: "FATURAMENTO", casa: igual("faturamento") },
  { rotulo: "RG / ID / RNE", casa: (n) => n.startsWith("rg") },
  { rotulo: "Endereço Sócio", casa: (n) => n.includes("endereco socio") },
  { rotulo: "RAMO DE ATIVIDADE", casa: igual("ramo de atividade") },
  { rotulo: "DATA INICIO CONTRATO", casa: igual("data inicio contrato") },
  { rotulo: "DATA DE ENCERRAMENTO CONTRATO", casa: (n) => n.startsWith("data de encerramento contrato") },
  { rotulo: "VENCIMENTO", casa: igual("vencimento") },
  { rotulo: "CPF", casa: igual("cpf") },
  { rotulo: "Sede da Empresa", casa: igual("sede da empresa"), soEmpresa: true },
];

const nomeNaLista = (lista: CampoDaLista[], casa: (n: string) => boolean) =>
  lista.find((c) => c.name && casa(normalizar(c.name)))?.name;

/** Os 14 dígitos do CNPJ que o agente gravou na task, ou `null`. */
export function cnpjDosCampos(campos: Campo[]): string | null {
  const digitos = texto(valorDe(campos, "CNPJ [CADASTRO]")).replace(/\D/g, "");
  return digitos.length === 14 ? digitos : null;
}

const temCnpj = (campos: Campo[]) => cnpjDosCampos(campos) !== null;

/**
 * Campos do contrato que o sistema preenche sozinho, no nome que a lista usa.
 *
 * - RESPONSÁVEL e E-mail do responsável: quem assina o contrato é a pessoa de
 *   quem o agente pediu nome e e-mail (Passo 3 do prompt).
 * - Início e vencimento: o dia da venda — o prompt já diz que o vencimento é a
 *   data da contratação.
 * - Fim: o início somado à duração que o agente escreveu na descrição.
 * - Razão Social: a da Receita quando há CNPJ; sem CNPJ (pessoa física), o nome
 *   completo, regra do próprio aviso do ClickBot.
 */
export function camposDoContratoParaPreencher(args: {
  campos: Campo[];
  camposDaLista: CampoDaLista[];
  descricao?: string | null;
  /** O dia da venda em São Paulo, `AAAA-MM-DD`. */
  hoje: string;
  /** Consulta de CNPJ: `null` quando não houve consulta ou ela não respondeu. */
  razaoSocial?: string | null;
}): { campo: string; valor: string | number | boolean }[] {
  const { campos, camposDaLista, hoje } = args;
  const saida: { campo: string; valor: string | number | boolean }[] = [];
  if (!ehVendaDeEnderecoDoAgente(campos)) return saida;

  const preenchidos = camposPreenchidos(campos, camposDaLista);
  const poe = (casa: (n: string) => boolean, valor: string | number | boolean | null | undefined) => {
    const nome = nomeNaLista(camposDaLista, casa);
    if (!nome || valor === null || valor === undefined || valor === "") return;
    if (preenchidos.has(normalizar(nome))) return;
    saida.push({ campo: nome, valor });
  };

  const nome = texto(valorDe(campos, "NOME CLIENTE"));
  poe(igual("responsavel"), nome || null);

  const email = lerEmail(texto(valorDe(campos, "E-mail")));
  poe(igual("e-mail do responsavel"), email.tipo === "um" ? email.email : null);

  // A regra do ClickBot marca a caixa quando o CPF é gravado; com CNPJ ninguém a marca.
  const cpf = texto(valorDe(campos, "CPF")).replace(/\D/g, "");
  poe(igual("cpf ou cnpj preenchidos"), temCnpj(campos) || cpf.length === 11 ? true : null);

  poe(igual("data inicio contrato"), hoje);
  poe(igual("vencimento"), Number(hoje.slice(8, 10)));

  const meses = mesesDoContrato(args.descricao);
  poe((n) => n.startsWith("data de encerramento contrato"), meses ? fimDoContrato(hoje, meses) : null);

  poe((n) => n.includes("razao social"), temCnpj(campos) ? args.razaoSocial : nome || null);

  return saida;
}

/**
 * O que ainda falta na task para a venda subir ao contrato, pelos nomes que a
 * equipe conhece. Vazio quando está tudo lá.
 *
 * `campos` é a task INTEIRA como vai ser gravada (o que o agente mandou mais o
 * que o sistema acrescentou). Campo que a lista não tem não é cobrado: não há
 * onde preenchê-lo.
 */
export function faltamParaOContrato(args: {
  campos: Campo[];
  camposDaLista: CampoDaLista[];
}): string[] {
  const { campos, camposDaLista } = args;
  if (!ehVendaDeEnderecoDoAgente(campos)) return [];

  const empresa = temCnpj(campos);
  const preenchidos = camposPreenchidos(campos, camposDaLista);
  const faltam: string[] = [];
  for (const exigido of EXIGIDOS) {
    if (exigido.soEmpresa && !empresa) continue;
    const nome = nomeNaLista(camposDaLista, exigido.casa);
    if (!nome) continue;
    if (!preenchidos.has(normalizar(nome))) faltam.push(exigido.rotulo);
  }
  return faltam;
}

/** O aviso que volta ao agente quando a venda ainda não sobe sozinha. */
export function avisoDeContratoIncompleto(faltam: string[]): string {
  return `A task foi criada, mas a venda AINDA NÃO sobe sozinha para o contrato: faltam ${faltam.join(", ")}. Sem esses dados a automação do ClickUp não passa a task para a Base de clientes e o contrato não é gerado. Não diga ao cliente que o contrato já vai chegar: diga que a equipe confirma o envio. Registre uma nota interna listando exatamente o que falta. Não repita a criação nem tente "corrigir" a task.`;
}
