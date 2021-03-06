import { DMMF } from '@prisma/client/runtime/dmmf-types'
import { DataSource } from '@prisma/generator-helper'
import * as fs from 'fs'
import _ from 'lodash'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'

import { migrateLift, getTmpPrismaSchemaPath } from '../lift'
import { InternalPool } from '../pool'
import { Pool, DBInstance } from '../../types'

const fsUnlink = promisify(fs.unlink)

/**
 * Creates a dmmf specific Internal Pool instance.
 *
 * @param dmmf
 */
export function getSQLitePool(
  dmmf: DMMF.Document,
  cwd: string,
): { new (options?: SQLitePoolOptions): Pool } {
  return class extends SQLitePool {
    constructor(options?: SQLitePoolOptions) {
      super(
        dmmf,
        {
          databasePath: getTmpSQLiteDB,
          tmpPrismaSchemaPath: getTmpPrismaSchemaPath,
          ...options,
        },
        cwd,
      )
    }
  }
}

export interface SQLitePoolOptions {
  databasePath?: (id: string) => string
  tmpPrismaSchemaPath?: (id: string) => string
  pool?: {
    max?: number
  }
}

class SQLitePool extends InternalPool {
  private dmmf: DMMF.Document
  private projectDir: string
  private getDatabasePath: (id: string) => string
  private getTmpPrismaSchemaPath: (id: string) => string

  constructor(dmmf: DMMF.Document, options: SQLitePoolOptions, cwd: string) {
    super({ max: _.get(options, ['pool', 'max'], Infinity) })

    this.dmmf = dmmf
    this.projectDir = cwd
    this.getDatabasePath = options.databasePath!
    this.getTmpPrismaSchemaPath = options.tmpPrismaSchemaPath!
  }

  /**
   * Creates a new DB instances and lifts a migration.
   */
  async createDBInstance(id: string): Promise<DBInstance> {
    try {
      /* Constants */
      const dbFile = this.getDatabasePath(id)
      const tmpPrismaSchemaPath = this.getTmpPrismaSchemaPath(id)
      const datasources: DataSource[] = [
        {
          name: 'db',
          connectorType: 'sqlite',
          url: {
            value: `file:${dbFile}`,
            fromEnvVar: null,
          },
          config: {},
        },
      ]

      /* Migrate using Lift. */

      const { datamodel } = await migrateLift({
        id,
        projectDir: this.projectDir,
        datasources,
        tmpPrismaSchemaPath,
        dmmf: this.dmmf,
      })

      const instance: DBInstance = {
        url: dbFile,
        cwd: this.projectDir,
        datamodel: datamodel,
      }

      return instance
    } catch (err) /* istanbul ignore next */ {
      throw err
    }
  }

  /**
   * Deletes the db files.
   *
   * @param instance
   */
  protected async deleteDBInstance(instance: DBInstance): Promise<void> {
    try {
      await fsUnlink(instance.url)
    } catch (err) /* istanbul ignore next */ {
      throw err
    }
  }
}

/**
 * Allocates a new space in the tmp dir for the db instance.
 *
 * @param id
 */
export function getTmpSQLiteDB(id: string): string {
  const tmpDir = os.tmpdir()
  const dbFile = path.join(tmpDir, `./prisma-sqlite-${id}-db.db`)
  return dbFile
}
