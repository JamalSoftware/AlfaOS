#!/usr/bin/env bash
# AlfaOS — invólucro dos comandos one-shot chamados pelo cron — RC-1F-B
#
#   alfaos-job.sh <script do package.json>
#
# Por que existe, em vez de cada linha do crontab chamar `npm run`:
#
#   * o cron NÃO carrega o ambiente do serviço. Sem isto, o worker subiria sem
#     DATABASE_URL, sem STORAGE_ROOT e sem as chaves de cifra — e o ambiente
#     ficaria repetido em cada linha, com segredo no crontab;
#   * o cron tem PATH mínimo e nenhum diretório de trabalho útil;
#   * o operador precisa ver início, fim e código de saída no journal.
#
# Nenhum segredo entra em argumento de processo: o ambiente é lido do arquivo
# protegido e exportado dentro deste processo.
set -uo pipefail

APP_DIR="${ALFAOS_APP_DIR:-/opt/alfaos/current}"
ENV_FILE="${ALFAOS_ENV_FILE:-/etc/alfaos/alfaos.env}"
LOCK_FILE="${ALFAOS_BACKUP_LOCK:-/var/lib/alfaos/backup.lock}"

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "uso: alfaos-job.sh <script do package.json>" >&2
  exit 2
fi

# O ambiente é lido LITERALMENTE, nunca executado (`SEC-006`): `. "$ENV_FILE"`
# fazia de cada valor do arquivo de configuração código de shell, e uma senha
# com `$`, backtick ou `\` era reescrita aqui e não no systemd — a MESMA fonte
# resolvendo para valores diferentes.
ENV_LIB="$(dirname "$0")/alfaos-env.sh"
if [ ! -r "$ENV_LIB" ]; then
  echo "[alfaos] biblioteca de ambiente ausente: $ENV_LIB" >&2
  exit 78 # EX_CONFIG
fi
# shellcheck source=deploy/bin/alfaos-env.sh
. "$ENV_LIB"

alfaos_carregar_ambiente "$ENV_FILE" || exit 78

cd "$APP_DIR" || {
  echo "[alfaos] diretorio da aplicacao inacessivel" >&2
  exit 78
}

inicio="$(date -Is)"
echo "[alfaos] job=$JOB inicio=$inicio"

# O ÚNICO trabalho que precisa de exclusão do sistema operacional é o expurgo de
# etiqueta durante o backup: ele apaga arquivo, e o backup copia arquivo — a
# aplicação não tem como arbitrar isso, porque o backup não é dela. Os demais
# (outbox, diagnóstico) já se arbitram no banco por reserva, e um `flock` neles
# seria uma segunda arbitragem escondendo a primeira.
if [ "$JOB" = "evidence:cleanup" ]; then
  # O descritor fica ABERTO durante o `npm run`: a trava vale pela execução
  # inteira, e o sistema a solta sozinho quando o processo termina, inclusive se
  # ele morrer.
  exec 9>>"$LOCK_FILE" || {
    echo "[alfaos] trava de backup inacessivel: $LOCK_FILE" >&2
    exit 78
  }
  if ! flock -n 9; then
    echo "[alfaos] job=$JOB pulado: backup em andamento"
    exit 0
  fi
fi

npm run --silent "$JOB"
codigo=$?

echo "[alfaos] job=$JOB fim=$(date -Is) exit=$codigo"
exit "$codigo"
