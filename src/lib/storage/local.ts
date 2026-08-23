import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeStorageKey,
  type FileStorageContract,
  type StoredFile,
} from "./contract";

/**
 * Filesystem-backed storage for development and tests.
 *
 * Files land under `STORAGE_ROOT` (default `./.storage`), which is NOT served
 * by Next.js — there is no public URL for an evidence photo. Reads go through
 * an authorized route handler, so tenant and ownership are checked before a
 * single byte is returned.
 */
export class LocalFileStorageAdapter implements FileStorageContract {
  private readonly root: string;

  constructor(root?: string) {
    this.root = path.resolve(root ?? process.env.STORAGE_ROOT ?? ".storage");
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

  async put(
    storageKey: string,
    data: Buffer,
    mimeType: string,
  ): Promise<StoredFile> {
    const full = this.resolvePath(storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
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
}
