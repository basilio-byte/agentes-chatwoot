import { inicioDoDiaEmSaoPaulo, somarDias, w3cEmSaoPaulo } from "@/lib/tempo";

/**
 * Traduz o que o agente escreve para a forma que a API do Conexa aceita.
 *
 * Puro e testado, como `formatacao.ts` é para a volta. Os defeitos que fizeram
 * este módulo nascer (15/09/2026) eram todos de ida — nome de campo que a API
 * não conhece e data num formato que ela recusa — e a documentação dizia o
 * certo nos dois casos. Nenhum mock pegaria: o mock aceita o que mandarem.
 */

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const DATA_E_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const soDigitos = (v?: string) => (v ?? "").replace(/\D/g, "");

/**
 * O período de uma consulta à agenda, no formato dos filtros do Conexa.
 *
 * ⚠ **Filtro e corpo usam formatos DIFERENTES.** Criar reserva manda
 * `date: "2026-09-15"`; listar exige `bookingDateTimeFrom` em W3C, com hora e
 * deslocamento. A descrição da tool pedia AAAA-MM-DD e o código repassava cru:
 * toda primeira consulta dava 400, e só funcionava quando o modelo improvisava o
 * formato certo na segunda tentativa.
 *
 * Um dia vira o dia inteiro no relógio de São Paulo. Data com hora e
 * deslocamento passa como veio — é o que o modelo já improvisava, e funciona.
 */
export function periodoDaAgenda(
  de?: string,
  ate?: string,
): { de?: string; ate?: string } | { erro: string } {
  const inicio = pontaDoPeriodo(de, "inicio");
  if ("erro" in inicio) return inicio;
  const fim = pontaDoPeriodo(ate, "fim");
  if ("erro" in fim) return fim;

  if (inicio.valor && fim.valor && Date.parse(inicio.valor) > Date.parse(fim.valor)) {
    // Voltaria lista vazia — que, numa consulta de disponibilidade, se lê como
    // agenda livre.
    return { erro: `O início (${de}) é depois do fim (${ate}). Confira as datas.` };
  }
  return { de: inicio.valor, ate: fim.valor };
}

function pontaDoPeriodo(
  bruto: string | undefined,
  ponta: "inicio" | "fim",
): { valor?: string } | { erro: string } {
  const v = bruto?.trim();
  if (!v) return {};

  if (DIA.test(v)) {
    // `somarDias` normaliza 2026-02-30 para 2026-03-02: se não volta igual, a
    // data não existe.
    if (somarDias(v, 0) !== v) return { erro: `A data ${v} não existe.` };
    const instante =
      ponta === "inicio"
        ? inicioDoDiaEmSaoPaulo(v)
        : new Date(inicioDoDiaEmSaoPaulo(somarDias(v, 1)).getTime() - 1000);
    return { valor: w3cEmSaoPaulo(instante) };
  }

  if (DATA_E_HORA.test(v) && !Number.isNaN(Date.parse(v))) return { valor: v };

  return {
    erro: `Data "${v}" num formato que o Conexa não aceita. Use AAAA-MM-DD (ex.: 2026-09-15).`,
  };
}

/** 11 dígitos → `792.221.104-04`, como nos exemplos da documentação. */
function formatarCpf(d: string) {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** 14 dígitos → `99.557.155/0001-90`. */
function formatarCnpj(d: string) {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/**
 * Telefone no formato que o Conexa aceita: DDD + número, 10 ou 11 dígitos.
 *
 * O Chatwoot entrega `+558491631300`, com o 55 do país, e o Conexa recusa mais
 * de 11 dígitos. Sem DDD também não serve: devolve `null`, e quem chama avisa.
 */
export function telefoneParaConexa(bruto: string): string | null {
  let d = soDigitos(bruto);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

const avisoDeTelefone = (bruto: string) =>
  `O telefone "${bruto}" não foi gravado: o Conexa só aceita DDD + número, com 10 ou 11 dígitos.`;

/**
 * O corpo de `POST /customer`.
 *
 * ⚠ **Documento e contato vão ANINHADOS e em lista.** `cpf`, `email` e `phone` no
 * topo — como o corpo ia até 15/09/2026 — dão `400 Field validation error:
 * "cpf" field does not exist`. Nenhum cliente foi criado por agente enquanto foi
 * assim. O certo, pela documentação: `naturalPerson.cpf` (pessoa física),
 * `legalPerson.cnpj` (empresa), `emailsMessage[]` e `phones[]`.
 *
 * Pessoa física OU jurídica, nunca as duas: o cadastro do Conexa é de um tipo
 * só, e escolher no lugar de quem chamou seria adivinhar.
 */
export function corpoDeClienteNovo(dados: {
  companyId: number;
  nome: string;
  razaoSocial?: string;
  cpf?: string;
  cnpj?: string;
  email?: string;
  telefone?: string;
}): { corpo: Record<string, unknown>; avisos: string[] } | { erro: string } {
  const cpf = soDigitos(dados.cpf);
  const cnpj = soDigitos(dados.cnpj);

  if (!cpf && !cnpj) return { erro: "O Conexa exige CPF ou CNPJ para cadastrar." };
  if (cpf && cnpj) {
    return {
      erro: "Informe CPF (pessoa física) OU CNPJ (empresa), não os dois: o cadastro no Conexa é de um tipo só.",
    };
  }
  if (cpf && cpf.length !== 11) {
    return { erro: `CPF precisa ter 11 dígitos, e "${dados.cpf}" tem ${cpf.length}.` };
  }
  if (cnpj && cnpj.length !== 14) {
    return { erro: `CNPJ precisa ter 14 dígitos, e "${dados.cnpj}" tem ${cnpj.length}.` };
  }

  const nome = dados.nome.trim();
  const razaoSocial = dados.razaoSocial?.trim();
  const corpo: Record<string, unknown> = { companyId: dados.companyId };

  if (cpf) {
    corpo.name = nome;
    corpo.naturalPerson = { cpf: formatarCpf(cpf) };
  } else {
    // Em empresa, `name` é a razão social e o nome fantasia vai em `tradeName`
    // — é o que o exemplo de `PATCH /customer/:id` da documentação mostra.
    corpo.name = razaoSocial || nome;
    if (razaoSocial) corpo.tradeName = nome;
    corpo.legalPerson = { cnpj: formatarCnpj(cnpj) };
  }

  const avisos: string[] = [];
  const email = dados.email?.trim();
  if (email) corpo.emailsMessage = [email];

  if (dados.telefone?.trim()) {
    const telefone = telefoneParaConexa(dados.telefone);
    if (telefone) corpo.phones = [telefone];
    else avisos.push(avisoDeTelefone(dados.telefone));
  }

  return { corpo, avisos };
}

/**
 * Acrescenta um item a uma lista do Conexa sem apagar os que já estão lá.
 *
 * ⚠ **`emailsMessage` e `phones` são substituídos inteiros no PATCH** — a quarta
 * aparição, neste projeto, do campo de terceiro que apaga ao escrever (labels e
 * `custom_attributes` do Chatwoot, `notes` do Conexa). Mandar só o e-mail novo
 * apagaria os que a equipe cadastrou. Ler, mesclar, escrever.
 */
export function acrescentarNaLista(
  atual: unknown,
  novo: string,
  chave: (v: string) => string,
): string[] {
  const existentes = Array.isArray(atual)
    ? atual.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  return existentes.some((v) => chave(v) === chave(novo))
    ? existentes
    : [...existentes, novo];
}

const chaveDeEmail = (v: string) => v.trim().toLowerCase();
const chaveDeTelefone = (v: string) => telefoneParaConexa(v) ?? soDigitos(v);

/**
 * O corpo de `PATCH /customer/:id`, mesclado com o cliente lido AGORA.
 *
 * Mesmos nomes de campo do cadastro — `email` e `phone` no topo davam o mesmo
 * 400 —, e e-mail e telefone acrescentados em vez de substituídos.
 */
export function corpoDeAtualizacao(
  atual: Record<string, unknown>,
  dados: { nome?: string; email?: string; telefone?: string },
): { corpo: Record<string, unknown>; avisos: string[] } {
  const corpo: Record<string, unknown> = {};
  const avisos: string[] = [];

  const nome = dados.nome?.trim();
  if (nome) corpo.name = nome;

  const email = dados.email?.trim();
  if (email) corpo.emailsMessage = acrescentarNaLista(atual.emailsMessage, email, chaveDeEmail);

  if (dados.telefone?.trim()) {
    const telefone = telefoneParaConexa(dados.telefone);
    if (telefone) corpo.phones = acrescentarNaLista(atual.phones, telefone, chaveDeTelefone);
    else avisos.push(avisoDeTelefone(dados.telefone));
  }

  return { corpo, avisos };
}
