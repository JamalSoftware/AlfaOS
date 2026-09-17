/**
 * Auditoria de fotos e storage (`RC-1E`) — roda e sai.
 *
 * # O padrão é SÓ LER
 *
 * ```text
 * npm run storage:audit                      relatório, nada muda
 * npm run storage:audit -- --details         + ids das linhas e chaves órfãs
 * ```
 *
 * As duas ações que mudam alguma coisa exigem o nome da ação E `--apply`, e
 * cada uma só deve rodar por ordem explícita do dono, depois de o relatório
 * ter sido lido:
 *
 * ```text
 * node dist/scripts/photo-storage-audit.js --resanitize-legacy --apply
 * node dist/scripts/photo-storage-audit.js --purge-orphans --apply --scope missing-company
 * ```
 *
 * A ação sem `--apply` mostra só o que FARIA.
 *
 * # O expurgo exige ESCOPO
 *
 * `--purge-orphans --apply` sem `--scope missing-company` sai com erro, sem
 * apagar nada. `--scope active-company` só simula: apagar órfão de empresa que
 * existe é decisão de retenção do dono. Não existe escopo "todos".
 *
 * # Saída
 *
 * Contagens, e — com `--details` — ids de linha e chaves de storage, que são
 * ids de servidor. Nunca nome de cliente, caminho absoluto, bytes ou metadado:
 * o log de um comando operacional não é lugar de dado de cliente, e a
 * coordenada que a auditoria encontra é exatamente o que ela existe para
 * remover.
 */
import { prisma } from "../src/lib/prisma";
import { logServerError } from "../src/lib/safe-log";
import { getFileStorage } from "../src/lib/storage";
import {
  auditPhotoStorage,
  purgeOrphanFiles,
  OrphanPurgeScopeError,
  resanitizeLegacyPhotos,
} from "../src/lib/storage/photo-audit";

/** Lê `--scope valor` ou `--scope=valor`. */
function escopoDosArgumentos(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scope") return argv[i + 1] ?? "";
    if (argv[i].startsWith("--scope=")) return argv[i].slice("--scope=".length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const apply = args.has("--apply");
  const storage = getFileStorage();

  if (args.has("--resanitize-legacy")) {
    const r = await resanitizeLegacyPhotos({ storage, apply });
    console.log(
      `[storage-audit] re-sanitizacao ${apply ? "APLICADA" : "SIMULADA — nada mudou"}: candidatas=${r.candidates} limpas=${r.resanitized} mudaram-no-meio=${r.skippedChanged} falhas=${r.failed}`,
    );
    return;
  }

  if (args.has("--purge-orphans")) {
    const r = await purgeOrphanFiles({ storage, apply, scope: escopoDosArgumentos(argv) });
    console.log(
      `[storage-audit] expurgo de orfaos ${apply ? "APLICADO" : "SIMULADO — nada foi apagado"} escopo=${r.scope ?? "todos-os-candidatos (so simulacao)"}: candidatos=${r.candidates} apagados=${r.deleted} religados=${r.relinked} empresa-passou-a-existir=${r.companyNowExists} falhas=${r.failed}`,
    );
    return;
  }

  if (apply) {
    throw new Error("--apply sem ação: use --resanitize-legacy ou --purge-orphans.");
  }

  const r = await auditPhotoStorage({ storage });
  console.log(
    `[storage-audit] SOMENTE LEITURA — referencias=${r.references} examinadas=${r.examined} limpas=${r.clean} com-metadado=${r.needsSanitization} com-gps=${r.withGps} ilegiveis=${r.unparseable} arquivo-ausente=${r.missingFiles}`,
  );
  console.log(
    `[storage-audit] storage: arquivos=${r.storageFiles} orfaos-candidatos=${r.orphanCandidates} (de-empresa-inexistente=${r.orphansOfMissingCompanies} de-empresa-existente=${r.orphansOfExistingCompanies}) recentes-sem-linha=${r.recentUnreferenced} nao-reconhecidos=${r.unrecognizedEntries}`,
  );
  if (args.has("--details")) {
    for (const f of r.legacy) {
      console.log(`[storage-audit] legado ${f.kind} ${f.id} empresa=${f.companyId} ${f.state}${f.hasGps ? " GPS" : ""}`);
    }
    for (const m of r.missing) {
      console.log(`[storage-audit] ausente ${m.kind} ${m.id} empresa=${m.companyId}`);
    }
    for (const chave of r.orphans) {
      console.log(`[storage-audit] orfao ${chave}`);
    }
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof OrphanPurgeScopeError) {
      // A mensagem é nossa, sem dado de cliente, e é o que o operador precisa ler.
      console.error(`[storage-audit] RECUSADO: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    // Erro de filesystem traz o caminho absoluto (RC-LOG-01).
    logServerError("storage-audit", error, { operacao: "execucao" });
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
