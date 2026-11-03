/**
 * O que aparece NA HORA quando se clica num item do menu lateral, enquanto a tela
 * nova ainda está sendo montada no servidor (o Next a mostra no lugar de qualquer
 * `page.tsx` deste grupo, com o menu e o cabeçalho já no lugar).
 *
 * Só desenha caixas cinzas: nenhum dado, nenhuma chamada. A diferença para antes é
 * perceptível mesmo quando a tela demora o mesmo — clicar e ver o painel se mexer
 * é outra coisa de clicar e ver nada acontecer.
 */
export default function Carregando() {
  const bloco = "rounded-lg bg-surface-2";

  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-3xl space-y-6">
      <span className="sr-only">Carregando…</span>

      <div className="space-y-2 motion-safe:animate-pulse">
        <div className={`${bloco} h-7 w-56`} />
        <div className={`${bloco} h-4 w-96 max-w-full`} />
      </div>

      <div className="flex flex-wrap gap-2 border-b border-line pb-3 motion-safe:animate-pulse">
        {[20, 24, 16, 28, 20].map((largura, i) => (
          <div key={i} className={`${bloco} h-8`} style={{ width: `${largura * 4}px` }} />
        ))}
      </div>

      {[0, 1].map((i) => (
        <div
          key={i}
          className="space-y-3 rounded-xl border border-line bg-surface p-5 motion-safe:animate-pulse"
        >
          <div className={`${bloco} h-5 w-44`} />
          <div className={`${bloco} h-4 w-full`} />
          <div className={`${bloco} h-4 w-5/6`} />
          <div className={`${bloco} h-9 w-full`} />
        </div>
      ))}
    </div>
  );
}
