import os from "node:os";
import path from "node:path";

/**
 * Environment of every test process. Integration tests use TEST_DATABASE_URL
 * (default: the reimbursements_test database of compose.dev.yaml). Agents and
 * people running integration tests at the same time pick their own database
 * name, as they share the server.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://reimbursement:reimbursement@127.0.0.1:55468/reimbursements_test";

process.env.NODE_ENV = "test";
process.env.DEPLOYMENT_ENV = "development";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:8000";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-test-secret-1234";
process.env.LOG_LEVEL = "silent";
process.env.KEYCLOAK_BASE_URL ??= "http://keycloak.example.invalid";
process.env.KEYCLOAK_REALM ??= "reimbursements";
process.env.OIDC_CLIENT_ID ??= "reimbursements";
process.env.OIDC_CLIENT_SECRET ??= "test-client-secret";
process.env.UPDATER_URL ??= "http://updater.example.invalid:8080";
process.env.HEALTHCHECK_TOKEN ??= "test-health-token";
process.env.MAIL_DELIVERY_MODE ??= "local";
process.env.UPLOAD_SCANNER ??= "disabled";
process.env.DOCUMENT_SANDBOX_ENABLED ??= "0";
process.env.PRIVATE_STORAGE_ROOT ??= path.join(os.tmpdir(), `reimbursements-test-${process.pid}`);
