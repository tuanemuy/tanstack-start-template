import "dotenv/config";

import { createClient } from "@libsql/client";

async function main(): Promise<void> {
  const url = process.env.SQLITE_URL;
  if (!url) {
    throw new Error("SQLITE_URL environment variable is not set.");
  }

  const client = createClient({ url });

  try {
    await client.execute("PRAGMA foreign_keys = OFF");

    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );

    for (const row of result.rows) {
      const name = row.name as string;
      await client.execute(
        `DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`,
      );
      console.log(`dropped table ${name}`);
    }

    console.log(`dropped ${result.rows.length} table(s)`);
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (error) {
  console.error("drop failed:", error);
  process.exitCode = 1;
}
