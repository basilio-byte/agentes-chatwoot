"use client";

import { useActionState, useState, useTransition } from "react";
import { FileAudio, Plug, Search } from "lucide-react";
import {
  recarregarModelosOpenAI,
  salvarChaveDaOpenAI,
  salvarConfigOpenAI,
  testarArquivoOpenAI,
  testarConexaoOpenAI,
  type EstadoOpenAI,
  type ModelosParaEscolher,
} from "@/server/actions/openai";
import type { GrupoDeModelos } from "@/server/integrations/openai/catalogo";
import { Aviso, Button, Field, Input, Select, Textarea } from "@/components/ui";

/**
 * Escolha de um modelo.
 *
 * Vira `<select>` assim que a conta lista modelos, e cai para campo de texto
 * quando não lista — chave restrita não tem permissão de ler `/models` e ainda
 * assim transcreve, então travar o campo num seletor vazio impediria de
 * configurar uma instalação que funcionaria.
 *
 * ⚠ O valor gravado sempre tem opção correspondente (garantido no servidor, em
 * `comSelecionado`): `<select>` com valor fora da lista exibe a primeira opção e
 * **envia ela**, trocando o modelo sem ninguém pedir.
 */
function CampoDeModelo({
  name,
  label,
  hint,
  valor,
  grupos,
  erro,
  somenteLeitura,
  placeholder,
}: {
  name: string;
  label: string;
  hint: string;
  valor: string;
  grupos: GrupoDeModelos[];
  erro?: string;
  somenteLeitura: boolean;
  placeholder?: string;
}) {
  const [escolhido, setEscolhido] = useState(valor);

  if (grupos.length === 0) {
    return (
      <Field label={label} hint={hint} erro={erro}>
        <Input
          name={name}
          defaultValue={valor}
          placeholder={placeholder}
          disabled={somenteLeitura}
        />
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint} erro={erro}>
      <Select
        name={name}
        value={escolhido}
        onChange={(e) => setEscolhido(e.target.value)}
        disabled={somenteLeitura}
      >
        {/* Só o campo de documento aceita vazio — ele cai para o de imagem. */}
        {placeholder ? <option value="">{placeholder}</option> : null}
        {grupos.map((grupo) => (
          <optgroup key={grupo.rotulo} label={grupo.rotulo}>
            {grupo.ids.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </Field>
  );
}

type Props = {
  baseUrl: string;
  modeloVisao: string;
  modeloAudio: string;
  modeloDocumento: string;
  idiomaAudio: string;
  lerImagem: boolean;
  lerAudio: boolean;
  lerDocumento: boolean;
  instrucaoImagem: string;
  instrucaoDocumento: string;
  tamanhoMaximoMb: number;
  maxAnexosPorTurno: number;
  habilitada: boolean;
  temChave: boolean;
  hintChave: string | null;
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
  /** Modelos da conta, já agrupados. Vazio = campos de texto livre. */
  modelos: ModelosParaEscolher;
};

export function OpenAIConfigForm(props: Props) {
  const [estadoConfig, salvarConfig, salvandoConfig] = useActionState<
    EstadoOpenAI,
    FormData
  >(salvarConfigOpenAI, {});
  const [estadoChave, salvarChave, salvandoChave] = useActionState<
    EstadoOpenAI,
    FormData
  >(salvarChaveDaOpenAI, {});
  const [estadoArquivo, testarArquivo, testandoArquivo] = useActionState<
    EstadoOpenAI & { transcricao?: string; modelo?: string },
    FormData
  >(testarArquivoOpenAI, {});

  const [teste, setTeste] = useState<EstadoOpenAI | null>(null);
  const [ocupado, iniciar] = useTransition();
  const erro = (campo: string) => estadoConfig.camposComErro?.[campo];

  return (
    <div className="space-y-5">
      <form action={salvarChave} className="space-y-3">
        <Field
          label="API key da OpenAI"
          hint={
            props.temChave
              ? `Salva: ${props.hintChave}. Preencha de novo só para rotacionar.`
              : "Chave de platform.openai.com/api-keys. É uma conta separada da OpenRouter — a chave de lá não funciona aqui."
          }
          erro={estadoChave.camposComErro?.apiKey}
        >
          <Input
            name="apiKey"
            type="password"
            placeholder={props.temChave ? "••••••••" : "sk-..."}
            autoComplete="off"
            disabled={!props.podeEditarCredencial}
          />
        </Field>

        {estadoChave.erro ? <Aviso tone="danger">{estadoChave.erro}</Aviso> : null}
        {estadoChave.ok ? <Aviso tone="success">{estadoChave.ok}</Aviso> : null}

        {props.podeEditarCredencial ? (
          <Button size="sm" disabled={salvandoChave}>
            {salvandoChave ? "Salvando…" : "Salvar chave"}
          </Button>
        ) : (
          <Aviso>Só o proprietário do painel pode mexer em credenciais.</Aviso>
        )}
      </form>

      <form action={salvarConfig} className="space-y-4 border-t border-line pt-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">O que ler</h3>
          <p className="text-xs text-muted">
            Cada tipo desligado aqui deixa de custar — o agente continua sabendo
            que chegou um anexo, só não sabe o que tem dentro.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="lerAudio"
              defaultChecked={props.lerAudio}
              disabled={props.somenteLeitura}
              className="size-4 accent-accent"
            />
            Transcrever áudio <span className="text-xs text-muted">(o mais comum: nota de voz do WhatsApp)</span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="lerImagem"
              defaultChecked={props.lerImagem}
              disabled={props.somenteLeitura}
              className="size-4 accent-accent"
            />
            Ler imagem <span className="text-xs text-muted">(comprovante, print, foto de documento)</span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="lerDocumento"
              defaultChecked={props.lerDocumento}
              disabled={props.somenteLeitura}
              className="size-4 accent-accent"
            />
            Ler documento <span className="text-xs text-muted">(PDF, txt, csv)</span>
          </label>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Modelos</h3>
            {props.modelos.total > 0 ? (
              <span className="text-xs text-muted">
                {props.modelos.total} na conta
              </span>
            ) : null}
            {!props.somenteLeitura && props.temChave ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={ocupado}
                onClick={() =>
                  iniciar(async () => setTeste(await recarregarModelosOpenAI()))
                }
              >
                <Search size={14} aria-hidden />
                {ocupado ? "Buscando…" : "Recarregar lista"}
              </Button>
            ) : null}
          </div>

          {/* A OpenAI não publica quem enxerga imagem nem quem transcreve: o
              agrupamento abaixo é palpite, e por isso nada é escondido — o que
              não reconhecemos cai em "outros modelos da conta". */}
          {props.modelos.erro ? (
            <Aviso>{props.modelos.erro}</Aviso>
          ) : (
            <p className="text-xs text-muted">
              A lista vem da sua conta. A OpenAI não diz qual modelo enxerga
              imagem ou transcreve áudio, então o agrupamento é uma sugestão —
              nada fica escondido, e o <strong>teste com arquivo</strong> abaixo
              é o que prova de verdade.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <CampoDeModelo
              name="modeloAudio"
              label="Modelo de áudio"
              hint="Transcrição — outro endpoint, com outra lista de modelos."
              valor={props.modeloAudio}
              grupos={props.modelos.audio}
              erro={erro("modeloAudio")}
              somenteLeitura={props.somenteLeitura}
            />

            <CampoDeModelo
              name="modeloVisao"
              label="Modelo de imagem"
              hint="Precisa enxergar imagem (visão)."
              valor={props.modeloVisao}
              grupos={props.modelos.visao}
              erro={erro("modeloVisao")}
              somenteLeitura={props.somenteLeitura}
            />

            <CampoDeModelo
              name="modeloDocumento"
              label="Modelo de documento"
              hint="Em branco, usa o mesmo da imagem."
              valor={props.modeloDocumento}
              grupos={props.modelos.documento}
              erro={erro("modeloDocumento")}
              somenteLeitura={props.somenteLeitura}
              placeholder="mesmo da imagem"
            />

            <Field
              label="Idioma do áudio"
              hint="Duas letras (pt, en, es). Melhora a acurácia em áudio curto e com ruído — que é o de WhatsApp. Em branco, o modelo detecta."
              erro={erro("idiomaAudio")}
            >
              <Input
                name="idiomaAudio"
                defaultValue={props.idiomaAudio}
                maxLength={5}
                disabled={props.somenteLeitura}
              />
            </Field>
          </div>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-medium">O que pedir ao modelo</h3>
          <p className="text-xs text-muted">
            Este texto vira o que o agente lê no lugar do anexo. Seja
            prescritivo: &ldquo;descreva a imagem&rdquo; devolve literatura, e o
            que serve para o atendimento é o dado que estava na foto.
          </p>

          <Field label="Ao ver uma imagem" erro={erro("instrucaoImagem")}>
            <Textarea
              name="instrucaoImagem"
              rows={4}
              defaultValue={props.instrucaoImagem}
              disabled={props.somenteLeitura}
            />
          </Field>

          <Field label="Ao ler um documento" erro={erro("instrucaoDocumento")}>
            <Textarea
              name="instrucaoDocumento"
              rows={4}
              defaultValue={props.instrucaoDocumento}
              disabled={props.somenteLeitura}
            />
          </Field>
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field
            label="Tamanho máximo por arquivo (MB)"
            hint="Acima disso o anexo não é baixado. A OpenAI recusa acima de 25."
            erro={erro("tamanhoMaximoMb")}
          >
            <Input
              name="tamanhoMaximoMb"
              type="number"
              min={1}
              max={25}
              defaultValue={props.tamanhoMaximoMb}
              disabled={props.somenteLeitura}
            />
          </Field>

          <Field
            label="Anexos lidos por turno"
            hint="O que já foi lido vem do cache e não ocupa vaga. O que passar do teto entra como 'não lido' e o turno seguinte pega."
            erro={erro("maxAnexosPorTurno")}
          >
            <Input
              name="maxAnexosPorTurno"
              type="number"
              min={1}
              max={30}
              defaultValue={props.maxAnexosPorTurno}
              disabled={props.somenteLeitura}
            />
          </Field>
        </div>

        <Field
          label="Endpoint"
          hint="Só mude se usar um proxy interno. O padrão é a API da OpenAI."
          erro={erro("baseUrl")}
        >
          <Input
            name="baseUrl"
            defaultValue={props.baseUrl}
            disabled={props.somenteLeitura}
          />
        </Field>

        <label className="flex items-center gap-2 border-t border-line pt-4 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={props.habilitada}
            disabled={props.somenteLeitura}
            className="size-4 accent-accent"
          />
          Integração ligada
        </label>

        <Aviso>
          Ligar aqui não faz nenhum agente ler mídia ainda: falta o toggle na
          tela de cada agente, em <strong>Integrações do agente</strong>. Vale
          para o agente <strong>dono do bot</strong> pelo qual a conversa entra —
          quem assume por transferência lê a mesma transcrição.
        </Aviso>

        {estadoConfig.erro ? <Aviso tone="danger">{estadoConfig.erro}</Aviso> : null}
        {estadoConfig.ok ? <Aviso tone="success">{estadoConfig.ok}</Aviso> : null}

        {!props.somenteLeitura ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={salvandoConfig}>
              {salvandoConfig ? "Salvando…" : "Salvar configuração"}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={ocupado || !props.temChave}
              onClick={() => iniciar(async () => setTeste(await testarConexaoOpenAI()))}
            >
              <Plug size={14} aria-hidden />
              {ocupado ? "Testando…" : "Testar conexão"}
            </Button>
          </div>
        ) : null}
      </form>

      {teste?.ok ? <Aviso tone="success">{teste.ok}</Aviso> : null}
      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}

      {!props.somenteLeitura ? (
        <form action={testarArquivo} className="space-y-3 border-t border-line pt-5">
          <div>
            <h3 className="text-sm font-medium">Testar com um arquivo</h3>
            <p className="text-xs text-muted">
              Mostra exatamente o texto que o agente receberia. A alternativa
              seria mandar um áudio pelo WhatsApp de produção para descobrir se a
              configuração funciona. Este teste <strong>não</strong> entra no
              cache nem aparece no histórico de leituras.
            </p>
          </div>

          <input
            type="file"
            name="arquivo"
            accept="audio/*,image/*,.pdf,.txt,.csv,.md"
            className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-foreground"
          />

          <Button size="sm" variant="secondary" disabled={testandoArquivo || !props.temChave}>
            <FileAudio size={14} aria-hidden />
            {testandoArquivo ? "Lendo…" : "Ler arquivo"}
          </Button>

          {estadoArquivo.erro ? (
            <Aviso tone="danger">{estadoArquivo.erro}</Aviso>
          ) : null}
          {estadoArquivo.ok ? <Aviso tone="success">{estadoArquivo.ok}</Aviso> : null}

          {estadoArquivo.transcricao ? (
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <p className="mb-2 text-xs text-muted">
                É isto que entra na mensagem do cliente:
              </p>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {estadoArquivo.transcricao}
              </pre>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
