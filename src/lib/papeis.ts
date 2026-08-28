import { UserRole } from "@/generated/prisma/enums";

/**
 * O que cada papel realmente faz — fonte única, para a tela nunca descrever um
 * poder que o código não concede (nem esconder um que ele concede).
 *
 * Os textos abaixo são a leitura de `exigirPapel(...)` espalhado pelas server
 * actions e de `podeEditar(...)` nas telas. Mexeu na permissão de alguma ação?
 * A descrição aqui é parte da mudança, não documentação opcional: é por ela que
 * alguém decide a quem entregar uma conta.
 */

export type DescricaoDePapel = {
  rotulo: string;
  /** Uma linha, para a dica embaixo do seletor. */
  resumo: string;
  pode: string[];
  naoPode: string[];
};

export const PAPEIS: Record<UserRole, DescricaoDePapel> = {
  [UserRole.VIEWER]: {
    rotulo: "Leitura",
    resumo: "Acompanha tudo e não altera nada — nem gasta crédito.",
    pode: [
      "Ver agentes, conversas, execuções e consumo",
      "Abrir o detalhe de uma execução e ler a transcrição",
      "Trocar a própria senha",
    ],
    naoPode: [
      "Criar ou editar agentes, integrações e gatilhos",
      "Testar no playground — cada teste gasta crédito da OpenRouter",
      "Ver credenciais ou mexer em contas",
    ],
  },

  [UserRole.ADMIN]: {
    rotulo: "Administrador",
    resumo: "Cria e opera agentes; não vê credenciais nem mexe em contas.",
    pode: [
      "Criar, editar, arquivar e excluir agentes",
      "Ligar/desligar agente e definir quem é o de entrada",
      "Configurar integrações, testar conexão e escolher as tools de cada agente",
      "Configurar e ligar a leitura de mídia (áudio, imagem, documento)",
      "Ligar e desligar o gatilho HTTP de um agente",
      "Testar no playground",
    ],
    naoPode: [
      "Ver ou trocar as credenciais das integrações",
      "Gerar ou rotacionar o token do gatilho HTTP",
      "Criar contas, mudar papéis ou redefinir a senha de outra pessoa",
    ],
  },

  [UserRole.OWNER]: {
    rotulo: "Proprietário",
    resumo: "Faz tudo, inclusive credenciais e contas.",
    pode: [
      "Tudo o que o Administrador faz",
      // O JSON da conta de serviço do Google entra aqui como qualquer outra
      // credencial: quem o cola é `salvarChaveGoogle`, que exige OWNER. Deixar
      // a frase desatualizada faria alguém entregar uma conta de ADMIN
      // achando que ela não alcança credencial nenhuma.
      "Trocar as credenciais de Chatwoot, ClickUp, Conexa, ZapSign, OpenAI e Google Workspace",
      "Gerar e rotacionar o token do gatilho HTTP",
      "Criar contas, mudar papéis, redefinir senha e desativar pessoas",
    ],
    naoPode: [
      "Desativar a própria conta",
      "Deixar o painel sem nenhum proprietário ativo",
    ],
  },
};

/**
 * Do menor para o maior privilégio.
 *
 * É a ordem em que os papéis aparecem nos seletores, de propósito: quem está
 * liberando acesso lê de cima para baixo e encontra primeiro a opção mais
 * contida.
 */
export const ORDEM_DOS_PAPEIS: UserRole[] = [
  UserRole.VIEWER,
  UserRole.ADMIN,
  UserRole.OWNER,
];

/** Só o rótulo — para onde não cabe a descrição inteira. */
export function rotuloDoPapel(papel: UserRole) {
  return PAPEIS[papel].rotulo;
}
