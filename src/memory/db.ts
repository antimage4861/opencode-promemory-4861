export interface Db {
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): void
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
}

export function wrapBunDb(db: any): Db {
  return {
    exec(sql) {
      db.exec(sql)
    },
    run(sql, ...params) {
      db.query(sql).run(...params)
    },
    all(sql, ...params) {
      return db.query(sql).all(...params) as Record<string, unknown>[]
    },
    get(sql, ...params) {
      return db.query(sql).get(...params) as Record<string, unknown> | undefined
    },
  }
}

export function wrapNodeDb(db: any): Db {
  return {
    exec(sql) {
      db.exec(sql)
    },
    run(sql, ...params) {
      db.prepare(sql).run(...params)
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[]
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    },
  }
}
