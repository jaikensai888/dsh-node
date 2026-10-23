/**
 * The node's synchronous SQLite surface.
 *
 * The DSH host that runs this plugin was measured at Node 24.21 (Electron 44), and
 * `node:sqlite` works there. That is the only driver this plugin uses, and the way
 * it is obtained matters: the plugin's architecture guard forbids CommonJS module
 * loading, dynamic module loading, eval, and process spawning, because a
 * remote-controlled plugin must have no arbitrary code-loading channel. A
 * `better-sqlite3` fallback would need exactly that channel, so the honest choice is
 * a built-in-only driver plus a clear `nodeUsage/storage-unavailable` on a host that
 * predates `node:sqlite`.
 *
 * @module dsh-node/usage/sqlite
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { storageUnavailable } from './errors.js'

/** A value SQLite can bind. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** What a write reports back. */
export interface SqlRunResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

/** One prepared statement. */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult
  get(...params: SqlValue[]): Record<string, unknown> | undefined
  all(...params: SqlValue[]): Record<string, unknown>[]
}

/** Which implementation is loaded. */
export type SqlDriverName = 'node:sqlite'

/** An open database. */
export interface SqlDatabase {
  readonly driver: SqlDriverName
  readonly file: string
  exec(sql: string): void
  prepare(sql: string, options?: { readonly bigint?: boolean }): SqlStatement
  close(): void
}

/** The shape `node:sqlite` exposes. */
interface DriverStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  setReadBigInts?(enabled: boolean): void
}

interface DriverRaw {
  exec(sql: string): void
  prepare(sql: string): DriverStatement
  close(): void
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DriverRaw
}

/**
 * Read `node:sqlite` through the built-in accessor.
 *
 * `process.getBuiltinModule` (Node 22.3+) resolves *built-ins only*: there is no
 * string that could name a file on disk or a package in `node_modules`, which is
 * exactly why this is allowed by the architecture guard that forbids `require`.
 */
function loadNodeSqlite(): NodeSqliteModule | undefined {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  if (typeof getBuiltin !== 'function') return undefined
  try {
    const loaded = getBuiltin('node:sqlite') as NodeSqliteModule | undefined
    return loaded?.DatabaseSync === undefined ? undefined : loaded
  } catch {
    return undefined
  }
}

/** Open the queue database. */
function loadDriver(file: string): { driver: SqlDriverName; raw: DriverRaw } {
  const nodeSqlite = loadNodeSqlite()
  if (nodeSqlite !== undefined) {
    return { driver: 'node:sqlite', raw: new nodeSqlite.DatabaseSync(file) }
  }
  throw storageUnavailable(
    'this host has no node:sqlite (needs Node >= 22.5), so usage cannot be stored',
    { node: process.versions.node },
  )
}

/**
 * Open the queue database and apply the durability pragmas.
 * @param file - absolute path.
 * @returns the open database.
 * @throws UsageError `nodeUsage/storage-unavailable`.
 */
export function openSqliteDatabase(file: string): SqlDatabase {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (error) {
    throw storageUnavailable(`the queue directory could not be created: ${(error as Error).message}`, { file })
  }
  let handle: { driver: SqlDriverName; raw: DriverRaw }
  try {
    handle = loadDriver(file)
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error
    throw storageUnavailable(`the queue could not be opened: ${(error as Error).message}`, { file })
  }
  const database: SqlDatabase = {
    driver: handle.driver,
    file,
    exec: (sql: string) => { handle.raw.exec(sql) },
    prepare: (sql: string, options?: { readonly bigint?: boolean }) => {
      const statement = handle.raw.prepare(sql)
      if (options?.bigint === true) statement.setReadBigInts?.(true)
      return {
        run: (...params: SqlValue[]) => statement.run(...params),
        get: (...params: SqlValue[]) => asRow(statement.get(...params)),
        all: (...params: SqlValue[]) => {
          const rows = statement.all(...params)
          return rows.map(row => asRow(row)).filter((row): row is Record<string, unknown> => row !== undefined)
        },
      }
    },
    close: () => { handle.raw.close() },
  }
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('PRAGMA busy_timeout = 1000')
  } catch (error) {
    try {
      database.close()
    } catch {
      // Already unusable.
    }
    throw storageUnavailable(`the queue could not be initialised: ${(error as Error).message}`, { file })
  }
  return database
}

/** Normalise a driver row to a plain object. */
function asRow(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  return { ...(value as Record<string, unknown>) }
}

/** Run `work` inside one immediate transaction. */
export function inTransaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = work()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction was already gone; the original error is what matters.
    }
    throw error
  }
}
