import fs from "node:fs";
import { e2eStorageRoot } from "./e2e-storage";

/**
 * Apaga o storage temporário do E2E ao fim da rodada (RC-STO-02).
 *
 * O banco de teste fica como está — o `globalSetup` o reinicia na próxima — mas
 * arquivo em disco não tem esse ciclo, e é justamente o que acumulava no
 * `.storage` do projeto antes desta mudança.
 */
export default async function globalTeardown() {
  fs.rmSync(e2eStorageRoot(), { recursive: true, force: true });
}
