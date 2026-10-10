/** Application state is owned by the API role, separately from rebuildable chain state. */
export function applicationStore(store) {
  if (store.dialect === "postgres") {
    const query = store.query.bind(store);
    async function transaction(work) {
      const client = await store.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    return {
      async createChallenge(id, account, message, expires, now) {
        await query("DELETE FROM app.challenges WHERE expires<$1", [now]);
        await query(
          "INSERT INTO app.challenges(id,account,message,expires) VALUES($1,$2,$3,$4)",
          [id, account, message, expires],
        );
      },
      async challenge(id) {
        const row = (
          await query("SELECT * FROM app.challenges WHERE id=$1", [id])
        ).rows[0];
        return row
          ? {
              ...row,
              message: JSON.stringify(row.message),
              expires: Number(row.expires),
            }
          : null;
      },
      consumeChallenge(id, now, token, account, expires) {
        return transaction(async (client) => {
          const used = await client.query(
            "UPDATE app.challenges SET used=true WHERE id=$1 AND used=false AND expires>$2 RETURNING id",
            [id, now],
          );
          if (!used.rowCount) return false;
          await client.query("INSERT INTO app.sessions VALUES($1,$2,$3)", [
            token,
            account,
            expires,
          ]);
          return true;
        });
      },
      async account(token, now) {
        return (
          (
            await query(
              "SELECT account FROM app.sessions WHERE token_hash=$1 AND expires>$2",
              [token, now],
            )
          ).rows[0]?.account ?? null
        );
      },
      async logout(token) {
        await query("DELETE FROM app.sessions WHERE token_hash=$1", [token]);
      },
      async readNotification(account, id) {
        await query(
          "INSERT INTO app.notification_reads(id,account,is_read) SELECT id,account,true FROM chain.notification_outbox WHERE account=$1 AND id=$2 ON CONFLICT(id,account) DO UPDATE SET is_read=true",
          [account, id],
        );
      },
      async createReport(id, account, body, created) {
        await query(
          "INSERT INTO app.reports(id,account,body,created) VALUES($1,$2,$3,$4)",
          [id, account, body, created],
        );
      },
      async reports() {
        return (
          await query(
            "SELECT * FROM app.reports ORDER BY created DESC LIMIT 100",
          )
        ).rows.map((r) => ({ ...r, created: Number(r.created) }));
      },
      async updateReport(id, status) {
        await query("UPDATE app.reports SET status=$1 WHERE id=$2", [
          status,
          id,
        ]);
      },
      setCollection(collection, data, catalogKey) {
        return transaction(async (client) => {
          if (typeof data.visible === "boolean")
            await client.query("INSERT INTO app.app_meta VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [`catalog_visibility:${catalogKey}`, { visible: data.visible, at: Date.now() }]);
          if (data.hidden === true)
            await client.query(
              "INSERT INTO app.moderation VALUES($1,$2) ON CONFLICT(collection) DO UPDATE SET body=excluded.body",
              [
                collection,
                {
                  reason: String(data.reason ?? "Under review"),
                  at: Date.now(),
                },
              ],
            );
          else if (data.hidden === false)
            await client.query(
              "DELETE FROM app.moderation WHERE collection=$1",
              [collection],
            );
          if (typeof data.verified === "boolean")
            await client.query(
              "INSERT INTO app.app_meta VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [
                `verification:${collection}`,
                { verified: data.verified, at: Date.now() },
              ],
            );
        });
      },
      async audit() {
        return (
          await query("SELECT * FROM app.audit ORDER BY id DESC LIMIT 100")
        ).rows.map((r) => ({
          ...r,
          id: Number(r.id),
          created: Number(r.created),
          body: JSON.stringify(r.body),
        }));
      },
      async recordAudit(action, body) {
        await query(
          "INSERT INTO app.audit(actor,action,body,created) VALUES($1,$2,$3,$4)",
          ["operator", action, body, Date.now()],
        );
      },
    };
  }
  const db = store.app;
  return {
    createChallenge(id, account, message, expires, now) {
      db.prepare("DELETE FROM challenges WHERE expires<?").run(now);
      db.prepare(
        "INSERT INTO challenges(id,account,message,expires) VALUES(?,?,?,?)",
      ).run(id, account, JSON.stringify(message), expires);
    },
    challenge: (id) =>
      db.prepare("SELECT * FROM challenges WHERE id=?").get(id),
    consumeChallenge(id, now, token, account, expires) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const used = db
          .prepare(
            "UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>?",
          )
          .run(id, now);
        if (used.changes)
          db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
            token,
            account,
            expires,
          );
        db.exec("COMMIT");
        return !!used.changes;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    account: (token, now) =>
      db
        .prepare(
          "SELECT account FROM sessions WHERE token_hash=? AND expires>?",
        )
        .get(token, now)?.account ?? null,
    logout: (token) =>
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(token),
    readNotification: (account, id) =>
      db
        .prepare("UPDATE notifications SET is_read=1 WHERE account=? AND id=?")
        .run(account, id),
    createReport: (id, account, body, created) =>
      db
        .prepare("INSERT INTO reports(id,account,body,created) VALUES(?,?,?,?)")
        .run(id, account, JSON.stringify(body), created),
    reports: () =>
      db
        .prepare("SELECT * FROM reports ORDER BY created DESC LIMIT 100")
        .all()
        .map((r) => ({ ...r, body: JSON.parse(r.body) })),
    updateReport: (id, status) =>
      db.prepare("UPDATE reports SET status=? WHERE id=?").run(status, id),
    setCollection(collection, data, catalogKey) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (typeof data.visible === "boolean")
          db.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(
            `catalog_visibility:${catalogKey}`, JSON.stringify({ visible: data.visible, at: Date.now() }),
          );
        if (data.hidden === true)
          db.prepare("INSERT OR REPLACE INTO moderation VALUES(?,?)").run(
            collection,
            JSON.stringify({
              reason: String(data.reason ?? "Under review"),
              at: Date.now(),
            }),
          );
        else if (data.hidden === false)
          db.prepare("DELETE FROM moderation WHERE collection=?").run(collection);
        if (typeof data.verified === "boolean")
          db.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(
            `verification:${collection}`,
            JSON.stringify({ verified: data.verified, at: Date.now() }),
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    audit: () =>
      db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all(),
    recordAudit: (action, body) =>
      db
        .prepare("INSERT INTO audit(actor,action,body,created) VALUES(?,?,?,?)")
        .run("operator", action, JSON.stringify(body), Date.now()),
  };
}
