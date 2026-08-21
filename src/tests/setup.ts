process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
process.env.SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "alfaos_session";
