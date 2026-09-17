import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeStorageKey,
  STORAGE_KEY_PATTERN,
  type FileStorageContract,
  type StorageListingEntry,
  type StoredFile,
} from "./contract";
import { resolveStorageRoot } from "./root";

/** Sufixo do arquivo temporário de uma gravação em andamento. */
export const TEMP_SUFFIX = ".tmp";

/**
 * Filesystem-backed storage for development and tests.
 *
 * Files land under the root that `resolveStorageRoot` decides — `./.storage`
 * outside production, an absolute path outside the application in production —
 * which is NOT served by Next.js: there is no public URL for an evidence photo.
 * Reads go through
 * an authorized route handler, so tenant and ownership are checked before a
 * single byte is returned.
 */
export class LocalFileStorageAdapter implements FileStorageContract {
  private readonly root: string;

  /**
   * `root` explícito é o seio de teste (uma suíte aponta para um temporário).
   * Sem ele, a raiz vem da autoridade única — que em produção exige caminho
   * absoluto e fora da aplicação (`resolveStorageRoot`, `RC-1F-B`).
   */
  constructor(root?: string) {
    this.root = root === undefined ? resolveStorageRoot() : path.resolve(root);
  }

  /**
   * Resolves a key to an absolute path, then proves the result is still inside
   * the root. The pattern check already makes traversal impossible; this second
   * check is belt-and-braces, so a future change to the pattern cannot silently
   * open an escape.
   */
  private resolvePath(storageKey: string): string {
    assertSafeStorageKey(storageKey);
    const full = path.resolve(this.root, storageKey);
    const rootWithSep = this.root.endsWith(path.sep)
      ? this.root
      : this.root + path.sep;
    if (!full.startsWith(rootWithSep)) {
      throw new Error("Chave de armazenamento inválida.");
    }
    return full;
  }

  /**
   * Gravação ATÔMICA: temporário ao lado, depois `rename` (`RC-1E`).
   *
   * `writeFile` direto na chave final deixava, num processo que morresse no
   * meio, um arquivo pela metade exatamente no nome que uma linha passaria a
   * apontar — e ninguém distinguiria uma foto truncada de uma inteira. Com o
   * `rename` (atômico no mesmo sistema de arquivos), a chave final ou não
   * existe, ou tem o arquivo inteiro. O temporário de uma escrita interrompida
   * não casa com `STORAGE_KEY_PATTERN`: nenhuma leitura o alcança, e a auditoria
   * de storage o lista à parte.
   */
  async put(
    storageKey: string,
    data: Buffer,
    mimeType: string,
  ): Promise<StoredFile> {
    const full = this.resolvePath(storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const temporario = `${full}.${randomUUID()}${TEMP_SUFFIX}`;
    try {
      await fs.writeFile(temporario, data, { flag: "wx" });
      await fs.rename(temporario, full);
    } catch (error) {
      await fs.unlink(temporario).catch(() => undefined);
      throw error;
    }
    return { storageKey, sizeBytes: data.byteLength, mimeType };
  }

  async get(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(storageKey));
  }

  /** Idempotent: deleting an already-absent file is not an error. */
  async delete(storageKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Percorre a raiz sem sair dela.
   *
   * `lstat`, e não `stat`: um link simbólico NÃO é seguido — ele poderia apontar
   * para fora da raiz, e a auditoria leria (ou um expurgo apagaria) o que não é
   * do AlfaOS. O link aparece como entrada não reconhecida, e só.
   */
  async *list(): AsyncIterable<StorageListingEntry> {
    const pilha: string[] = [this.root];
    while (pilha.length > 0) {
      const dir = pilha.pop()!;
      let nomes: string[];
      try {
        nomes = await fs.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const nome of nomes.sort()) {
        const cheio = path.join(dir, nome);
        const info = await fs.lstat(cheio);
        if (info.isDirectory()) {
          pilha.push(cheio);
          continue;
        }
        const key = path.relative(this.root, cheio).split(path.sep).join("/");
        yield {
          key,
          recognized: info.isFile() && STORAGE_KEY_PATTERN.test(key),
          sizeBytes: info.size,
          modifiedAt: info.mtime,
        };
      }
    }
  }
}
