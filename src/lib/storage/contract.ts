/**
 * Storage contract for service-order binaries (evidence photos, signatures).
 *
 * The domain never learns where bytes physically live. It holds a `storageKey`
 * — an opaque handle this contract resolves — so swapping local disk for S3,
 * R2 or MinIO later means writing one adapter, not touching the schema or any
 * business rule.
 */
export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
}

export interface FileStorageContract {
  /**
   * Persists `data` under a key the CALLER generated with `buildStorageKey`.
   * Implementations must refuse a key that does not match `STORAGE_KEY_PATTERN`
   * — that check is the last line of defence against path traversal.
   */
  put(storageKey: string, data: Buffer, mimeType: string): Promise<StoredFile>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
}

/**
 * The ONLY shape a storage key may take: `<companyId>/<orderId>/<id>.<ext>`.
 *
 * Every segment is a server-generated cuid or a short lowercase extension, so
 * a key can never contain `..`, an absolute path, a drive letter, a backslash
 * or a NUL byte. Adapters validate against this before touching the
 * filesystem, which means a forged key fails closed even if a caller is
 * tricked into passing one through.
 */
export const STORAGE_KEY_PATTERN =
  /^[a-z0-9]+\/[a-z0-9]+\/[a-z0-9]+\.(jpg|png|webp)$/;

export function assertSafeStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error("Chave de armazenamento inválida.");
  }
}

/** Extension per accepted MIME type. Never taken from the uploaded filename. */
export const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
