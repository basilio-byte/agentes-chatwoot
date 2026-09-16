/**
 * Telefone do CRM: as formas de buscar e a conferência do que voltou.
 *
 * Medido em 15/09/2026 no CELULAR dos CRMs, que é campo do tipo `phone`: o
 * filtro `=` da API do ClickUp casa TRECHO do texto gravado e não normaliza
 * nada. Os nove dígitos do número acham a task; os mesmos dígitos com 55 e DDD,
 * sem o espaço que está gravado, não acham.
 */

function nacionalDe(bruto: string): string | null {
  const digitos = bruto.replace(/\D/g, "");
  const nacional =
    digitos.startsWith("55") && digitos.length >= 12 ? digitos.slice(2) : digitos;

  // DDD + 8 ou 9 dígitos. Fora disso não é número brasileiro com DDD.
  return nacional.length === 10 || nacional.length === 11 ? nacional : null;
}

/**
 * As formas em que o mesmo celular aparece gravado num campo de telefone do CRM.
 *
 * Cada fluxo e cada pessoa gravou num formato, e o filtro não normaliza. O
 * "Olho de tudo" do n8n tentava uma ferramenta por formato, e ainda assim o NPS
 * gravou a nota de 15/09/2026 numa task de maio porque o número da task nova
 * estava noutro formato. Gerar as variações aqui, e não no prompt, é o que faz
 * a busca ser uma chamada só.
 *
 * O nono dígito entra e sai porque o WhatsApp entrega número de celular sem ele
 * ("+558487654321") e a equipe digita com ele.
 */
export function variacoesDoTelefone(bruto: string): string[] {
  const nacional = nacionalDe(bruto);
  if (!nacional) return [];

  const ddd = nacional.slice(0, 2);
  const local = nacional.slice(2);

  const locais = new Set([local]);
  if (local.length === 9 && local.startsWith("9")) locais.add(local.slice(1));
  // Oito dígitos começando de 6 a 9 é celular sem o nono dígito; de 2 a 5 é fixo.
  if (local.length === 8 && /^[6-9]/.test(local)) locais.add(`9${local}`);

  const formas = new Set<string>();
  for (const numero of locais) {
    const inicio = numero.slice(0, -4);
    const fim = numero.slice(-4);
    formas.add(`+55 ${ddd} ${numero}`);
    formas.add(`+55 ${ddd} ${inicio} ${fim}`);
    formas.add(`+55 ${ddd} ${inicio}-${fim}`);
    formas.add(`+55${ddd}${numero}`);
    formas.add(`55${ddd}${numero}`);
    formas.add(`${ddd} ${numero}`);
    formas.add(`${ddd} ${inicio} ${fim}`);
    formas.add(`${ddd}${numero}`);
  }

  return [...formas];
}

/**
 * O mesmo número? DDD igual e o mesmo celular, com ou sem o nono dígito.
 *
 * É a conferência que o filtro não faz. Casar trecho pode trazer o número de
 * outra pessoa, e id de campo que a API não reconhece faz ela ignorar o filtro
 * e devolver a lista inteira. Toda task que a busca devolve passa por aqui
 * antes de chegar ao modelo — que gravaria a nota nela.
 */
export function mesmoTelefone(a: string, b: string): boolean {
  const x = telefoneCanonico(a);
  return x !== null && x === telefoneCanonico(b);
}

/**
 * DDD + nove dígitos no celular; fixo fica como está. `null` quando não é número
 * brasileiro com DDD. É também como a pesquisa de satisfação guarda o telefone,
 * para "o mesmo número" valer com ou sem o nono dígito.
 */
export function telefoneCanonico(bruto: string): string | null {
  const nacional = nacionalDe(bruto);
  if (!nacional) return null;

  const local = nacional.slice(2);
  return local.length === 8 && /^[6-9]/.test(local)
    ? `${nacional.slice(0, 2)}9${local}`
    : nacional;
}
