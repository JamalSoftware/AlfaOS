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
//
// Deliberately decodes to readable ASCII ("vitest-only-aes256-key-32-byte!!")
// rather than random bytes: found out of context, the value itself says it is
// a fixture. Production never reaches this file — it is a Vitest `setupFiles`
// entry, and the cipher reads the environment with no fallback default.
process.env.ERP_CREDENTIAL_ENCRYPTION_KEY =
  process.env.ERP_CREDENTIAL_ENCRYPTION_KEY ??
  "dml0ZXN0LW9ubHktYWVzMjU2LWtleS0zMi1ieXRlISE=";

// Chave separada para senhas de conexao do cliente, pelo mesmo motivo que
// existem duas em producao. Decodifica para
// "vitest-pppoe-key-32-bytes-long!!" — encontrada fora de contexto, o valor
// diz por si que e fixture.
process.env.CUSTOMER_CREDENTIAL_ENCRYPTION_KEY =
  process.env.CUSTOMER_CREDENTIAL_ENCRYPTION_KEY ??
  "dml0ZXN0LXBwcG9lLWtleS0zMi1ieXRlcy1sb25nISE=";
