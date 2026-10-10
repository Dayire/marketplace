import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runtime } from "./runtime.mjs";
import { supervise } from "./supervisor.mjs";

export function railwayEnvironment(input) {
  const mount = input.RAILWAY_VOLUME_MOUNT_PATH;
  const postgres =
    input.MARKETPLACE_STORE === "postgres" ||
    (!input.MARKETPLACE_STORE && !!input.DATABASE_URL);
  if (input.RAILWAY_ENVIRONMENT_NAME && !postgres && mount !== "/data")
    throw new Error(
      "Railway backend requires its persistent volume mounted at /data.",
    );
  const port = input.PORT ?? input.MARKETPLACE_PORT ?? "3100";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Invalid backend port.");
  return {
    ...input,
    MARKETPLACE_PORT: port,
    MARKETPLACE_HOST: input.MARKETPLACE_HOST ?? "::",
    MARKETPLACE_DB: mount ? join(mount, "chain.sqlite") : input.MARKETPLACE_DB,
    MARKETPLACE_ASSET_DIR: mount
      ? join(mount, "assets")
      : input.MARKETPLACE_ASSET_DIR,
    MARKETPLACE_API_WORKERS: "1",
    MARKETPLACE_INDEXER_ENABLED: "false",
    MARKETPLACE_REGISTRY_PATH:
      input.MARKETPLACE_REGISTRY_PATH ??
      fileURLToPath(
        new URL(
          input.MARKETPLACE_CHAIN === "SN_SEPOLIA"
            ? "../../../config/marketplace/registry.json"
            : "../../../config/marketplace/registry.realms.json",
          import.meta.url,
        ),
      ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = railwayEnvironment(process.env);
  if (env.RAILWAY_VOLUME_MOUNT_PATH)
    accessSync(env.RAILWAY_VOLUME_MOUNT_PATH, constants.W_OK);
  // Validate configuration before starting any child or exposing health checks.
  const { store, config, rpc } = await runtime(env);
  await store.close();
  const background = env.MARKETPLACE_BACKGROUND_ENABLED === "true";
  if (
    env.MARKETPLACE_STORE === "postgres" ||
    (!env.MARKETPLACE_STORE && env.DATABASE_URL)
  ) {
    const role = env.MARKETPLACE_PROCESS_ROLE ?? "api";
    if (!["api", "index", "metadata"].includes(role))
      throw new Error("Unknown PostgreSQL process role");
    const file = role === "api" ? "server.mjs" : "worker.mjs";
    const group = supervise(
      [
        {
          name: role,
          command: process.execPath,
          args: [
            fileURLToPath(new URL(file, import.meta.url)),
            ...(role === "api" ? [] : [role]),
          ],
        },
      ],
      { env },
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => group.stop());
    process.exitCode = await group.done;
  } else {
    if (background && (!rpc || (!config.collections.length && env.MARKETPLACE_CATALOG_ENABLED !== 'true')))
      throw new Error(
        "Background workers require an RPC URL and a reviewed collection registry.",
      );
    const commands = [{ name: "api", file: "server.mjs", args: [] }];
    if (background)
      commands.push(
        { name: "index", file: "worker.mjs", args: ["index"] },
        { name: "metadata", file: "worker.mjs", args: ["metadata"] },
      );
    const group = supervise(
      commands.map(({ name, file, args }) => ({
        name,
        command: process.execPath,
        args: [fileURLToPath(new URL(file, import.meta.url)), ...args],
      })),
      { env },
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => group.stop());
    process.exitCode = await group.done;
  }
}
