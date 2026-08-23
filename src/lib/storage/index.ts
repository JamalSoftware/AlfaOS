import { randomUUID } from "node:crypto";
import {
  MIME_EXTENSIONS,
  type FileStorageContract,
} from "./contract";
import { LocalFileStorageAdapter } from "./local";

export {
  assertSafeStorageKey,
  STORAGE_KEY_PATTERN,
  MIME_EXTENSIONS,
} from "./contract";
export type { FileStorageContract, StoredFile } from "./contract";
export { LocalFileStorageAdapter } from "./local";

let instance: FileStorageContract | null = null;

/**
 * The storage the app uses. Local disk today; the call sites only know the
 * contract, so a cloud adapter later is a one-line change here.
 */
export function getFileStorage(): FileStorageContract {
  if (!instance) {
    instance = new LocalFileStorageAdapter();
  }
  return instance;
}

/** Test seam — lets a suite point storage at a scratch directory. */
export function setFileStorage(storage: FileStorageContract | null): void {
  instance = storage;
}

/**
 * Builds the storage key server-side from ids we control plus an extension
 * derived from the VALIDATED mime type.
 *
 * The uploaded filename is never an input here. That is deliberate: a name
 * like `../../../etc/passwd` or `photo.jpg.exe` cannot influence where the
 * file lands, because nothing the client sent reaches the path.
 */
export function buildStorageKey(
  companyId: string,
  serviceOrderId: string,
  mimeType: string,
): string {
  const ext = MIME_EXTENSIONS[mimeType];
  if (!ext) {
    throw new Error(`Tipo de arquivo não suportado: ${mimeType}`);
  }
  // randomUUID minus dashes: 32 lowercase hex chars, so the key always
  // satisfies STORAGE_KEY_PATTERN without pulling in a cuid dependency.
  const id = randomUUID().replace(/-/g, "");
  return `${companyId}/${serviceOrderId}/${id}.${ext}`;
}
