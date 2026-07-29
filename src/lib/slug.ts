/**
 * Slug estável para identificar um agente nas transferências.
 *
 * O modelo escolhe o destino por este texto, não por id: cuid é longo e o
 * modelo erra ao copiar. E o slug não acompanha renomeações de propósito —
 * renomear "Vendas" para "Comercial" não pode quebrar as transferências que já
 * estão escritas nos prompts dos colegas.
 */

export function gerarSlug(texto: string): string {
  const base = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas de acento separadas pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return base || "agente";
}

/**
 * Slug único dentro de uma lista já usada.
 *
 * Sufixo numérico em vez de erro: criar um segundo agente com nome parecido é
 * normal, e travar o cadastro por causa do identificador interno seria ruído.
 */
export function slugUnico(texto: string, usados: Iterable<string>): string {
  const ocupados = new Set(usados);
  const base = gerarSlug(texto);
  if (!ocupados.has(base)) return base;

  let n = 2;
  while (ocupados.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
