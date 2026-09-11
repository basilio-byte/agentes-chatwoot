import type { FerramentaMcp } from "../executor";
import { FERRAMENTAS_DE_ESCRITA } from "./escrita";
import { FERRAMENTAS_DE_LEITURA } from "./leitura";

/** Tudo que o servidor MCP oferece. O executor filtra pelo papel de quem chama. */
export const CATALOGO: FerramentaMcp[] = [
  ...FERRAMENTAS_DE_LEITURA,
  ...FERRAMENTAS_DE_ESCRITA,
];
