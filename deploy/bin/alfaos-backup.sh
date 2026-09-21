#!/usr/bin/env bash
# AlfaOS — backup diário com JANELA DE MANUTENÇÃO — RC-1F-B (addendum)
#
# # Por que a aplicação para
#
# A versão anterior copiava banco e storage com o web no ar e afirmava que a
# ordem (banco primeiro) só podia produzir arquivo órfão. Isso estava ERRADO, e
# o contraexemplo é banal:
#
#   T1  pg_dump grava a linha da evidência X, que aponta para o arquivo X
#   T2  o técnico apaga essa evidência pela aplicação
#   T3  a aplicação apaga o arquivo X do storage  (removeEvidence)
#   T4  o tar do storage roda — e X não existe mais
#
# Restaurar essa geração dá um banco que referencia uma foto que o backup não
# tem. É perda silenciosa: ninguém percebe até abrir a OS. O mesmo vale para a
# assinatura substituída, que apaga a anterior.
#
# A cura da V1 é uma janela curta: todo processo capaz de alterar arquivo do
# STORAGE_ROOT — ou a referência a ele — fica fora da seção crítica. O que sai
# disso NÃO é um congelamento do PostgreSQL: é uma GERAÇÃO CONSISTENTE EM
# REFERÊNCIAS DE STORAGE — toda linha do dump que aponta para um arquivo tem
# esse arquivo dentro do tar. Diagnóstico e outbox seguem rodando, porque não
# tocam arquivo nem referência. É minutos por noite, e é a solução mais simples
# que resolve — sem lock distribuído, sem modo de manutenção na aplicação, sem
# tabela nova, sem dependência.
#
# # Quem mais mexe no storage
#
#   web (este serviço)    evidência (criar/apagar), assinatura (criar/substituir),
#                         foto de CTO (criar) — PARA durante a janela
#   evidence:cleanup      apaga etiqueta vencida — excluído pela trava
#   outbox · diagnóstico  NÃO tocam o storage (verificado no código)
#   expurgo · re-sanit.   manuais, com escopo — não rodar durante a janela
#
# # Privilégio
#
# Este script roda como ROOT, por `alfaos-backup.service`/`.timer` — é o mínimo
# que consegue parar e subir o serviço. O usuário `alfaos` NÃO ganha sudo.
#
# O alvo e a credencial do banco vêm de `DATABASE_URL`, a fonte autoritativa
# (`docs/DEPLOYMENT.md` §4), traduzida para variáveis do libpq por
# `alfaos-env.sh`. NADA de senha em argumento: `ps` é legível por qualquer
# usuário do host, e `/proc/<pid>/environ` só pelo dono. Quando a URL não traz
# senha, o libpq segue o caminho dele (`~/.pgpass`, peer) sem escolha nossa.
set -uo pipefail

ENV_FILE="${ALFAOS_ENV_FILE:-/etc/alfaos/alfaos.env}"
LOCK_FILE="${ALFAOS_BACKUP_LOCK:-/var/lib/alfaos/backup.lock}"
DEST="${ALFAOS_BACKUP_DIR:-/var/backups/alfaos}"
WEB_UNIT="${ALFAOS_WEB_UNIT:-alfaos-web}"

log() { echo "[alfaos-backup] $*"; }
erro() { echo "[alfaos-backup] $*" >&2; }

# ---------------------------------------------------------------------------
# Ambiente
# ---------------------------------------------------------------------------

# O ambiente é lido LITERALMENTE, nunca executado (`SEC-006`). Este script roda
# como root: `. "$ENV_FILE"` transformava cada valor do arquivo de configuração
# em código de shell privilegiado.
ENV_LIB="$(dirname "$0")/alfaos-env.sh"
if [ ! -r "$ENV_LIB" ]; then
  erro "biblioteca de ambiente ausente: $ENV_LIB"
  exit 78 # EX_CONFIG
fi
# shellcheck source=deploy/bin/alfaos-env.sh
. "$ENV_LIB"

# A fonte é o ARQUIVO, nunca o ambiente herdado (`SEC-001`).
#
# `unset` antes de ler: um `DATABASE_URL` exportado por engano na sessão faria o
# backup copiar OUTRO banco, e um `PGDATABASE` qualquer no ambiente faria o
# libpq usá-lo mesmo com o arquivo correto — a geração sairia rotulada
# `COMPLETE` com o banco errado dentro. O systemd e o cron entregam ambiente
# limpo; esta linha vale para o operador que roda o script à mão.
unset DATABASE_URL STORAGE_ROOT
unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE
alfaos_carregar_ambiente "$ENV_FILE" || exit 78

STORAGE="${STORAGE_ROOT:-}"
if [ -z "$STORAGE" ] || [ ! -d "$STORAGE" ]; then
  erro "STORAGE_ROOT ausente ou inexistente — backup incompleto nao serve"
  exit 78
fi

# O alvo do dump vem de DATABASE_URL (`SEC-001`). Antes de parar o serviço: um
# erro de configuração não pode custar uma janela de manutenção.
alfaos_exportar_alvo_pg || exit 78

# ---------------------------------------------------------------------------
# Estado e recuperação
# ---------------------------------------------------------------------------

GERACAO="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DEST/.parcial/$GERACAO"
DB_TMP="$TMP/alfaos-$GERACAO-db.sql.gz"
ST_TMP="$TMP/alfaos-$GERACAO-storage.tar.gz"
MAN_TMP="$TMP/alfaos-$GERACAO.manifest"
web_parado=0
restart_falhou=0

# A aplicação NUNCA pode ficar parada até de manhã por causa de um backup. O
# `trap` roda em qualquer saída — erro, `exit`, sinal — e é o que garante isso.
restaurar_web() {
  [ "$web_parado" = 1 ] || return 0
  log "subindo $WEB_UNIT"
  if systemctl start "$WEB_UNIT" && systemctl is-active --quiet "$WEB_UNIT"; then
    web_parado=0
    log "$WEB_UNIT ativo"
    return 0
  fi
  restart_falhou=1
  erro "FALHA CRITICA: $WEB_UNIT NAO subiu — a aplicacao esta FORA DO AR."
  erro "acao do operador: systemctl start $WEB_UNIT && systemctl status $WEB_UNIT"
  return 1
}

finalizar() {
  local codigo=$?
  restaurar_web || codigo=1
  [ "$restart_falhou" = 1 ] && codigo=1
  # O parcial não pode sobrar parecendo backup. O diretório-pai sai também,
  # quando vazio, para `ls` do operador não mostrar sobra de execução antiga.
  rm -rf "$TMP"
  rmdir "$DEST/.parcial" 2>/dev/null
  exit "$codigo"
}
trap finalizar EXIT

# ---------------------------------------------------------------------------
# Passos
# ---------------------------------------------------------------------------

travar() {
  # Exclusão com o expurgo de etiqueta, que apaga arquivo enquanto isto copia.
  exec 9>>"$LOCK_FILE" || return 1
  flock -w 300 9 || return 1
  return 0
}

parar_web() {
  log "parando $WEB_UNIT para a janela de manutencao"
  if ! systemctl stop "$WEB_UNIT"; then
    erro "ABORTADO: nao foi possivel parar $WEB_UNIT — nada foi copiado"
    return 1
  fi
  # Parar sem PROVAR que parou não vale: um backup tirado com o web no ar seria
  # rotulado consistente sem ser.
  if systemctl is-active --quiet "$WEB_UNIT"; then
    erro "ABORTADO: $WEB_UNIT continua ativo — nada foi copiado"
    return 1
  fi
  web_parado=1
  log "$WEB_UNIT inativo — janela aberta"
  return 0
}

dump_banco() {
  # O ALVO é explícito (`SEC-001`). Sem `--dbname`, o libpq cai no nome do
  # usuário do sistema — `root` aqui —, e um alvo adivinhado é pior que um erro:
  # com um `PGDATABASE` qualquer no ambiente, a geração sairia rotulada
  # `COMPLETE` com o banco errado dentro. O nome não é segredo e pode ir em
  # argumento; a senha vai pelo ambiente, porque `ps` é público.
  log "dump do banco alvo=$ALFAOS_PG_DATABASE"
  if ! pg_dump --dbname="$ALFAOS_PG_DATABASE" \
      --format=plain --no-owner --no-privileges | gzip -9 > "$DB_TMP"; then
    erro "pg_dump FALHOU — geracao $GERACAO descartada"
    return 1
  fi
  return 0
}

arquivar_storage() {
  log "arquivando o storage"
  if ! tar --create --gzip --preserve-permissions --file "$ST_TMP" --directory "$STORAGE" .; then
    erro "tar do storage FALHOU — geracao $GERACAO descartada"
    return 1
  fi
  return 0
}

promover_geracao() {
  # Manifesto por último: enquanto ele não existe, a geração não está completa.
  # Retenção e restauração olham o manifesto, então um backup interrompido nunca
  # se parece com um válido.
  {
    echo "generation=$GERACAO"
    echo "created_at=$(date -Is)"
    echo "database=$(basename "$DB_TMP")"
    echo "storage=$(basename "$ST_TMP")"
    echo "database_sha256=$(sha256sum "$DB_TMP" | cut -d' ' -f1)"
    echo "storage_sha256=$(sha256sum "$ST_TMP" | cut -d' ' -f1)"
    echo "database_bytes=$(stat -c %s "$DB_TMP")"
    echo "storage_bytes=$(stat -c %s "$ST_TMP")"
    echo "web_stopped_during_copy=yes"
    echo "status=COMPLETE"
  } > "$MAN_TMP" || return 1

  mv "$DB_TMP" "$ST_TMP" "$MAN_TMP" "$DEST/daily/" || return 1
  log "geracao $GERACAO completa em $DEST/daily"
  return 0
}

# Promove a geração do dia para uma faixa de retenção.
#
# `SEC-012`: a versão anterior chamava `cp -p` e IGNORAVA o resultado — disco
# cheio, permissão, ponto de montagem ausente, e o script seguia para a poda e
# terminava com `exit=0`. O operador lia "fim exit=0" enquanto o semanal não
# tinha sido criado, e a poda então empurrava o último semanal BOM para fora da
# retenção. É a pior forma de perder backup: silenciosa e com relatório verde.
copiar_para_faixa() {
  local faixa="$1"
  local id="alfaos-$GERACAO"
  if ! cp -p \
      "$DEST/daily/$id-db.sql.gz" \
      "$DEST/daily/$id-storage.tar.gz" \
      "$DEST/daily/$id.manifest" \
      "$DEST/$faixa/"; then
    erro "copia para $faixa FALHOU — a faixa NAO foi podada e a geracao anterior fica"
    return 1
  fi
  # Manifesto por último também aqui: até ele chegar, a cópia não é geração.
  if [ ! -s "$DEST/$faixa/$id.manifest" ]; then
    erro "copia para $faixa incompleta — a faixa NAO foi podada"
    return 1
  fi
  log "geracao $GERACAO copiada para $faixa"
  return 0
}

# Rotaciona GERAÇÕES COMPLETAS (as que têm manifesto), nunca arquivos soltos:
# uma geração parcial não pode empurrar a última boa para fora da janela.
podar() {
  local dir="$1" manter="$2" manifesto id
  ls -1t "$dir"/alfaos-*.manifest 2>/dev/null | tail -n "+$((manter + 1))" | while read -r manifesto; do
    id="$(basename "$manifesto" .manifest)"
    rm -f "$dir/$id-db.sql.gz" "$dir/$id-storage.tar.gz" "$manifesto"
  done
}

copia_externa() {
  # SÓ DEPOIS de a aplicação voltar: a cópia remota pode ser lenta ou falhar, e
  # nada disso pode manter o AlfaOS fora do ar.
  if [ -z "${ALFAOS_OFFSITE_CMD:-}" ]; then
    log "LOCAL BACKUP COMPLETE — DISASTER RECOVERY COPY NOT CONFIGURED"
    return 0
  fi
  if ! bash -c "$ALFAOS_OFFSITE_CMD" _ \
      "$DEST/daily/alfaos-$GERACAO-db.sql.gz" \
      "$DEST/daily/alfaos-$GERACAO-storage.tar.gz" \
      "$DEST/daily/alfaos-$GERACAO.manifest"; then
    erro "copia externa FALHOU — a geracao local esta completa"
    return 1
  fi
  log "copia externa concluida"
  return 0
}

# ---------------------------------------------------------------------------
# SEQUÊNCIA — a ordem É o contrato
#
#   travar → parar web → provar parado → dump → storage → subir web →
#   promover geração → cópia externa
# ---------------------------------------------------------------------------

umask 077
mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/monthly" "$TMP" || exit 74
log "inicio geracao=$GERACAO destino=$DEST"

travar || { erro "outra execucao em andamento"; exit 75; }
parar_web || exit 1
dump_banco || exit 1
arquivar_storage || exit 1
restaurar_web || exit 1
promover_geracao || exit 1
podar "$DEST/daily" 7

# Cada faixa só é podada se a PRÓPRIA promoção dela deu certo (`SEC-012`).
# Podar uma faixa onde a cópia falhou joga fora a última geração boa dela para
# abrir espaço a uma geração que não chegou.
faixa_falhou=0
if [ "$(date -u +%u)" = "7" ]; then
  if copiar_para_faixa weekly; then podar "$DEST/weekly" 4; else faixa_falhou=1; fi
fi
if [ "$(date -u +%d)" = "01" ]; then
  if copiar_para_faixa monthly; then podar "$DEST/monthly" 3; else faixa_falhou=1; fi
fi

copia_externa || exit 1

# A geração diária está completa, então o dia não é uma perda total — mas
# terminar com 0 diria que a retenção está em ordem, e ela não está.
if [ "$faixa_falhou" = 1 ]; then
  erro "fim geracao=$GERACAO exit=1 — diaria COMPLETA, retencao de faixa INCOMPLETA"
  exit 1
fi

log "fim geracao=$GERACAO exit=0"
