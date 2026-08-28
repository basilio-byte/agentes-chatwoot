"use client";

import {
  type ChangeEvent,
  useActionState,
  useState,
  useTransition,
} from "react";
import { Check, Copy, Plug } from "lucide-react";
import {
  salvarChaveGoogle,
  salvarConfigGoogle,
  testarConexaoGoogle,
  type EstadoGoogle,
} from "@/server/actions/google";
import { Aviso, Button, Field, Input, Meta, Textarea } from "@/components/ui";

/**
 * Configuração do Google Workspace.
 *
 * ⚠ O bloco mais importante desta tela é o primeiro: o e-mail da conta de
 * serviço. Cadastrar o id de uma planilha aqui não dá acesso a nada — quem dá
 * é o compartilhamento no Drive, feito com esse endereço, arquivo por arquivo.
 * Sem ele o Google responde 404 com o id certo, e a mensagem é idêntica à de
 * arquivo inexistente: o operador passa a tarde conferindo um id que está bom.
 *
 * ⚠ **Nenhum campo daqui é `<select>` alimentado por lista viva**, apesar de a
 * API do Drive listar arquivos. `<select>` com valor sem opção correspondente
 * exibe a primeira e **envia ela** (é a trava `comSelecionado`, na leitura de
 * mídia): bastaria a conta de serviço perder acesso a uma planilha para o
 * painel apontar o agente para outra, em silêncio, no primeiro save. Texto
 * livre erra alto — 404 na cara — em vez de errar baixo.
 */

const PLACEHOLDER_CADASTRO =
  "Controle de documentos = 1AbC...\nReservas 2026 = 1XyZ...";

/** O conteúdo dos campos que formam a configuração gravada. */
type Campos = {
  planilhas: string;
  documentos: string;
  modelos: string;
  pastas: string;
  driveCompartilhadoId: string;
  limiteDeLinhas: string;
  personificar: string;
};

/**
 * Compara o que está na tela com o que está gravado.
 *
 * Ignora exatamente o que o save também ignora — espaço nas pontas e linha em
 * branco —, senão um Enter sobrando no fim de uma caixa acusaria alteração que
 * não existe. Aviso que acende sozinho é aviso que se aprende a ignorar, e aí
 * ele deixa de servir para o caso em que está certo.
 *
 * `enabled` fica **fora** de propósito: o teste de conexão não lê o liga/desliga,
 * e travar o botão por causa dele seria barrar um teste que funcionaria.
 */
function mesmoConteudo(a: Campos, b: Campos) {
  const enxuto = (texto: string) =>
    texto
      .split(/[\r\n]+/)
      .map((linha) => linha.trim())
      .filter(Boolean)
      .join("\n");

  return (Object.keys(a) as (keyof Campos)[]).every(
    (campo) => enxuto(a[campo]) === enxuto(b[campo]),
  );
}

export function GoogleConfigForm({
  contaEmail,
  projectId,
  planilhas,
  documentos,
  modelos,
  pastas,
  driveCompartilhadoId,
  limiteDeLinhas,
  personificar,
  habilitada,
  temChave,
  hintChave,
  somenteLeitura,
  podeEditarCredencial,
}: {
  /** `client_email` da chave guardada. Nulo = sem chave, ou chave ilegível. */
  contaEmail: string | null;
  projectId: string | null;
  /** As quatro listas, uma linha por item, no formato `nome = id`. */
  planilhas: string;
  documentos: string;
  modelos: string;
  pastas: string;
  driveCompartilhadoId: string;
  limiteDeLinhas: number;
  personificar: string;
  habilitada: boolean;
  temChave: boolean;
  hintChave: string | null;
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
}) {
  const [estadoConfig, salvarConfig, salvandoConfig] = useActionState<
    EstadoGoogle,
    FormData
  >(salvarConfigGoogle, {});
  const [estadoChave, salvarChave, salvandoChave] = useActionState<
    EstadoGoogle,
    FormData
  >(salvarChaveGoogle, {});

  const [teste, setTeste] = useState<EstadoGoogle | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, iniciar] = useTransition();

  // ⚠ **"Testar conexão" não manda o formulário.** Ele roda no servidor e lê a
  // config GRAVADA — e no primeiro dia isso dá errado por construção: o OWNER
  // cola o JSON (outro formulário, já salvo), o operador digita a planilha na
  // caixa e clica em testar; o servidor lê `planilhas: []` e responde "cadastre
  // pelo menos uma planilha e teste de novo", com a planilha à vista dele.
  // Comparar a tela com o gravado é o que transforma esse desencontro em
  // instrução, em vez de mandar procurar defeito onde não há.
  const salvo: Campos = {
    planilhas,
    documentos,
    modelos,
    pastas,
    driveCompartilhadoId,
    limiteDeLinhas: String(limiteDeLinhas),
    personificar,
  };

  const [campos, setCampos] = useState(salvo);

  // Salvou, o servidor rerenderiza com o que gravou e a tela volta a coincidir.
  // Sem esta sincronia o aviso ficaria aceso para sempre depois da primeira
  // edição — mesmo padrão do ambiente da ZapSign, e pelo mesmo motivo: a tela
  // não pode divergir do que os agentes usam.
  const [ultimoSalvo, setUltimoSalvo] = useState(salvo);
  if (!mesmoConteudo(salvo, ultimoSalvo)) {
    setUltimoSalvo(salvo);
    setCampos(salvo);
  }

  const naoSalvo = !mesmoConteudo(campos, salvo);

  // Os campos passam a ser controlados por isto. O texto recusado continua na
  // caixa quando o save falha — que é o que faz a mensagem de linha ignorada
  // ter serventia —, porque o estado é do cliente e a ação não o rebobina.
  const digitar =
    (campo: keyof Campos) =>
    (evento: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCampos((atual) => ({ ...atual, [campo]: evento.target.value }));

  const erro = (campo: string) => estadoConfig.camposComErro?.[campo];

  // O e-mail que a ação acabou de devolver vence o que veio do servidor: colar
  // o JSON e continuar vendo o endereço da chave ANTERIOR é o jeito mais rápido
  // de compartilhar os arquivos com a conta errada.
  const email = estadoChave.contaEmail ?? contaEmail;

  function copiar() {
    if (!email) return;
    navigator.clipboard.writeText(email);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <span className="text-[13px] font-medium">E-mail da conta de serviço</span>

        {email ? (
          <>
            <div className="flex gap-2">
              {/* Único controle desta tela fora de um `Field`, e por isso o
                  único sem rótulo associado: o texto acima é um `<span>`
                  solto, que não vira `<label>` de nada. Justo o valor que só
                  existe para ser copiado — o leitor de tela anunciaria uma
                  caixa de texto sem nome nenhum. */}
              <Input
                readOnly
                value={email}
                aria-label="E-mail da conta de serviço"
                className="font-mono text-xs"
              />
              <Button type="button" variant="secondary" onClick={copiar}>
                {copiado ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                {copiado ? "Copiado" : "Copiar"}
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-muted">
              Compartilhe cada planilha e documento com este endereço, como{" "}
              <strong>Editor</strong>, no Google Drive. Sem isso o agente recebe
              &ldquo;arquivo não encontrado&rdquo; mesmo com o id certo — o
              Google responde a mesma coisa para arquivo inexistente e para
              arquivo não compartilhado.
            </p>

            {projectId ? (
              <Meta className="block">
                Projeto do Google Cloud: <code className="font-mono">{projectId}</code>{" "}
                — é nele que as APIs do Drive, Sheets e Docs precisam estar
                ativadas.
              </Meta>
            ) : null}
          </>
        ) : temChave && somenteLeitura ? (
          /* O e-mail vem de `dadosDaContaGoogle`, que exige ADMIN — a página
             só chama para quem pode. Sem esta ramificação, o papel Leitura
             cairia no aviso de chave ilegível abaixo e sairia procurando um
             defeito de criptografia que não existe. */
          <Aviso>
            Há uma chave cadastrada. O endereço da conta de serviço não aparece
            para o papel Leitura — peça a um administrador.
          </Aviso>
        ) : temChave ? (
          <Aviso tone="danger">
            Há uma chave guardada, mas não foi possível lê-la — normalmente é
            sinal de que a ENCRYPTION_KEY do servidor mudou. Cole o JSON de novo
            para o endereço da conta de serviço voltar a aparecer aqui.
          </Aviso>
        ) : (
          <Aviso>
            O endereço aparece aqui assim que o JSON da chave for colado abaixo.
            É ele que precisa ser convidado como Editor em cada planilha e
            documento — sem esse passo, nada do que for cadastrado nesta tela
            fica visível para o agente.
          </Aviso>
        )}
      </div>

      <form action={salvarChave} className="space-y-3 border-t border-line pt-5">
        <Field
          label="JSON da chave de conta de serviço"
          hint={
            temChave
              ? `Salva: ${hintChave} (id da chave privada). Cole de novo só para rotacionar.`
              : "Google Cloud → IAM e administrador → Contas de serviço → a conta → Chaves → Adicionar chave → JSON. Cole o arquivo inteiro, sem editar: as quebras de linha da chave privada fazem parte dela."
          }
          erro={estadoChave.camposComErro?.chaveJson}
        >
          <Textarea
            name="chaveJson"
            rows={5}
            placeholder={temChave ? "••••••••" : '{ "type": "service_account", ... }'}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            disabled={!podeEditarCredencial}
          />
        </Field>

        {estadoChave.erro ? <Aviso tone="danger">{estadoChave.erro}</Aviso> : null}
        {estadoChave.ok ? <Aviso tone="success">{estadoChave.ok}</Aviso> : null}

        {podeEditarCredencial ? (
          <Button size="sm" disabled={salvandoChave}>
            {salvandoChave ? "Salvando…" : "Salvar chave"}
          </Button>
        ) : (
          <Aviso>Só o proprietário do painel pode mexer em credenciais.</Aviso>
        )}
      </form>

      <form action={salvarConfig} className="space-y-4 border-t border-line pt-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Arquivos que o agente alcança</h3>
          {/* A frase antiga dizia que "o agente nunca vê um id", e não é
              verdade: `google_drive_listar_pasta` devolve o id de cada
              arquivo. O que vale — e é o que sustenta a allowlist — é que
              NENHUMA tool aceita id de volta; ele está no retorno para uma
              PESSOA cadastrar o arquivo aqui. Copy que promete a mais é copy
              que alguém desmente na primeira execução, e aí a parte
              verdadeira também deixa de ser levada a sério. */}
          <p className="text-xs leading-relaxed text-muted">
            Uma linha por arquivo, no formato <code className="font-mono">nome = id</code>.
            O agente pede pelo <strong>nome</strong> e{" "}
            <strong>nenhuma ferramenta aceita id</strong>: esta lista é a
            allowlist de arquivos, e o que não está nela ele não consegue abrir
            nem que saiba o id. O id aparece, sim, quando ele lista uma pasta —
            mas ali é informação para uma pessoa vir cadastrar o arquivo aqui.
            Em planilha e documento, o id fica na URL entre{" "}
            <code className="font-mono">/d/</code> e{" "}
            <code className="font-mono">/edit</code>; em pasta, a URL é outra
            (veja no campo de pastas).
          </p>
        </div>

        <Field
          label="Planilhas (Google Sheets)"
          hint="Onde o agente lê registros, procura por uma coluna e grava linhas."
          erro={erro("planilhas")}
        >
          <Textarea
            name="planilhas"
            rows={3}
            value={campos.planilhas}
            onChange={digitar("planilhas")}
            placeholder={PLACEHOLDER_CADASTRO}
            className="font-mono text-xs"
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Documentos (Google Docs)"
          hint="Documentos que o agente pode ler e nos quais pode acrescentar texto no fim."
          erro={erro("documentos")}
        >
          <Textarea
            name="documentos"
            rows={3}
            value={campos.documentos}
            onChange={digitar("documentos")}
            placeholder={PLACEHOLDER_CADASTRO}
            className="font-mono text-xs"
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Modelos de documento"
          hint="Documentos com campos entre chaves duplas ({{cliente}}), usados para gerar um arquivo novo. Cadastre aqui só o modelo — o que for gerado a partir dele não precisa entrar em lista nenhuma."
          erro={erro("modelos")}
        >
          <Textarea
            name="modelos"
            rows={2}
            value={campos.modelos}
            onChange={digitar("modelos")}
            placeholder={PLACEHOLDER_CADASTRO}
            className="font-mono text-xs"
            disabled={somenteLeitura}
          />
        </Field>

        <Field
          label="Pastas do Drive"
          hint="Pastas que o agente pode listar e onde pode procurar arquivo pelo começo do nome. Só o primeiro nível: o conteúdo de uma subpasta não aparece. ⚠ O id da pasta NÃO fica entre /d/ e /edit — isso vale para planilha e documento. A URL de pasta é drive.google.com/drive/folders/<id>: o id é o que vem depois de /folders/."
          erro={erro("pastas")}
        >
          <Textarea
            name="pastas"
            rows={2}
            value={campos.pastas}
            onChange={digitar("pastas")}
            placeholder={PLACEHOLDER_CADASTRO}
            className="font-mono text-xs"
            disabled={somenteLeitura}
          />
        </Field>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field
            label="Id do Drive compartilhado"
            hint="Só é necessário para CRIAR arquivo. Uma conta de serviço tem quota de armazenamento zero e não pode ser dona de nada, então gerar documento exige um Drive compartilhado, onde o dono é a organização. Ler e escrever no que já existe funciona sem isto."
            erro={erro("driveCompartilhadoId")}
          >
            <Input
              name="driveCompartilhadoId"
              value={campos.driveCompartilhadoId}
              onChange={digitar("driveCompartilhadoId")}
              placeholder="0AL9k..."
              className="font-mono text-xs"
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Linhas por leitura"
            hint="Teto do que volta numa consulta. Não é economia de rede: o histórico é relido inteiro a cada turno, então uma planilha despejada no retorno de uma tool é cobrada em toda mensagem seguinte da conversa."
            erro={erro("limiteDeLinhas")}
          >
            <Input
              name="limiteDeLinhas"
              type="number"
              min={10}
              max={2000}
              value={campos.limiteDeLinhas}
              onChange={digitar("limiteDeLinhas")}
              disabled={somenteLeitura}
            />
          </Field>
        </div>

        <Field
          label="Personificar (deixe vazio)"
          hint="Só serve para domain-wide delegation, e amplia o alcance para tudo o que a pessoa enxerga. Existe para um caso específico: Workspace que restringe compartilhamento a domínios confiáveis bloqueia a conta de serviço, e aí não há como compartilhar a planilha com ela. Preencher exige cadastrar o Client ID e os escopos no Admin console — sem isso, toda chamada volta unauthorized_client."
          erro={erro("personificar")}
        >
          <Input
            name="personificar"
            type="email"
            value={campos.personificar}
            onChange={digitar("personificar")}
            placeholder="(vazio)"
            disabled={somenteLeitura}
          />
        </Field>

        <label className="flex items-center gap-2 border-t border-line pt-4 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={habilitada}
            disabled={somenteLeitura}
            className="size-4 accent-accent"
          />
          Integração ligada
        </label>

        {estadoConfig.erro ? <Aviso tone="danger">{estadoConfig.erro}</Aviso> : null}
        {estadoConfig.ok ? <Aviso tone="success">{estadoConfig.ok}</Aviso> : null}

        {!somenteLeitura ? (
          <>
            {naoSalvo ? (
              <Aviso tone="warning">
                O que está nas caixas ainda <strong>não foi salvo</strong>, e o
                teste roda no servidor: ele lê a configuração{" "}
                <strong>gravada</strong>, que é a que os agentes usam. Com a
                planilha só digitada, ele responde que não há nenhuma
                cadastrada. Salve antes de testar.
              </Aviso>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={salvandoConfig}>
                {salvandoConfig ? "Salvando…" : "Salvar configuração"}
              </Button>

              {/* Travado enquanto houver diferença: um teste que responde
                  sobre outra configuração é pior que teste nenhum — ele
                  manda procurar defeito no lugar errado. */}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={ocupado || !temChave || naoSalvo}
                onClick={() => iniciar(async () => setTeste(await testarConexaoGoogle()))}
              >
                <Plug size={14} aria-hidden />
                {ocupado ? "Testando…" : "Testar conexão"}
              </Button>
            </div>
          </>
        ) : null}
      </form>

      {teste?.ok ? <Aviso tone="success">{teste.ok}</Aviso> : null}
      {/* Indeterminado NÃO é falha: a chave funcionou e faltou arquivo
          cadastrado para provar o resto. Vermelho aqui mandaria trocar uma
          credencial boa; verde afirmaria um acesso que ninguém verificou. */}
      {teste?.atencao ? <Aviso tone="warning">{teste.atencao}</Aviso> : null}
      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}

      {/* Permanente, e separado do aviso de escrita logo abaixo porque é
          outro tipo de falha: lá o risco é dado gravado a mais, aqui é
          silêncio. Sem a leitura de mídia ligada, mensagem que chega só com
          anexo nem vira job — o cliente manda o PDF, ninguém responde, e não
          há erro em lugar nenhum para explicar por quê. É o pré-requisito que
          não dá para adivinhar desta tela. */}
      <Aviso>
        <strong>O caso de uso principal depende da leitura de mídia.</strong> O
        cliente manda o PDF ou o áudio no WhatsApp, a leitura transforma em
        texto e só então o agente tem o que gravar na planilha. Com a leitura de
        mídia desligada, mensagem sem uma palavra escrita não vira atendimento
        nenhum — e o sintoma é silêncio, não erro. Ligue em{" "}
        <strong>Integrações → Leitura de mídia</strong> e também na tela do
        agente que atende a caixa de entrada: quem decide é a porta, não quem
        pensa.
      </Aviso>

      <Aviso tone="danger">
        O agente <strong>escreve de verdade</strong> nestas planilhas e
        documentos, e não existe desfazer. A conta de serviço só enxerga o que
        foi compartilhado com ela — prefira uma planilha dedicada a compartilhar
        a pasta inteira. E lembre do segundo nível do toggle: esta integração
        também precisa ser ligada na tela de cada agente que vai usá-la.
      </Aviso>
    </div>
  );
}
