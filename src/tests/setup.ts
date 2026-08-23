process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
process.env.SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "alfaos_session";
// Throwaway AES-256 key so credential tests can encrypt. Test-only value with
// no production meaning; tests that need the "key missing" path unset it
// explicitly and restore it afterwards.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY =
  process.env.ERP_CREDENTIAL_ENCRYPTION_KEY ??
  "nWjS+3ke5kdnaLCB8o9wuQa67WabX/SEBPcd1pLZDLE=";
