// `await using`, which Node parses from 24 on: on 22 it is a SyntaxError, which in
// tests/library.test.ts would keep the whole file from running. So the block is here, and that
// file imports this module only where it parses.
import type { Status, Tunnel } from '../../src/index.ts'

/** Holds the tunnel `open` starts with `await using` for one block, which asks its status. Resolves
 *  once the block is over, with the tunnel and what it answered inside */
export async function heldForABlock(
  open: () => Promise<Tunnel>,
): Promise<{ tunnel: Tunnel; inside: Status }> {
  await using tunnel = await open()
  return { tunnel, inside: await tunnel.status() }
}
