"use client";

import { useState, useTransition } from "react";
import { FileUp, Trash2 } from "lucide-react";
import {
  apagarDocumento,
  criarNovoDocumento,
  salvarDocumento,
  type EstadoDoDocumento,
} from "@/server/actions/conhecimento";
import {
  AVISO_A_PARTIR_DE_TOKENS,
  MAX_CARACTERES_DO_DOCUMENTO,
  motivoDeNaoLer,
  nomeSugerido,
  tokensDoTexto,
} from "@/server/conhecimento/regras";
import { Aviso, Badge, Button, Field, Input, Meta, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Maior arquivo que o navegador aceita ler: o teto do texto é bem menor. */
const MAX_BYTES_DO_ARQUIVO = 2 * 1024 * 1024;

export type DocumentoDoFormulario = {
  id: string;
  nome: string;
  descricao: string;
  setor: string;
  texto: string;
  origem: string;
};

export type AgenteDoFormulario = {
  id: string;
  nome: string;
  setor: string | null;
};

/**
 * Cria ou edita um documento de apoio, e marca quais agentes o recebem.
 *
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada — e aqui o que se perderia é o texto de um playbook colado, que não
 * volta. Todos os campos são controlados pelo mesmo motivo.
 *
 * ⚠ O arquivo é lido AQUI, no navegador, e vira texto no campo: nenhum PDF ou
 * Word chega ao servidor. A leitura de PDF que o sistema tem resume e corta a
 * resposta, e o que um agente vai tratar como instrução precisa ser lido por
 * uma pessoa na tela antes de salvar.
 */
export function DocumentoForm({
  documento,
  agentes,
  vinculados,
  setoresEmUso,
  somenteLeitura,
}: {
  /** Ausente = documento novo. */
  documento?: DocumentoDoFormulario;
  agentes: AgenteDoFormulario[];
  vinculados: string[];
  setoresEmUso: string[];
  somenteLeitura: boolean;
}) {
  const novo = !documento;
  const listaId = `setores-${documento?.id ?? "novo"}`;

  const [nome, setNome] = useState(documento?.nome ?? "");
  const [descricao, setDescricao] = useState(documento?.descricao ?? "");
  const [setor, setSetor] = useState(documento?.setor ?? "");
  const [texto, setTexto] = useState(documento?.texto ?? "");
  const [origem, setOrigem] = useState(documento?.origem ?? "");
  const [marcados, setMarcados] = useState<string[]>(vinculados);

  const [estado, setEstado] = useState<EstadoDoDocumento>({});
  const [avisoDoArquivo, setAvisoDoArquivo] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, iniciar] = useTransition();

  const erroDe = (campo: string) => estado.camposComErro?.[campo];
  const caracteres = texto.length;
  const tokens = tokensDoTexto(caracteres);
  const passouDoTeto = caracteres > MAX_CARACTERES_DO_DOCUMENTO;

  const limpar = () => {
    setNome("");
    setDescricao("");
    setSetor("");
    setTexto("");
    setOrigem("");
    setMarcados([]);
    setAvisoDoArquivo(null);
  };

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    iniciar(async () => {
      const resposta = documento
        ? await salvarDocumento(documento.id, {}, dados)
        : await criarNovoDocumento({}, dados);
      setEstado(resposta);
      // Só limpa depois de criar: o formulário de um documento que existe é a
      // própria tela dele, e esvaziá-la depois de salvar apagaria o texto da vista.
      if (resposta.criadoId) limpar();
    });
  };

  async function lerArquivo(arquivo: File | undefined) {
    setAvisoDoArquivo(null);
    if (!arquivo) return;

    const motivo = motivoDeNaoLer(arquivo.name);
    if (motivo) {
      setAvisoDoArquivo(motivo);
      return;
    }
    if (arquivo.size > MAX_BYTES_DO_ARQUIVO) {
      setAvisoDoArquivo(
        `O arquivo tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB — grande demais para ser um documento de apoio. Deixe só o que o agente precisa ler.`,
      );
      return;
    }

    const lido = await arquivo.text();
    if (lido.includes("�")) {
      setAvisoDoArquivo(
        "O arquivo não parece estar em UTF-8 (apareceram caracteres quebrados). Salve-o como UTF-8, ou cole o texto direto no campo.",
      );
      return;
    }

    setTexto(lido);
    setOrigem(arquivo.name);
    if (!nome.trim()) setNome(nomeSugerido(arquivo.name));
  }

  const alternar = (id: string) =>
    setMarcados((atual) =>
      atual.includes(id) ? atual.filter((a) => a !== id) : [...atual, id],
    );

  return (
    <form onSubmit={enviar} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome" erro={erroDe("nome")}>
          <Input
            name="nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={80}
            required
            disabled={somenteLeitura}
            placeholder="Ex.: Playbook comercial"
          />
        </Field>

        <Field
          label="Setor (opcional)"
          hint="Para filtrar. Escolha um já usado ou digite um novo."
          erro={erroDe("setor")}
        >
          <Input
            name="setor"
            value={setor}
            onChange={(e) => setSetor(e.target.value)}
            maxLength={40}
            list={listaId}
            autoComplete="off"
            disabled={somenteLeitura}
            placeholder="Em branco = sem setor"
          />
          <datalist id={listaId}>
            {setoresEmUso.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
      </div>

      <Field
        label="Para que serve (opcional)"
        hint="Uma frase. Vai junto do documento no prompt do agente, para ele saber quando consultá-lo."
        erro={erroDe("descricao")}
      >
        <Input
          name="descricao"
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          maxLength={280}
          disabled={somenteLeitura}
          placeholder="Ex.: como conduzir a venda de sala, do primeiro contato ao fechamento"
        />
      </Field>

      <input type="hidden" name="origem" value={origem} />

      <Field label="Texto do documento" erro={erroDe("texto")}>
        <Textarea
          name="texto"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={novo ? 10 : 14}
          disabled={somenteLeitura}
          spellCheck={false}
          className="font-mono text-xs leading-relaxed"
          placeholder="Cole aqui o texto, ou carregue um arquivo .txt / .md. É exatamente isto que o agente vai ler."
        />
      </Field>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {somenteLeitura ? null : (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition hover:text-foreground focus-within:outline-2 focus-within:outline-accent">
            <FileUp size={14} aria-hidden />
            Carregar arquivo de texto
            <input
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,.log,text/plain,text/markdown"
              className="sr-only"
              onChange={async (e) => {
                const campo = e.currentTarget;
                const arquivo = campo.files?.[0];
                await lerArquivo(arquivo);
                // Sem limpar, escolher o mesmo arquivo de novo não dispararia nada.
                campo.value = "";
              }}
            />
          </label>
        )}

        <Meta className={cn(passouDoTeto && "font-medium text-danger")}>
          {caracteres.toLocaleString("pt-BR")} de{" "}
          {MAX_CARACTERES_DO_DOCUMENTO.toLocaleString("pt-BR")} caracteres · ~
          {tokens.toLocaleString("pt-BR")} tokens em cada mensagem de cada agente
          que o receber
        </Meta>

        {origem ? <Badge title="De onde veio o texto">{origem}</Badge> : null}
      </div>

      {avisoDoArquivo ? <Aviso tone="warning">{avisoDoArquivo}</Aviso> : null}

      {tokens >= AVISO_A_PARTIR_DE_TOKENS && !passouDoTeto ? (
        <Aviso tone="warning">
          Este documento sozinho pesa cerca de {tokens.toLocaleString("pt-BR")}{" "}
          tokens, e eles são cobrados em <strong>toda</strong> mensagem dos
          agentes que o recebem. Vale deixar só o que o agente realmente usa.
        </Aviso>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">
          Agentes que recebem este documento
        </legend>
        {agentes.length === 0 ? (
          <p className="text-xs text-muted">Nenhum agente ativo ainda.</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {agentes.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="agentes"
                    value={a.id}
                    checked={marcados.includes(a.id)}
                    onChange={() => alternar(a.id)}
                    disabled={somenteLeitura}
                    className="size-3.5 shrink-0 accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate">{a.nome}</span>
                  {a.setor ? <Badge>{a.setor}</Badge> : null}
                </label>
              </li>
            ))}
          </ul>
        )}
        <Meta className="block">
          O texto entra no prompt de cada agente marcado, logo depois do prompt
          dele e antes das Regras da Casa, a partir da próxima mensagem. Também
          dá para vincular pela aba <strong>Documentos</strong> da tela de cada
          agente.
        </Meta>
      </fieldset>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {somenteLeitura ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="submit" disabled={ocupado || passouDoTeto}>
            {ocupado ? "Salvando…" : novo ? "Criar documento" : "Salvar documento"}
          </Button>

          {!novo ? (
            confirmando ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted">
                Apagar e tirar dos agentes?
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={ocupado}
                  onClick={() =>
                    iniciar(async () => {
                      const r = await apagarDocumento(documento.id);
                      if (r.erro) {
                        setEstado({ erro: r.erro });
                        setConfirmando(false);
                      }
                    })
                  }
                >
                  Sim, apagar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmando(false)}
                >
                  Não
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmando(true)}
              >
                <Trash2 size={14} aria-hidden />
                Apagar
              </Button>
            )
          ) : null}
        </div>
      )}
    </form>
  );
}
