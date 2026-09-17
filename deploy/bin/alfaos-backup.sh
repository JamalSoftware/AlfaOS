#!/usr/bin/env bash
# AlfaOS — backup diário: banco + storage — RC-1F-B
#
# Roda como o usuário de serviço, pelo cron. NÃO para a aplicação: o web
# continua atendendo, e o único trabalho excluído é o expurgo de etiqueta, que
# apaga arquivo enquanto isto copia arquivo (trava compartilhada com
# `alfaos-job.sh`).
#
# ORDEM: banco PRIMEIRO, storage depois. O arquivo é gravado antes da linha que
# o referencia, e a linha é apagada antes do arquivo — então a cópia posterior
# do storage contém tudo o que o dump menciona. A janela residual está declarada
# em docs/DEPLOYMENT.md: uma foto enviada DEPOIS do dump e ANTES do tar entra no
# storage sem linha no banco (órfã na restauração, nunca linha sem arquivo).
#
# NÃO É DISASTER RECOVERY SOZINHO: cópia no mesmo VPS morre com o VPS. O destino
# externo é decisão do dono e não está escolhido — ver ALFAOS_OFFSITE_CMD.
#
# Credencial: NUNCA em argumento de processo. O `pg_dump` autentica por
# ~/.pgpass (modo 0600) ou por socket local; o arquivo de ambiente traz apenas
# host, porta, base e usuário.
set -uo pipefail

ENV_FILE="${ALFAOS_ENV_FILE:-/etc/alfaos/alfaos.env}"
LOCK_FILE="${ALFAOS_BACKUP_LOCK:-/var/lib/alfaos/backup.lock}"
DEST="${ALFAOS_BACKUP_DIR:-/var/backups/alfaos}"

if [ ! -r "$ENV_FILE" ]; then
  echo "[alfaos-backup] ambiente ilegivel: $ENV_FILE" >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

STORAGE="${STORAGE_ROOT:-}"
if [ -z "$STORAGE" ] || [ ! -d "$STORAGE" ]; then
  echo "[alfaos-backup] STORAGE_ROOT ausente ou inexistente — backup incompleto nao serve" >&2
  exit 78
fi

# Uma execução por vez, e exclusão do expurgo de etiqueta enquanto copia.
exec 9>>"$LOCK_FILE" || exit 78
if ! flock -w 300 9; then
  echo "[alfaos-backup] outra execucao em andamento" >&2
  exit 75 # EX_TEMPFAIL
fi

dia="$(date -u +%Y%m%d)"
inicio="$(date -Is)"
mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/monthly" || exit 74
umask 077

banco="$DEST/daily/alfaos-db-$dia.sql.gz"
arquivos="$DEST/daily/alfaos-storage-$dia.tar.gz"

echo "[alfaos-backup] inicio=$inicio destino=$DEST"

# 1) Banco. `pg_dump` lê PGHOST/PGPORT/PGDATABASE/PGUSER do ambiente e a senha
#    do ~/.pgpass — nada disso vira argumento visível em `ps`.
if ! pg_dump --format=plain --no-owner --no-privileges | gzip -9 > "$banco.parcial"; then
  echo "[alfaos-backup] pg_dump FALHOU" >&2
  rm -f "$banco.parcial"
  exit 1
fi
mv "$banco.parcial" "$banco"

# 2) Storage. Estrutura e permissões preservadas; nada de release, node_modules
#    ou temporário — a raiz de produção não os contém, por contrato.
if ! tar --create --gzip --preserve-permissions \
      --file "$arquivos.parcial" \
      --directory "$STORAGE" .; then
  echo "[alfaos-backup] tar do storage FALHOU" >&2
  rm -f "$arquivos.parcial"
  exit 1
fi
mv "$arquivos.parcial" "$arquivos"

# 3) Retenção: 7 diários, 4 semanais (domingo), 3 mensais (dia 01). Cópia, não
#    link: um diário apagado não pode levar o mensal junto.
if [ "$(date -u +%u)" = "7" ]; then
  cp -p "$banco" "$arquivos" "$DEST/weekly/"
fi
if [ "$(date -u +%d)" = "01" ]; then
  cp -p "$banco" "$arquivos" "$DEST/monthly/"
fi

podar() { # <diretorio> <quantos manter de cada tipo>
  local dir="$1" manter="$2" prefixo
  for prefixo in alfaos-db alfaos-storage; do
    ls -1t "$dir/$prefixo-"* 2>/dev/null | tail -n "+$((manter + 1))" | while read -r velho; do
      rm -f "$velho"
    done
  done
}
podar "$DEST/daily" 7
podar "$DEST/weekly" 4
podar "$DEST/monthly" 3

echo "[alfaos-backup] banco=$(stat -c %s "$banco") bytes storage=$(stat -c %s "$arquivos") bytes"

# 4) Cópia EXTERNA. Sem ela, isto é backup de falha de operação, não de desastre.
#    Nenhuma ferramenta remota é instalada por conta própria: o destino é decisão
#    do dono (OWNER DECISION REQUIRED — OFF-SITE BACKUP DESTINATION).
if [ -n "${ALFAOS_OFFSITE_CMD:-}" ]; then
  if ! "$SHELL" -c "$ALFAOS_OFFSITE_CMD" "$banco" "$arquivos"; then
    echo "[alfaos-backup] copia externa FALHOU" >&2
    exit 1
  fi
  echo "[alfaos-backup] copia externa concluida"
else
  echo "[alfaos-backup] AVISO: sem copia externa — este backup NAO e disaster recovery"
fi

echo "[alfaos-backup] fim=$(date -Is) exit=0"
