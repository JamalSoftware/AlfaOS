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
 * node dist/scripts/photo-storage-audit.js --purge-orphans --apply
 * ```
 *
 * A ação sem `--apply` mostra só o que FARIA.
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
  resanitizeLegacyPhotos,
} from "../src/lib/storage/photo-audit";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
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
    const r = await purgeOrphanFiles({ storage, apply });
    console.log(
      `[storage-audit] expurgo de orfaos ${apply ? "APLICADO" : "SIMULADO — nada foi apagado"}: candidatos=${r.candidates} apagados=${r.deleted} religados=${r.relinked} falhas=${r.failed}`,
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
    `[storage-audit] storage: arquivos=${r.storageFiles} orfaos-candidatos=${r.orphanCandidates} (de-empresa-inexistente=${r.orphansOfMissingCompanies}) recentes-sem-linha=${r.recentUnreferenced} nao-reconhecidos=${r.unrecognizedEntries}`,
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
    // Erro de filesystem traz o caminho absoluto (RC-LOG-01).
    logServerError("storage-audit", error, { operacao: "execucao" });
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
