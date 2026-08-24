import { Pool } from "pg";

export function createDatabase(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}
