import { DMMF } from '@prisma/client/runtime/dmmf-types'
import { DataSource } from '@prisma/generator-helper'
import _ from 'lodash'
import mysql from 'mysql'
import url from 'url'

import { migrateLift, getTmpPrismaSchemaPath } from '../lift'
import { InternalPool } from '../pool'
import { Pool, DBInstance } from '../../types'

/**
 * Creates a dmmf specific Internal Pool instance.
 *
 * @param dmmf
 */
export function getMySQLPool(
  dmmf: DMMF.Document,
  cwd: string,
): { new (options: MySQLPoolOptions): Pool } {
  return class extends MySQLPool {
    constructor(options: MySQLPoolOptions) {
      super(
        dmmf,
        { tmpPrismaSchemaPath: getTmpPrismaSchemaPath, ...options },
        cwd,
      )
    }
  }
}

export interface MySQLConnection {
  host: string
  port: number
  user: string
  password?: string
  database: string
}

export interface MySQLPoolOptions {
  connection: (id: string) => MySQLConnection
  pool?: {
    max?: number
  }
  tmpPrismaSchemaPath?: (id: string) => string
}

class MySQLPool extends InternalPool {
  private dmmf: DMMF.Document
  private projectDir: string
  private getConnection: (id: string) => MySQLConnection
  private getTmpPrismaSchemaPath: (id: string) => string

  constructor(dmmf: DMMF.Document, options: MySQLPoolOptions, cwd: string) {
    super({ max: _.get(options, ['pool', 'max'], Infinity) })

    this.dmmf = dmmf
    this.projectDir = cwd
    this.getConnection = options.connection
    this.getTmpPrismaSchemaPath = options.tmpPrismaSchemaPath!
  }

  async createDBInstance(id: string): Promise<DBInstance> {
    const connection = this.getConnection(id)
    const tmpPrismaSchemaPath = this.getTmpPrismaSchemaPath(id)
    const uri = readMySQLURI(connection)

    const datasources: DataSource[] = [
      {
        name: 'db',
        connectorType: 'mysql',
        url: {
          value: uri,
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
      url: uri,
      cwd: this.projectDir,
      datamodel: datamodel,
    }

    return instance
  }

  async deleteDBInstance(instance: DBInstance): Promise<void> {
    const connection = parseMySQLURI(instance.url)
    try {
      const client = await getMySQLClient(connection)
      await query(client, `DROP DATABASE IF EXISTS \`${connection.database}\`;`)
    } catch (err) /* istanbul ignore next */ {
      throw err
    }
  }
}

/* Helper functions */

/**
 * Creates a mysql.Connection instance and makes sure it's connected.
 *
 * @param connection
 */
async function getMySQLClient(
  connection: MySQLConnection,
): Promise<mysql.Connection> {
  const client = mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
  })

  return new Promise((resolve, reject) => {
    client.connect(err => {
      /* istanbul ignore if */
      if (err) reject(err)
      else resolve(client)
    })
  })
}

/**
 * Executes a query as a promise against MySQL db with established conneciton.
 *
 * @param connection
 * @param query
 */
async function query<T>(client: mysql.Connection, query: string): Promise<T> {
  return new Promise((resolve, reject) => {
    client.query(query, (err, res) => {
      /* istanbul ignore if */
      if (err) reject(err)
      else resolve(res)
    })
  })
}

/**
 * Converts a MySQLConnection into a MySQL URI.
 *
 * @param connection
 */
function readMySQLURI(connection: MySQLConnection): string {
  return `mysql://${connection.user}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`
}

/**
 * Parses MySQL URI into MySQLConnection.
 *
 * @param uri
 */
function parseMySQLURI(uri: string): MySQLConnection {
  const { auth, hostname: host, port: rawPort, pathname } = url.parse(uri, true)
  const [, user, password] = auth!.match(/(\w+):(\w+)/)!
  const [, database] = pathname!.match(/\/(.+)/)!
  const port = parseInt(rawPort!, 10)

  return {
    user,
    password,
    host: host!,
    port,
    database,
  }
}
