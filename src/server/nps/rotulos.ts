import { PesquisaNpsStatus } from "@/generated/prisma/enums";

type Tom = "neutral" | "success" | "danger" | "accent" | "warning";

/** Como a tela de Integrações mostra a situação de cada pesquisa. */
export const SITUACAO_DA_PESQUISA: Record<PesquisaNpsStatus, { rotulo: string; tom: Tom }> = {
  [PesquisaNpsStatus.AGENDADA]: { rotulo: "agendada", tom: "neutral" },
  [PesquisaNpsStatus.AGUARDANDO]: { rotulo: "esperando a nota", tom: "accent" },
  [PesquisaNpsStatus.LEMBRADA]: { rotulo: "lembrete enviado", tom: "accent" },
  [PesquisaNpsStatus.RESPONDIDA]: { rotulo: "nota recebida", tom: "success" },
  [PesquisaNpsStatus.AGRADECIDA]: { rotulo: "nota recebida · resolve em breve", tom: "success" },
  [PesquisaNpsStatus.CONCLUIDA]: { rotulo: "concluída", tom: "success" },
  [PesquisaNpsStatus.EXPIRADA]: { rotulo: "sem nota", tom: "warning" },
  [PesquisaNpsStatus.CANCELADA]: { rotulo: "cancelada", tom: "neutral" },
  [PesquisaNpsStatus.FALHOU]: { rotulo: "falhou", tom: "danger" },
};
