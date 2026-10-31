import { createServer, type AddressInfo } from 'node:net'

/**
 * A port nothing listens on: bound on 127.0.0.1:0, read, and closed again before it is handed
 * back. Only for a port that has to be named before the code under test starts, to a child
 * process (`serve --admin-port`) or as a base nothing answers at; code that can bind 0 itself
 * should. Someone else may take the port in between.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}
