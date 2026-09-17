import os from "node:os";
import path from "node:path";

/**
 * Onde os arquivos ficam — UMA autoridade, para o web e para os comandos.
 *
 * # Por que existe (`RC-1F-B`, `RC-STO-03`)
 *
 * `STORAGE_ROOT` sempre foi lido direto no adapter, com `.storage` como padrão
 * relativo ao diretório de trabalho. Em desenvolvimento isso é conveniente; em
 * produção é uma armadilha silenciosa: a raiz cairia DENTRO do release, e o
 * deploy seguinte — que troca o diretório da aplicação — deixaria as fotos de
 * evidência, as assinaturas e as fotos de CTO para trás, com o banco ainda
 * apontando para elas. Ninguém percebe no dia do deploy; percebe-se quando
 * alguém abre uma OS antiga.
 *
 * Em produção, portanto, a raiz é OBRIGATÓRIA, ABSOLUTA e FORA da aplicação.
 * Fora de produção nada muda: `.storage` continua valendo, e a suíte continua
 * escrevendo no temporário que o `setup.ts` cria (`RC-STO-02`).
 *
 * # O que NÃO é verificado aqui
 *
 * Existência, permissão e espaço em disco. Quem cria a raiz é o provisionamento
 * (`docs/DEPLOYMENT.md`), com dono e modo próprios — a aplicação não roda como
 * root e não deve fabricar diretório de produção por conta própria. A escrita
 * falha com o erro do sistema de arquivos, que diz mais que qualquer palpite
 * nosso, e `npm run storage:audit` é a conferência de deploy.
 */

/** O padrão histórico, relativo ao diretório de trabalho. Nunca em produção. */
export const DEFAULT_STORAGE_ROOT = ".storage";

function dentro(alvo: string, container: string): boolean {
  const relativo = path.relative(container, alvo);
  return (
    relativo === "" ||
    (!relativo.startsWith("..") && !path.isAbsolute(relativo))
  );
}

/**
 * A raiz de armazenamento deste processo.
 *
 * `appDir` é o diretório da aplicação (o `cwd` do web e o dos comandos, que o
 * systemd e o cron fixam). É parâmetro para o teste poder descrever um layout
 * de produção sem depender de onde a suíte roda.
 */
export function resolveStorageRoot(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd(),
  tmpDir: string = os.tmpdir(),
): string {
  const bruto = env.STORAGE_ROOT?.trim();

  if (env.NODE_ENV !== "production") {
    return path.resolve(appDir, bruto && bruto !== "" ? bruto : DEFAULT_STORAGE_ROOT);
  }

  const comoConfigurar =
    "Configure um caminho absoluto e persistente, fora do diretório da " +
    "aplicação (veja docs/DEPLOYMENT.md).";

  if (!bruto || bruto === "") {
    throw new Error(
      `STORAGE_ROOT é obrigatório em produção. ${comoConfigurar}`,
    );
  }
  if (!path.isAbsolute(bruto)) {
    throw new Error(
      `STORAGE_ROOT inválido: em produção o caminho precisa ser absoluto ` +
        `(recebido: "${bruto.slice(0, 80)}"). ${comoConfigurar}`,
    );
  }

  const raiz = path.resolve(bruto);

  /*
    Dentro da aplicação, ou contendo a aplicação: os dois casos são o mesmo
    defeito — a raiz deixa de sobreviver ao deploy. O segundo parece improvável
    até alguém escrever `/` ou `/opt`, e aí o expurgo de órfãos passa a varrer a
    própria instalação.
  */
  if (dentro(raiz, appDir) || dentro(appDir, raiz)) {
    throw new Error(
      `STORAGE_ROOT inválido: a raiz não pode ficar dentro do diretório da ` +
        `aplicação nem contê-lo — um deploy apagaria os arquivos. ${comoConfigurar}`,
    );
  }

  if (dentro(raiz, tmpDir)) {
    throw new Error(
      "STORAGE_ROOT inválido: diretório temporário não é armazenamento " +
        `persistente. ${comoConfigurar}`,
    );
  }

  return raiz;
}
