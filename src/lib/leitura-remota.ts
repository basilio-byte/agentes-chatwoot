import { logger } from "@/lib/logger";

/**
 * Dado que mora FORA do sistema (OpenAI, Chatwoot, Conexa) e que uma tela do
 * painel mostra: entrega o último valor lido NA HORA e renova por trás.
 *
 * Por que existe: a tela de Integrações é componente de servidor e esperava, uma
 * depois da outra, a lista de modelos da OpenAI (~1,2 s), os macros do Chatwoot
 * (~2,7 s, 280 KB) e as categorias do Conexa (~1,2 s). Cada uma tinha cache de 5
 * min a 1 h, e quem abria a tela logo depois de o cache vencer — ou do deploy —
 * esperava tudo (medido: 15 s na primeira abertura depois do deploy de
 * 03/11/2026; 0,3 a 0,8 s com tudo quente).
 *
 * Regras:
 * - **Fresco** (idade < `validadeMs`): devolve o valor, sem trabalho nenhum.
 * - **Velho, mas ainda aceitável** (idade < `idadeMaximaMs`): devolve o valor
 *   velho NA HORA e renova por trás. Quem abre a tela nunca espera a renovação.
 * - **Sem valor, ou velho demais**: espera o valor novo. Dado de dois dias atrás,
 *   mostrado em silêncio, é pior do que uma tela mais lenta.
 * - **Voo único**: duas telas pedindo a mesma chave juntas fazem UMA ida ao
 *   serviço externo.
 * - **Renovação que falha não apaga o que já se sabe.** O valor anterior segue
 *   valendo até a idade máxima.
 * - `deveGuardar` deixa o chamador recusar resultado que não vale guardar —
 *   "a lista veio vazia porque a OpenAI deu erro" não pode substituir a lista boa
 *   nem ficar 50 minutos como se fosse a verdade.
 *
 * ⚠ O estado mora em `globalThis`, e não numa variável do módulo: o Next carrega o
 * mesmo código em mais de um contexto (rota, ação de servidor, página), e uma
 * variável de módulo daria um cache por contexto — a tela de um lado e o
 * aquecimento do outro nunca se enxergariam.
 *
 * Só serve para o que o PAINEL mostra. Quem age sobre o dado (um agente mandando
 * a imagem de um macro) continua com as leituras e os caches de sempre.
 */

type Entrada = { valor: unknown; em: number };

type Estado = {
  entradas: Map<string, Entrada>;
  emVoo: Map<string, Promise<unknown>>;
  /** Sobe a cada `esquecer`: voo que começou antes não grava depois. */
  geracao: Map<string, number>;
};

const global = globalThis as unknown as { __seahubLeituraRemota?: Estado };
const estado: Estado = (global.__seahubLeituraRemota ??= {
  entradas: new Map(),
  emVoo: new Map(),
  geracao: new Map(),
});

export type OpcoesDeLeitura<T> = {
  /** Até aqui o valor é fresco. */
  validadeMs: number;
  /** Passando da validade e até aqui, o valor velho é devolvido enquanto o novo vem. */
  idadeMaximaMs: number;
  carregar: () => Promise<T>;
  /** Só o que passar aqui substitui o valor guardado. Sem isto, tudo o que `carregar` devolver é guardado. */
  deveGuardar?: (valor: T) => boolean;
  /** Para teste. */
  agora?: () => number;
};

function renovar<T>(chave: string, o: OpcoesDeLeitura<T>): Promise<T> {
  const emVoo = estado.emVoo.get(chave);
  if (emVoo) return emVoo as Promise<T>;

  const geracaoDoInicio = estado.geracao.get(chave) ?? 0;
  const voo = (async () => {
    const valor = await o.carregar();
    const igual = (estado.geracao.get(chave) ?? 0) === geracaoDoInicio;
    if (igual && (!o.deveGuardar || o.deveGuardar(valor))) {
      estado.entradas.set(chave, { valor, em: (o.agora ?? Date.now)() });
    }
    return valor;
  })();

  const registrado = voo.finally(() => {
    if (estado.emVoo.get(chave) === registrado) estado.emVoo.delete(chave);
  });
  estado.emVoo.set(chave, registrado);
  return registrado;
}

export function lerComReserva<T>(chave: string, o: OpcoesDeLeitura<T>): Promise<T> {
  const guardada = estado.entradas.get(chave);
  if (guardada) {
    const idade = (o.agora ?? Date.now)() - guardada.em;
    if (idade < o.validadeMs) return Promise.resolve(guardada.valor as T);

    if (idade < o.idadeMaximaMs) {
      renovar(chave, o).catch((erro: unknown) =>
        logger.warn(
          { chave, erro: erro instanceof Error ? erro.message : String(erro) },
          "leitura remota: não consegui renovar — segue o valor anterior",
        ),
      );
      return Promise.resolve(guardada.valor as T);
    }
  }
  return renovar(chave, o);
}

/**
 * Esquece o valor de uma chave (ou de todas): a próxima leitura espera o novo. É o
 * que se chama quando o dado MUDOU por causa do que alguém fez na tela — chave
 * trocada, botão de recarregar — e mostrar o velho seria mostrar errado.
 */
export function esquecerLeituraRemota(chave?: string) {
  const chaves = chave ? [chave] : [...new Set([...estado.entradas.keys(), ...estado.emVoo.keys()])];
  for (const c of chaves) {
    estado.entradas.delete(c);
    estado.emVoo.delete(c);
    estado.geracao.set(c, (estado.geracao.get(c) ?? 0) + 1);
  }
}

/** Há quanto tempo (ms) o valor da chave foi lido, ou `null` se não há. Para a tela e o teste. */
export function idadeDaLeitura(chave: string, agora = Date.now()): number | null {
  const e = estado.entradas.get(chave);
  return e ? agora - e.em : null;
}
