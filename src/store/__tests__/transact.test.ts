/**
 * `transact` aninhado quebrava o crawl periódico: o worker envolvia `writeRows`
 * (que já transaciona) numa segunda transação, e o SQLite recusa com "cannot start
 * a transaction within a transaction". Só apareceria em produção, na primeira
 * unidade coletada.
 */

import { describe, expect, it } from "vitest";

import { openDb, transact } from "../db.js";

const fresh = () => openDb({ path: ":memory:" });

describe("transact", () => {
  it("aninha sem quebrar", () => {
    const db = fresh();
    const out = transact(db, () => transact(db, () => transact(db, () => "ok")));
    expect(out).toBe("ok");
    db.close();
  });

  it("commita o que a transação externa e a interna gravaram", () => {
    const db = fresh();
    transact(db, () => {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('a', '1')`).run();
      transact(db, () => {
        db.prepare(`INSERT INTO meta (key, value) VALUES ('b', '2')`).run();
      });
    });
    expect(db.prepare(`SELECT COUNT(*) c FROM meta`).get()).toMatchObject({ c: 2 });
    db.close();
  });

  it("desfaz só a interna quando ela falha e a externa trata o erro", () => {
    const db = fresh();
    transact(db, () => {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('externa', '1')`).run();
      try {
        transact(db, () => {
          db.prepare(`INSERT INTO meta (key, value) VALUES ('interna', '2')`).run();
          throw new Error("falhou");
        });
      } catch {
        // A externa decide seguir — é para isso que serve o savepoint.
      }
    });
    const keys = (db.prepare(`SELECT key FROM meta ORDER BY key`).all() as Array<{ key: string }>)
      .map((r) => r.key);
    expect(keys).toEqual(["externa"]);
    db.close();
  });

  it("desfaz tudo quando a externa falha", () => {
    const db = fresh();
    expect(() =>
      transact(db, () => {
        db.prepare(`INSERT INTO meta (key, value) VALUES ('a', '1')`).run();
        transact(db, () => {
          db.prepare(`INSERT INTO meta (key, value) VALUES ('b', '2')`).run();
        });
        throw new Error("falhou lá fora");
      }),
    ).toThrow("falhou lá fora");
    expect(db.prepare(`SELECT COUNT(*) c FROM meta`).get()).toMatchObject({ c: 0 });
    db.close();
  });

  it("volta ao nível zero depois de um erro, deixando a conexão utilizável", () => {
    const db = fresh();
    expect(() => transact(db, () => { throw new Error("x"); })).toThrow();
    // Se a profundidade não tivesse voltado a zero, esta transação usaria SAVEPOINT
    // sem transação aberta e o INSERT ficaria sem commit.
    transact(db, () => {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('depois', '1')`).run();
    });
    expect(db.prepare(`SELECT COUNT(*) c FROM meta`).get()).toMatchObject({ c: 1 });
    db.close();
  });
});
