const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error("Invalid database role identifier");
  return '"' + value + '"';
};
/** Run with the migration/admin credential, never an HTTP-service connection. */
export async function provisionRoles(pool, roles) {
  for (const name of ["api", "index", "metadata"])
    if (!roles[name] || !/^[a-f0-9]{64}$/.test(roles[name].password))
      throw new Error(
        "Provide an independent 32-byte hex password for each runtime role",
      );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    for (const spec of Object.values(roles)) {
      const quoted = identifier(spec.name),
        exists = (
          await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
            spec.name,
          ])
        ).rowCount;
      // Names and secrets have deliberately restrictive grammars; utility DDL cannot bind values.
      await client.query(
        `${exists ? "ALTER" : "CREATE"} ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${spec.password}'`,
      );
      await client.query(
        `REVOKE ALL ON SCHEMA chain,market,app,media FROM ${quoted}`,
      );
      await client.query(
        `REVOKE ALL ON ALL TABLES IN SCHEMA chain,market,app,media FROM ${quoted}`,
      );
      await client.query(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM ${quoted}`,
      );
    }
    const api = identifier(roles.api.name),
      index = identifier(roles.index.name),
      metadata = identifier(roles.metadata.name);
    await client.query(`GRANT SELECT ON public.marketplace_migrations TO ${api},${index},${metadata}`);
    await client.query(
      `GRANT USAGE ON SCHEMA chain,market,app,media TO ${api}`,
    );
    await client.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA chain,market,media TO ${api}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO ${api}`,
    );
    await client.query(
      `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO ${api}`,
    );
    await client.query(`GRANT INSERT,UPDATE ON market.metadata_jobs TO ${api}`);
    await client.query(`GRANT USAGE ON SCHEMA chain,market TO ${index}`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA chain,market TO ${index}`,
    );
    await client.query(
      `GRANT USAGE ON SCHEMA chain,market,media TO ${metadata}`,
    );
    await client.query(
      `GRANT SELECT ON chain.meta,chain.blocks,chain.collection_catalog,chain.class_evidence,
        market.tokens,market.erc1155_balances,market.token_metadata,market.metadata_jobs,market.attributes,media.assets TO ${metadata}`,
    );
    await client.query(
      `GRANT INSERT,UPDATE,DELETE ON market.token_metadata,market.metadata_jobs,market.attributes TO ${metadata}`,
    );
    await client.query(`GRANT INSERT ON media.assets TO ${metadata}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
