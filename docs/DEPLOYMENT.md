# AlfaOS — implantação em VPS Linux

> **Estado: `READY FOR VPS PROVISIONING` (17/09/2026, `RC-1F-B`).**
> Nada aqui foi executado: não existe VPS, domínio, certificado, banco de
> produção nem cron ativo. Este documento e os modelos em `deploy/` são o
> contrato que a provisão vai seguir — e o que os testes `OPS-*`
> (`src/tests/deployment-contract.test.ts`) prendem ao código real.
>
> Arquitetura aprovada pelo dono: **VPS Linux, instância única, Nginx, systemd,
> PostgreSQL no próprio VPS, storage local persistente, cron do sistema.** Sem
> Docker, sem Kubernetes, sem painel, sem armazenamento de objeto na V1.

---

## 1. Runtime

| Peça | Versão | Por quê |
| --- | --- | --- |
| Distribuição | Ubuntu Server **24.04 LTS** | suporte longo, `systemd`, `cron`, Nginx e PostgreSQL nos repositórios oficiais |
| Node.js | **24 LTS** (piso 20.11) | é a linha usada no desenvolvimento; `next@14.2` pede ≥ 18.17 e `prisma@6` ≥ 18.18 |
| PostgreSQL | **16** | o que a 24.04 traz; o projeto exige 15+ |
| Nginx | do repositório da distribuição | proxy reverso e TLS |

O repositório **não fixa `engines`**, então a versão de Node é decisão de
operação — e fica registrada aqui. Instale o Node por repositório de pacote
(NodeSource ou equivalente), não por gerenciador de versão de usuário: o
`systemd` e o `cron` precisam de um binário em caminho fixo.

**Instância única, e isso é contrato.** O limitador de login, o de diagnóstico
e a fila de bcrypt vivem na memória do processo. Duas instâncias dobram esses
limites sem avisar. Escalar horizontalmente exige movê-los para fora do
processo — não é assunto da V1.

---

## 2. Layout de arquivos

```text
/opt/alfaos/releases/<data-hora>/   release (checkout + node_modules + .next)
/opt/alfaos/current  -> releases/…  link simbólico: o release em uso
/opt/alfaos/bin/                    alfaos-job.sh · alfaos-backup.sh
/etc/alfaos/alfaos.env              ambiente — ÚNICA fonte, fora do Git
/srv/alfaos/storage/                STORAGE_ROOT — fotos, assinaturas
/var/backups/alfaos/                backups locais (daily · weekly · monthly)
/var/lib/alfaos/backup.lock         trava entre backup e expurgo de etiqueta
```

**`STORAGE_ROOT` fica FORA do release, e a aplicação recusa o contrário.** Em
produção a raiz precisa ser absoluta, não pode estar dentro do diretório da
aplicação (nem contê-lo) e não pode ser o temporário do sistema
(`resolveStorageRoot`, `RC-1F-B`). O defeito que isso impede é silencioso: com
a raiz dentro do release, o deploy seguinte troca o diretório e as fotos de
evidência ficam para trás com o banco ainda apontando para elas — descobre-se
meses depois, quando alguém abre uma OS antiga.

---

## 3. Usuário de serviço

```bash
adduser --system --group --home /var/lib/alfaos --shell /usr/sbin/nologin alfaos

install -d -o alfaos -g alfaos -m 0750 /srv/alfaos/storage
install -d -o alfaos -g alfaos -m 0750 /var/lib/alfaos
install -d -o root   -g alfaos -m 0750 /etc/alfaos
install -d -o alfaos -g alfaos -m 0750 /var/backups/alfaos
install -d -o alfaos -g alfaos -m 0755 /opt/alfaos/releases /opt/alfaos/bin
```

- A aplicação **não roda como root** e não cria a raiz de armazenamento sozinha:
  quem a cria é a provisão, com dono e modo próprios.
- **O Nginx não recebe acesso de escrita ao storage** — ele nem lê o storage
  (§6): toda foto sai por rota autorizada, que confere empresa e posse.
- `/etc/alfaos` é `root:alfaos 0750`, e o arquivo de ambiente é `0640`: o
  serviço lê, o mundo não.

---

## 4. Ambiente — uma fonte só

`/etc/alfaos/alfaos.env` alimenta **o web e todos os comandos**. O systemd o lê
por `EnvironmentFile`; o `cron` o lê pelo invólucro `alfaos-job.sh`. Duas fontes
seriam duas verdades — e a divergente seria descoberta num upload perdido ou num
diagnóstico que não roda.

```bash
install -o root -g alfaos -m 0640 /dev/null /etc/alfaos/alfaos.env
```

Mínimo de produção (a descrição de cada variável está em `.env.example`):

```ini
NODE_ENV=production
PORT=3000
DATABASE_URL=...                      # sem aspas desnecessárias; nunca versionado
AUTH_SECRET=...                       # openssl rand -base64 48
STORAGE_ROOT=/srv/alfaos/storage
APP_ORIGINS=https://<dominio>
TRUSTED_PROXY_HOPS=1                  # exatamente UM proxy (Nginx) na frente
ERP_CREDENTIAL_ENCRYPTION_KEY=...     # openssl rand -base64 32
CUSTOMER_CREDENTIAL_ENCRYPTION_KEY=...
MAP_TILE_URL=...                      # provedor contratado, não o OSM público
```

`TRUSTED_PROXY_HOPS=1` **é o par do Nginx**: o proxy ACRESCENTA ao
`x-forwarded-for`, e o limitador lê o endereço na posição `(total - hops)`. Com
0, o cabeçalho é ignorado e todo mundo compartilha o balde do servidor; com
número maior que o real, o cliente escolhe o próprio IP.

**As chaves de cifra não entram no backup** (§9) e **não podem ser perdidas**:
sem elas, o banco restaurado tem credenciais de ERP e senhas PPPoE ilegíveis.
Guarde-as onde o dono guarda segredo — cofre, não o mesmo disco do backup.

---

## 5. PostgreSQL

```bash
sudo -u postgres createuser --pwprompt alfaos
sudo -u postgres createdb --owner=alfaos alfaos
```

- **Não exponha a porta 5432 à internet.** `listen_addresses = 'localhost'` (o
  padrão da distribuição) e regra de firewall (§11).
- Banco e usuário dedicados, senha forte.
- A senha do backup vai em `~alfaos/.pgpass` (`0600`), nunca em argumento de
  processo — `ps` é legível por qualquer usuário do host.

```text
localhost:5432:alfaos:alfaos:<senha>
```

Migrations em produção: **`npx prisma migrate deploy`**, nunca `migrate dev`,
nunca `db push`.

---

## 6. Nginx e HTTPS

Modelo: `deploy/nginx/alfaos.conf.template` (troque `ALFAOS_DOMAIN`).

- Encaminha para `127.0.0.1:3000`; **a porta do Next.js nunca é pública**.
- `client_max_body_size 9m` — o maior corpo da aplicação é 8 MiB de foto mais
  64 KiB de campos. Menor que isso, o técnico recebe um 413 de HTML do Nginx em
  vez da recusa tipada da aplicação.
- Tempos de 120 s: foto de 8 MiB em 4G de borda de cidade não cabe nos 60 s
  padrão.
- **Nenhum `location` serve o storage**, e o diretório não aparece no arquivo.

Certificado com `certbot --nginx` **depois** de o domínio apontar para o host.
Sem domínio real não há certificado — e não há como fabricá-lo aqui.

---

## 7. Processo web

Modelo: `deploy/systemd/alfaos-web.service`.

```bash
install -m 0644 deploy/systemd/alfaos-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now alfaos-web
systemctl status alfaos-web
journalctl -u alfaos-web -n 50
```

`Restart=on-failure` com `StartLimitBurst=5` em 300 s: queda reinicia, erro de
configuração para de vez e fica **visível** no `status`, em vez de inundar o
log reiniciando para sempre.

---

## 8. Deploy

```bash
REL=/opt/alfaos/releases/$(date -u +%Y%m%d%H%M%S)
sudo -u alfaos git clone --depth 1 <repo> "$REL"      # ou envio do artefato
cd "$REL"
sudo -u alfaos npm ci                                  # COM devDependencies
set -a; . /etc/alfaos/alfaos.env; set +a
sudo -u alfaos --preserve-env npx prisma migrate deploy
sudo -u alfaos --preserve-env npm run build            # next build + build:worker
sudo -u alfaos ln -sfn "$REL" /opt/alfaos/current
sudo systemctl restart alfaos-web
```

- **`npm ci` completo, sem `--omit=dev`.** A CLI do Prisma é `devDependency` e é
  ela que aplica as migrations; o `build` também precisa do TypeScript. Não
  rode `npm prune --omit=dev` depois: foi exatamente isso que quebrou o worker
  na v0.9 (`OPS-01`).
- **Compilar ANTES de trocar o link.** Uma compilação que falha deixa o release
  anterior rodando; o `ln -sfn` só acontece depois do sucesso.
- Voltar atrás é apontar o link para o release anterior e reiniciar. Migrations
  não voltam sozinhas — reverter schema é decisão à parte.
- **O storage sobrevive porque está fora do release** (§2), e a fase C da
  validação (§13) prova isso com uma foto real.

---

## 9. Backup

Script: `deploy/bin/alfaos-backup.sh`, diário às 02:00 (fuso do servidor).

**Conteúdo obrigatório:**

1. **Banco** — `pg_dump` comprimido, autenticando por `.pgpass`.
2. **Storage** — `tar` da raiz de produção, com permissões.
3. **Chaves de cifra** — **fora deste backup, guardadas pelo dono à parte**. Um
   backup que as carrega transforma o roubo do backup no roubo das credenciais
   de ERP de todas as empresas.

**Ordem e consistência.** Banco primeiro, storage depois: o arquivo é gravado
antes da linha que o referencia e a linha é apagada antes do arquivo, então a
cópia posterior do storage contém tudo o que o dump menciona. **Janela residual
declarada:** uma foto enviada depois do dump e antes do `tar` entra no backup
sem linha no banco — órfã na restauração, que `npm run storage:audit` conta. O
caminho oposto (linha sem arquivo) não acontece. A aplicação **não é parada**
para o backup; o único trabalho excluído é o expurgo de etiqueta, por uma trava
compartilhada (`/var/lib/alfaos/backup.lock`).

**Retenção:** 7 diários, 4 semanais (domingo), 3 mensais (dia 01) — cópias
independentes, feitas com ferramentas do sistema. Nenhum pacote novo foi
instalado para isso.

> **`OWNER DECISION REQUIRED — OFF-SITE BACKUP DESTINATION`.** Backup que mora
> no mesmo VPS morre com o VPS: isso é proteção contra erro de operação, não
> contra desastre. O script tem um gancho (`ALFAOS_OFFSITE_CMD`) e **nenhuma
> ferramenta remota foi escolhida ou instalada** — destino, credencial e
> ferramenta são decisão do dono. Enquanto ela não vier, cada execução registra
> o aviso de que aquele backup não é disaster recovery.

---

## 10. Restauração — runbook

Ordem, e ela importa:

1. **Host limpo** com §1 a §7 provisionados (sem cron ativo).
2. **Segredos** — `/etc/alfaos/alfaos.env` com as MESMAS chaves de cifra do
   ambiente de origem. Sem `ERP_CREDENTIAL_ENCRYPTION_KEY` e
   `CUSTOMER_CREDENTIAL_ENCRYPTION_KEY`, o restante é inútil.
3. **Banco** — `createdb` e `gunzip -c alfaos-db-*.sql.gz | psql`.
4. **Migrations** — `npx prisma migrate status` deve dizer que está em dia.
5. **Storage** — `tar -xzpf alfaos-storage-*.tar.gz -C /srv/alfaos/storage`.
6. **Permissões** — `chown -R alfaos:alfaos /srv/alfaos/storage`.
7. **Web** — `systemctl start alfaos-web` e conferir o `status`.
8. **`npm run storage:audit`** — só leitura: conta referências, arquivos
   ausentes e órfãos. É aqui que a janela do §9 aparece, se apareceu.
9. **Conferir três artefatos pela interface**: uma evidência de OS, uma foto de
   CTO e uma assinatura. Byte que chegou não é o mesmo que imagem que abre —
   essa distinção custou a `CTO-1.8`.
10. **`npm run diagnostics:dry-run`** — sem rede ao provider, só a contagem.
11. **Crons por último**, na ordem da fase G (§13).

> **`RESTORE DRILL — PENDING VPS/STAGING VALIDATION`.** Sem servidor, nada disso
> foi executado, e nenhuma restauração pode ser declarada `PASS`.

---

## 11. Rede, firewall e acesso

| Porta | Exposição |
| --- | --- |
| 80 / 443 | pública (80 só redireciona e responde ao desafio do certificado) |
| 22 | restrita à origem operacional, chave pública, sem senha |
| 3000 | **loopback**, nunca pública |
| 5432 | **loopback**, nunca pública |

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

Saída necessária: ERP (ReceitaNet), FCM e o provedor de tiles.

---

## 12. Operação

**Logs.** Web e comandos escrevem no `journald` (`alfaos-web`, `alfaos-outbox`,
`alfaos-diagnostics`, `alfaos-evidence-cleanup`, `alfaos-backup`); o Nginx usa
`/var/log/nginx` com o `logrotate` da distribuição. Limite o journal
(`SystemMaxUse=500M` em `/etc/systemd/journald.conf`) — o disco é o mesmo das
fotos. **Nenhum log carrega dado pessoal**: os comandos imprimem contagens.

**Fuso.** Servidor em **UTC** (`timedatectl set-timezone UTC`) e NTP ligado. O
cron usa o fuso do servidor; o dia civil da operação é outro assunto e vem de
`Company.timezone`, dentro da aplicação. Não misture os dois ao ler um horário.

**Disco.** Confira periodicamente: `df -h`, `du -sh /srv/alfaos/storage`,
`du -sh /var/backups/alfaos`, e o tamanho do banco
(`SELECT pg_size_pretty(pg_database_size('alfaos'))`). Foto de evidência só
cresce; backup também.

**Agendadores.** `deploy/cron/alfaos.crontab`, instalado como o usuário de
serviço (`sudo -u alfaos crontab deploy/cron/alfaos.crontab`), nunca como root.

| Comando | Cadência | Estado |
| --- | --- | --- |
| `outbox:work` | 1 min | ativo — é a entrega de notificação ao técnico |
| `diagnostics:refresh` | 1 min | **comentado** até a fase F |
| `evidence:cleanup` | diário, 03:15 | ativo |
| `alfaos-backup.sh` | diário, 02:00 | ativo |

**Não agendados, de propósito:** o expurgo de órfãos do storage e a
re-sanitização de fotos legadas continuam operações manuais, com escopo
explícito e decisão do dono (`docs/SECURITY.md` §8.25).

---

## 13. Plano de validação do dono (quando houver VPS)

- **A — provisão:** distribuição, Node, PostgreSQL, Nginx, usuário de serviço,
  diretórios e permissões (§1–§5).
- **B — deploy:** ambiente, `migrate deploy`, `build`, serviço no ar por HTTPS,
  login de um usuário real.
- **C — storage sobrevive:** enviar uma foto, reiniciar o serviço, **fazer um
  deploy novo** e abrir a mesma foto. É a prova de que a raiz está fora do
  release.
- **D — backup:** rodar o backup, restaurar em máquina/instância separada e
  percorrer o §10 inteiro.
- **E — comandos:** `outbox:work` uma vez, `diagnostics:dry-run`,
  `evidence:cleanup` uma vez, conferindo as contagens no journal.
- **F — piloto de diagnóstico:** o dono vê o dry-run **antes** de qualquer
  recorrência — elegíveis, empresas, providers, chamadas máximas ao provider e
  requisições HTTP máximas. Se quiser, uma validação de um cliente
  (`--customer-id`). Depois, **uma** volta controlada e conferência na tela.
- **G — agendadores:** habilitar o outbox, depois o diagnóstico (descomentar a
  linha), depois conferir o expurgo diário. Só então o estado passa de
  `CONFIGURADO` para `ATIVO`.

---

## 14. O que esta fase NÃO entrega

- **Nenhum deploy real.** Não há VPS, domínio, certificado nem cron instalado.
- **Nenhuma rota de saúde.** O repositório não tem uma, e criá-la é superfície
  de API nova: **`OWNER DECISION REQUIRED — HEALTH ENDPOINT`**. Enquanto isso,
  `systemctl status` e o journal são a verificação.
- **Nenhum armazenamento de objeto** (S3/R2) e nenhuma ferramenta de backup
  remoto.
- **Nenhuma chamada real a provider**, nenhuma ativação de cron, nenhum expurgo.
