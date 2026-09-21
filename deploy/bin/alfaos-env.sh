#!/usr/bin/env bash
# AlfaOS — leitura do ambiente de produção SEM avaliação de shell — SEC-006
#
# # O defeito
#
# `/etc/alfaos/alfaos.env` é lido por dois mundos com gramáticas diferentes:
#
#   systemd   EnvironmentFile=    lê o arquivo LITERALMENTE
#   scripts   . "$ENV_FILE"       EXECUTA o arquivo como código de shell
#
# Um caminho executa o que o outro trata como texto — e o caminho que executa
# roda como ROOT (`alfaos-backup.service`). Um valor como
#
#   DB_PASSWORD=sen$(id)ha
#
# é senha para o systemd e comando para o shell. Nem é preciso um atacante: uma
# senha com `$`, com backtick, com `\` ou com aspas é silenciosamente REESCRITA
# por um lado e não pelo outro, e a divergência aparece como "o web conecta e o
# worker não".
#
# # A regra
#
# `alfaos_carregar_ambiente` lê `KEY=value` e passa o valor ADIANTE, literal.
# Nada é expandido, nada é executado. O `export "$chave=$valor"` do bash atribui
# uma palavra já expandida: o conteúdo de `$valor` não volta ao analisador.
#
# E onde a gramática do systemd faria algo que este arquivo não faz — escape de
# `\` dentro de aspas duplas, continuação de linha —, a resposta é ERRO, nunca
# um palpite. Duas fontes divergindo em silêncio é exatamente o defeito; falhar
# alto mantém as duas honestas.
#
# Sem dependência nova: só bash.

# Ecoa na saída de erro sem depender de função do chamador.
_alfaos_env_erro() { echo "[alfaos-env] $*" >&2; }

# ---------------------------------------------------------------------------
# Ambiente
# ---------------------------------------------------------------------------

# Lê o arquivo e exporta o que ele define. Devolve 78 (EX_CONFIG) em qualquer
# linha que não caiba na gramática suportada.
alfaos_carregar_ambiente() {
  local arquivo="$1"
  local linha chave valor numero=0

  if [ ! -r "$arquivo" ]; then
    _alfaos_env_erro "ambiente ilegivel: $arquivo"
    return 78
  fi

  while IFS= read -r linha || [ -n "$linha" ]; do
    numero=$((numero + 1))

    # Arquivo salvo com CRLF não pode virar valor com CR no fim.
    linha="${linha%$'\r'}"
    # Espaço à esquerda não é significativo, no systemd nem aqui.
    linha="${linha#"${linha%%[![:space:]]*}"}"

    case "$linha" in
      '' | '#'* | ';'*) continue ;;
    esac

    # `export KEY=valor` é aceito por conveniência do operador.
    case "$linha" in
      'export '*) linha="${linha#export }" ;;
    esac

    case "$linha" in
      *=*) ;;
      *)
        _alfaos_env_erro "$arquivo:$numero — linha sem '=' e sem ser comentario"
        return 78
        ;;
    esac

    chave="${linha%%=*}"
    valor="${linha#*=}"

    # Nome de variável de ambiente, e nada além disso.
    case "$chave" in
      '' | [0-9]* | *[!A-Za-z0-9_]*)
        _alfaos_env_erro "$arquivo:$numero — nome de variavel invalido"
        return 78
        ;;
    esac

    # Um par de aspas que envolve o valor INTEIRO é removido, como no systemd.
    # Aspas no meio do valor são parte do valor.
    case "$valor" in
      '"'*'"')
        valor="${valor#\"}"
        valor="${valor%\"}"
        # O systemd processaria `\n`, `\t`, `\\` aqui. Este arquivo não — e não
        # adivinha: um valor com `\` entre aspas duplas seria lido diferente
        # pelos dois lados, então é erro.
        case "$valor" in
          *\\*)
            _alfaos_env_erro "$arquivo:$numero — '\\' entre aspas duplas nao e suportado"
            return 78
            ;;
        esac
        ;;
      "'"*"'")
        valor="${valor#\'}"
        valor="${valor%\'}"
        ;;
      *)
        # Sem aspas: espaço no fim não é significativo (idem systemd). O do
        # meio é, e por isso só o final sai.
        valor="${valor%"${valor##*[![:space:]]}"}"
        # Continuação de linha muda o significado do arquivo inteiro: recusa.
        case "$valor" in
          *\\)
            _alfaos_env_erro "$arquivo:$numero — continuacao de linha nao e suportada"
            return 78
            ;;
        esac
        ;;
    esac

    # O valor NÃO volta ao analisador: `export` recebe uma palavra já expandida.
    export "$chave=$valor"
  done < "$arquivo"

  return 0
}

# ---------------------------------------------------------------------------
# Alvo do PostgreSQL
# ---------------------------------------------------------------------------

# Decodifica `%XX`. O `\` literal é escapado antes para não virar escape do
# `printf`, que é o único jeito de decodificar sem sub-processo.
alfaos_percent_decode() {
  local texto="$1"
  texto="${texto//\\/\\\\}"
  printf '%b' "${texto//%/\\x}"
}

# Deriva o alvo do `pg_dump` de DATABASE_URL e o exporta em variáveis do libpq.
#
# # Por que daqui, e não de um segundo arquivo
#
# A revisão de segurança independente encontrou o `pg_dump` sem NENHUM alvo de
# banco (`SEC-001`): sem `--dbname` e sem `PGDATABASE`, o libpq cai no nome do
# usuário do sistema operacional — `root`, porque o backup roda como root. O
# backup diário do produto nunca teria funcionado, e um alvo adivinhado é pior
# que um erro: se um `PGDATABASE` qualquer estivesse no ambiente, a geração
# sairia rotulada `COMPLETE` com o banco ERRADO dentro.
#
# O alvo vem de `DATABASE_URL` porque ela é a fonte autoritativa declarada em
# `docs/DEPLOYMENT.md` §4. Derivar dela não cria uma segunda autoridade — é a
# mesma, traduzida para o vocabulário do libpq. Uma cópia à parte da senha
# criaria: ela pode divergir na rotação, e a divergência aparece só no dia da
# restauração.
#
# A senha viaja pelo AMBIENTE do processo, nunca em argumento: `ps` é legível
# por qualquer usuário do host, e `/proc/<pid>/environ` só pelo dono. Quando a
# URL não traz senha, `PGPASSWORD` não é definida e o libpq segue o caminho dele
# (`~/.pgpass`, peer, o que o host tiver) — sem um `if` nosso escolhendo.
alfaos_exportar_alvo_pg() {
  local url="${DATABASE_URL:-}"

  if [ -z "$url" ]; then
    _alfaos_env_erro "DATABASE_URL ausente — sem alvo nao existe backup do banco"
    return 78
  fi

  case "$url" in
    postgresql://* | postgres://*) ;;
    *)
      _alfaos_env_erro "DATABASE_URL nao e uma URL postgres"
      return 78
      ;;
  esac

  local resto="${url#*://}"
  resto="${resto%%\#*}"  # fragmento
  resto="${resto%%\?*}"  # query (`?schema=public` nao descreve o alvo)

  local userinfo="" endereco="$resto"
  case "$resto" in
    # O ÚLTIMO `@` separa: um `@` na senha precisa vir percent-encoded, e usar o
    # último é o que tolera uma URL escrita à mão sem quebrar a correta.
    *@*)
      userinfo="${resto%@*}"
      endereco="${resto##*@}"
      ;;
  esac

  local banco=""
  case "$endereco" in
    */*) banco="${endereco#*/}" ;;
  esac
  local hostport="${endereco%%/*}"

  # Host entre colchetes é IPv6 e o `:` de dentro não é separador de porta.
  local host="" porta=""
  case "$hostport" in
    '['*']'*)
      host="${hostport%%]*}"
      host="${host#[}"
      porta="${hostport##*]}"
      porta="${porta#:}"
      ;;
    *:*)
      host="${hostport%%:*}"
      porta="${hostport##*:}"
      ;;
    *) host="$hostport" ;;
  esac

  local usuario="" senha=""
  if [ -n "$userinfo" ]; then
    case "$userinfo" in
      *:*)
        usuario="$(alfaos_percent_decode "${userinfo%%:*}")"
        senha="$(alfaos_percent_decode "${userinfo#*:}")"
        ;;
      *) usuario="$(alfaos_percent_decode "$userinfo")" ;;
    esac
  fi

  banco="$(alfaos_percent_decode "$banco")"
  if [ -z "$banco" ]; then
    _alfaos_env_erro "DATABASE_URL sem nome de banco — o alvo do dump seria adivinhado"
    return 78
  fi

  # O libpq EXPANDE o `dbname` quando ele contém `=` ou parece uma URI. Um nome
  # assim viraria string de conexão e mandaria o dump para outro lugar.
  case "$banco" in
    *=* | *://*)
      _alfaos_env_erro "nome de banco invalido — seria lido como string de conexao"
      return 78
      ;;
  esac

  ALFAOS_PG_DATABASE="$banco"
  [ -n "$host" ] && export PGHOST="$host"
  [ -n "$porta" ] && export PGPORT="$porta"
  [ -n "$usuario" ] && export PGUSER="$usuario"
  [ -n "$senha" ] && export PGPASSWORD="$senha"
  return 0
}
