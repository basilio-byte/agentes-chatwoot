/**
 * O resumo do dia de cada parte da renovação automática (`<chave>:<dia>` em
 * `WebhookEvent`), montado a partir de várias rodadas. Puro: recebe o que já
 * estava gravado e a rodada de agora.
 *
 * ⚠⚠ **Somar, nunca sobrescrever.** Até 24/11/2026 cada rodada gravava por cima
 * da anterior. No primeiro lote real, a propagação das 12:35 escreveu 10 tarefas
 * e a das 13:05 escreveu outras 10 — e o resumo já só contava as da 13:05. Pior:
 * os contratos da leva seguinte que o mesmo lote reajustou ficam "pendentes" por
 * semanas (a tarefa deles ainda não entrou no fluxo), então toda rodada depois da
 * última escrita gravaria "nada escrito" por cima do dia em que tudo foi escrito.
 * A tela e o MCP mostrariam um dia vazio. O WhatsApp ao cliente ONE já somava
 * (`avisar.ts`); este módulo leva a mesma regra às outras quatro partes.
 *
 * O que SOMA é o que foi FEITO (listas e contadores declarados por quem chama);
 * o resto — pendentes, quantos candidatos sobram — é o estado de AGORA e vem da
 * última rodada.
 *
 * ⚠ **Teto sem quebrar o JSON.** O corte em 2.000 caracteres partia o texto no
 * meio de uma string, e o MCP devolvia JSON inválido. Aqui as LISTAS encolhem
 * (com a conta do que ficou de fora) até o texto caber.
 */

export const TETO_DO_RESUMO = 4000;

type Objeto = Record<string, unknown>;

/** O JSON gravado antes, ou nada. Texto torto (o corte antigo) conta como nada. */
export function lerResumoAnterior(detalhe: string | null | undefined): Objeto | null {
  if (!detalhe) return null;
  try {
    const lido = JSON.parse(detalhe) as unknown;
    return lido && typeof lido === "object" && !Array.isArray(lido) ? (lido as Objeto) : null;
  } catch {
    return null;
  }
}

function chaveDoItem(item: unknown) {
  return typeof item === "string" ? item : JSON.stringify(item);
}

/**
 * Junta a rodada de agora ao que o dia já registrou.
 *
 * - `listas`: o que foi feito (tarefas movidas, desfechos escritos) — soma, sem
 *   repetir item;
 * - `contadores`: quantos foram feitos — soma;
 * - todo o resto vem da rodada de agora;
 * - `rodadas` conta quantas vezes a parte rodou no dia, e `erro` só fica se a
 *   rodada de AGORA falhou (o erro da manhã não pode assombrar a tarde que deu
 *   certo — ele já está no log).
 */
export function somarAoDia(
  anterior: Objeto | null,
  agora: Objeto,
  campos: { listas?: readonly string[]; contadores?: readonly string[] } = {},
): Objeto {
  const antes = anterior ?? {};
  const resultado: Objeto = { ...agora };

  for (const campo of campos.listas ?? []) {
    const velhos = Array.isArray(antes[campo]) ? (antes[campo] as unknown[]) : [];
    const novos = Array.isArray(agora[campo]) ? (agora[campo] as unknown[]) : [];
    const vistos = new Set<string>();
    const juntos: unknown[] = [];
    for (const item of [...velhos, ...novos]) {
      // O marcador de "e mais N" de um corte anterior não é item de verdade.
      if (typeof item === "string" && item.startsWith(MARCA_DO_CORTE)) continue;
      if (item && typeof item === "object" && MARCA_DO_CORTE in (item as Objeto)) continue;
      const k = chaveDoItem(item);
      if (vistos.has(k)) continue;
      vistos.add(k);
      juntos.push(item);
    }
    resultado[campo] = juntos;
  }

  for (const campo of campos.contadores ?? []) {
    const a = typeof antes[campo] === "number" ? (antes[campo] as number) : 0;
    const b = typeof agora[campo] === "number" ? (agora[campo] as number) : 0;
    resultado[campo] = a + b;
  }

  resultado.rodadas = (typeof antes.rodadas === "number" ? antes.rodadas : 0) + 1;
  if (!("erro" in agora)) delete resultado.erro;
  return resultado;
}

const MARCA_DO_CORTE = "… e mais";

function cortarLista(lista: unknown[], maximo: number): unknown[] {
  if (lista.length <= maximo) return lista;
  const resto = lista.length - maximo;
  const objetos = lista.some((i) => i && typeof i === "object");
  return [
    ...lista.slice(0, maximo),
    objetos ? { [MARCA_DO_CORTE]: resto } : `${MARCA_DO_CORTE} ${resto}`,
  ];
}

/**
 * O texto que vai para `detalhe`, sempre JSON válido e dentro do teto: as listas
 * encolhem pela metade até caber, e cada uma diz quantos itens ficaram de fora.
 * Sem lista para encolher e ainda grande demais, sobra só o que não é lista.
 */
export function serializarResumo(objeto: Objeto, teto = TETO_DO_RESUMO): string {
  let texto = JSON.stringify(objeto);
  if (texto.length <= teto) return texto;

  const maiorLista = Math.max(
    0,
    ...Object.values(objeto).map((v) => (Array.isArray(v) ? v.length : 0)),
  );
  for (let maximo = Math.floor(maiorLista / 2); maximo >= 0; maximo = maximo ? Math.floor(maximo / 2) : -1) {
    const cortado: Objeto = {};
    for (const [k, v] of Object.entries(objeto)) cortado[k] = Array.isArray(v) ? cortarLista(v, maximo) : v;
    texto = JSON.stringify(cortado);
    if (texto.length <= teto) return texto;
  }

  const semListas: Objeto = {};
  for (const [k, v] of Object.entries(objeto)) {
    semListas[k] = Array.isArray(v) ? `${v.length} itens (cortados para caber)` : v;
  }
  texto = JSON.stringify(semListas);
  // Nunca cortar o texto no meio: JSON partido é o defeito que isto conserta.
  return texto.length <= teto ? texto : JSON.stringify({ resumoGrandeDemais: true });
}
