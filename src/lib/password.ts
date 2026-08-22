import bcrypt from "bcryptjs";

const HASH_ROUNDS = 12;

/**
 * Hash of a throwaway string, used only to spend the same bcrypt time when the
 * account does not exist. Not a secret: it protects timing, not data.
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$12$6E7itvA074kKpwi.bNTWr.QLmmXJ.ovetwoIPARAK8UxktD8zBjWi";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, HASH_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
