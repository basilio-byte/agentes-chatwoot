import type { Job } from "bullmq";
import { avancarPesquisa } from "@/server/nps/executar";
import type { JobNps } from "./nps";

/** Adianta a etapa da pesquisa. A falha fica registrada na própria pesquisa. */
export async function processarNps(job: Job<JobNps>) {
  await avancarPesquisa(job.data.pesquisaId);
}
