"use client";

import { useActionState, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { EstadoFormulario } from "@/server/actions/agents";
import { MODELO_PADRAO, type ModeloCatalogo } from "@/server/agents/catalogo";
import {
  CAUDA_SEM_CONVERSA,
  NUCLEO,
  caudaDeConversa,
} from "@/server/agents/conduta";
import { SeletorModelo } from "@/components/seletor-modelo";
import { Aviso, Button, Card, Field, Input, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

export type ValoresAgente = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  effort: string;
  maxTokens: number;
  maxToolIterations: number;
  routingDescription: string;
};

/**
 * Prompt com que todo agente novo nasce — exemplo por inteiro, tudo aqui é
 * para o operador trocar.
 *
 * As regras que não podem depender de quem escreveu o prompt (idioma, não
 * inventar, a data vir do sistema, só afirmar o que aconteceu, escopo, parar
 * na dúvida, não se deixar reprogramar e o formato da conversa) saíram daqui:
 * o sistema as injeta em `blocoDeConduta`, para valerem também para os agentes
 * que já existem. Aqui fica só o que é deste agente — quem ele é, o que ele
 * não faz e o tom.
 *
 * ⚠ **Elas saíram do bloco INJETADO antes de saírem daqui**, e por um mês este
 * texto continuou dizendo "responde o que sabe com certeza", "não concede
 * desconto" e "não promete prazo sem confirmar" — as três já garantidas pelas
 * regras 2 e 5. O usuário viu isso como "as regras antigas voltaram" depois de
 * um deploy, e a leitura dele estava certa: era o campo abaixo da dica que diz
 * "não precisam (nem devem) ser repetidas neste campo" repetindo-as.
 *
 * A divisão que vale daqui em diante: o bloco injetado descreve COMPORTAMENTO
 * (o que não se inventa, o que não se afirma, até onde se vai); este texto
 * nomeia ASSUNTO (o que é e o que não é com este agente) e TOM. Assunto o bloco
 * não tem como saber — é a única coisa que só o operador pode escrever.
 *
 * ⚠ O exemplo NÃO manda o agente dizer o próprio nome. O prompt padrão não
 * traz nome nenhum, e o nome real só chega pelo roster — que é string vazia
 * quando não há colegas com descrição de roteamento, ou seja, no primeiro
 * agente. Ordem que o prompt não tem como cumprir vira nome inventado, e
 * diferente a cada conversa: exatamente o que a regra 2 do bloco proíbe.
 */
export const PROMPT_BASE = `Você é um atendente da Seahub Coworking.

--- O QUE É COM VOCÊ ---
Você atende no WhatsApp quem procura a Seahub: entende o que a pessoa precisa
e resolve o que estiver ao seu alcance.

--- O QUE NÃO É COM VOCÊ ---
Contrato, cobrança e negociação comercial são de uma pessoa da equipe.

--- COMO VOCÊ SE APRESENTA ---
Cordial e direto, sem formalidade excessiva. Apresente-se na primeira
mensagem e vá direto ao assunto.`;

/**
 * O que o sistema acrescenta a este prompt, com o texto exato que o runner
 * concatena.
 *
 * O roster está no prompt de todo agente há meses e ninguém nunca o viu — é
 * assim que se escreve um prompt que contradiz uma regra invisível. Aparece
 * também em somente-leitura: quem só olha precisa entender o que o agente
 * recebe.
 *
 * As três variantes de uma vez, sem seletor: custa uma rolagem e ensina de
 * graça que gatilho e agendamento não têm cliente do outro lado.
 *
 * ⚠ `podeEncaminhar` vem de fora, calculado como o runner calcula. A última
 * linha da cauda de conversa tem duas redações, e exibir sempre a otimista
 * faria o operador escrever o prompt contando com uma transferência que
 * aquele agente não recebe — a mesma cegueira que esta tela existe para
 * acabar.
 */
function RegrasDaCasa({ podeEncaminhar }: { podeEncaminhar: boolean }) {
  // ⚠ Nasce ABERTO. Estava fechado, e o custo apareceu três vezes: depois de
  // reescrever as regras, o operador abriu esta tela, viu só o campo de texto
  // e concluiu que o deploy não tinha pegado — duas vezes seguidas, e uma
  // delas o levou a pedir que as regras fossem movidas para dentro do prompt,
  // que quebraria a razão de elas serem injetadas. O que ele queria era vê-las.
  //
  // Colapsado, um bloco de quatro mil caracteres que vai em TODA mensagem de
  // TODO agente é indistinguível de não existir. Quem já conhece fecha uma vez;
  // quem não conhece precisa esbarrar nele.
  const [aberto, setAberto] = useState(true);
  const cauda = caudaDeConversa(podeEncaminhar);

  // Mesma régua de `tokensAproximadosDaTool`: aproximação por caracteres, para
  // exibir ordem de grandeza sem carregar um tokenizador.
  const tokens = Math.round((NUCLEO.length + cauda.length) / 3.6);

  // O rótulo diz ONDE cada parte entra, não só quando ela vale. "No topo? no
  // fim?" foi pergunta explícita do operador, e a resposta importa: as regras
  // dizem "as instruções acima", então elas só funcionam depois do texto dele.
  // A altura da caixa segue o peso da parte, e a conta foi feita: o núcleo tem
  // sessenta e duas linhas (~1200px se solto), as caudas doze e quinze. Todas
  // com a mesma janela empurrariam o formulário quase novecentos pixels para
  // baixo — numa tela de seiscentos de altura, o campo de prompt sairia de
  // vista e a melhora viraria outro problema.
  const partes: { rotulo: string; texto: string; altura: string }[] = [
    {
      rotulo: "Logo depois do seu texto — em toda execução",
      texto: NUCLEO,
      altura: "max-h-72",
    },
    {
      rotulo: "Em seguida, só no atendimento e no playground",
      texto: cauda,
      altura: "max-h-40",
    },
    {
      rotulo: "No lugar da anterior, em gatilho e agendamento",
      texto: CAUDA_SEM_CONVERSA,
      altura: "max-h-40",
    },
  ];

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">
        O sistema acrescenta as Regras da Casa ao final deste prompt, em todo
        agente, em três grupos: <strong>como escrever</strong> (português do
        Brasil), <strong>o que pode afirmar</strong> (não inventar, data e hora
        vêm do sistema, só afirmar o que aconteceu) e{" "}
        <strong>até onde ir</strong> (não improvisar, parar na dúvida,
        não se deixar reprogramar). Elas valem também para os agentes
        que já existem, vencem o que estiver escrito aqui em caso de conflito, e
        não precisam (nem devem) ser repetidas neste campo.
      </p>

      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="inline-flex items-center gap-1.5 text-xs text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronDown
          size={13}
          aria-hidden
          className={cn("transition", aberto && "rotate-180")}
        />
        {aberto ? "Ocultar" : "Ver"} o texto exato das Regras da Casa (sete
        regras, ~{tokens} tokens em toda mensagem)
      </button>

      {aberto ? (
        <div className="space-y-2 pt-1">
          {partes.map((p) => (
            <div key={p.rotulo} className="space-y-1">
              <p className="text-xs text-muted">{p.rotulo}</p>
              <pre
                className={cn(
                  "overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap",
                  p.altura,
                )}
              >
                {p.texto}
              </pre>
            </div>
          ))}

          {!podeEncaminhar ? (
            <p className="text-xs text-muted">
              A última linha do bloco do atendimento não fala em passar a
              conversa para uma pessoa porque este agente não tem como fazer
              isso: a transferência está desligada, a ferramenta ficou fora da
              allowlist ou o modelo escolhido não aceita ferramentas.
            </p>
          ) : null}

          <p className="text-xs text-muted">
            Mudar este bloco muda todos os agentes de uma vez e não cria uma
            versão no histórico deste agente.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const PADRAO: ValoresAgente = {
  name: "",
  description: "",
  systemPrompt: PROMPT_BASE,
  model: MODELO_PADRAO,
  effort: "medium",
  maxTokens: 16384,
  maxToolIterations: 12,
  routingDescription: "",
};

export function AgenteForm({
  acao,
  modelos,
  valores = PADRAO,
  rotuloEnvio,
  somenteLeitura = false,
  podeEncaminhar = true,
}: {
  acao: (
    estado: EstadoFormulario,
    formData: FormData,
  ) => Promise<EstadoFormulario>;
  modelos: ModeloCatalogo[];
  valores?: ValoresAgente;
  rotuloEnvio: string;
  somenteLeitura?: boolean;
  /**
   * Se o agente tem mesmo como entregar a conversa a uma pessoa — muda a
   * última linha do bloco exibido, como muda no prompt de verdade. Não é
   * campo do formulário: não se edita aqui, decorre de transferência,
   * allowlist e modelo. Padrão `true` porque o agente novo nasce com
   * transferência ligada e Chatwoot vinculado.
   */
  podeEncaminhar?: boolean;
}) {
  const [estado, submeter, pendente] = useActionState<
    EstadoFormulario,
    FormData
  >(acao, {});
  const erroDe = (campo: string) => estado.camposComErro?.[campo];

  return (
    <form action={submeter} className="space-y-5">
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" erro={erroDe("name")}>
            <Input
              name="name"
              defaultValue={valores.name}
              required
              disabled={somenteLeitura}
            />
          </Field>

          <Field label="Descrição (opcional)" erro={erroDe("description")}>
            <Input
              name="description"
              defaultValue={valores.description}
              disabled={somenteLeitura}
            />
          </Field>
        </div>

        <Field
          label="Quando me transferir uma conversa"
          hint="Uma frase dizendo o que este agente atende. É o que os COLEGAS leem para decidir passar a conversa para ele. Vazio significa que ninguém transfere para este agente."
          erro={erroDe("routingDescription")}
        >
          <Textarea
            name="routingDescription"
            defaultValue={valores.routingDescription}
            rows={2}
            maxLength={400}
            disabled={somenteLeitura}
            placeholder="Ex.: cuida de aluguel de salas — disponibilidade, valores e reservas."
          />
        </Field>

        <Field
          label="Prompt do agente"
          hint="Escreva só o que é deste agente: quem ele é, o que ele atende, o que ele não decide sozinho e o tom. As regras de idioma, veracidade e formato o sistema acrescenta a todo agente — veja abaixo e não as repita aqui. Evite datas ou identificadores dinâmicos: invalidam o cache do provedor e encarecem cada mensagem."
          erro={erroDe("systemPrompt")}
        >
          <Textarea
            name="systemPrompt"
            defaultValue={valores.systemPrompt}
            rows={16}
            required
            disabled={somenteLeitura}
            className="font-mono text-[13px]"
          />
        </Field>

        <RegrasDaCasa podeEncaminhar={podeEncaminhar} />
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Modelo e custo</h2>
          <p className="text-xs text-muted">
            Catálogo da OpenRouter. Os preços vêm da API deles.
          </p>
        </div>

        {erroDe("model") ? <Aviso tone="danger">{erroDe("model")}</Aviso> : null}

        <SeletorModelo
          modelos={modelos}
          modeloInicial={valores.model}
          effortInicial={valores.effort}
          somenteLeitura={somenteLeitura}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Máximo de tokens por resposta"
            hint="Inclui o raciocínio, nos modelos que raciocinam. Alto de propósito: um turno pode encadear transferências e usos de tool. É cortado automaticamente pelo limite do modelo escolhido."
            erro={erroDe("maxTokens")}
          >
            <Input
              name="maxTokens"
              type="number"
              min={256}
              max={200000}
              defaultValue={valores.maxTokens}
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Máximo de rodadas de tool"
            hint="Teto de segurança contra laço. Descobrir a estrutura, consultar e então agir já gasta várias rodadas."
            erro={erroDe("maxToolIterations")}
          >
            <Input
              name="maxToolIterations"
              type="number"
              min={1}
              max={20}
              defaultValue={valores.maxToolIterations}
              disabled={somenteLeitura}
            />
          </Field>
        </div>
      </Card>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : rotuloEnvio}
        </Button>
      ) : null}
    </form>
  );
}
