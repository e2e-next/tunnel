// The handlers the docs teach have to work as written. The first two tests read the guide that
// `tunnel agents` prints and both READMEs, and hand every handler example in them to compileScript,
// so an example that stops compiling fails here before anyone copies it.
//
// An example is a fenced block marked js, javascript, ts or typescript with `handler` in it, and it
// has to be a whole script, as a rule would hold it: `…` is not JavaScript, so whatever is left out
// is left out inside a comment. A snippet that only shows a call, such as ctx.reply(body, 201), goes
// in inline code, which nothing here reads. A `def handler` is held to be nowhere at all, inline
// code included.
//
// A block with `from 'tunnel-use'` in it is an example of the library instead, which the READMEs
// teach in "Using tunnel from TypeScript tests", and it is run rather than compiled: the third test
// writes it to a module of its own, with that import pointed at src/index.ts, and imports it. The
// example's own assertions are the check, and the example stops its own tunnel, so it has to reach
// no network and listen on 127.0.0.1 alone, as everything else in the suite does.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { AGENTS_GUIDE, PACKAGE_ROOT } from '../src/package-info.ts'
import { compileScript } from '../src/script.ts'
import { tmpDir } from './support/tmp.ts'

const READMES = [join(PACKAGE_ROOT, 'README.md'), join(PACKAGE_ROOT, 'README.zh-CN.md')]
const DOCS = [AGENTS_GUIDE, ...READMES]

/** What makes a block an example of the library rather than a script */
const LIBRARY_IMPORT = `from 'tunnel-use'`

const SCRIPT_LANGUAGES = new Set(['js', 'javascript', 'ts', 'typescript'])
const PYTHON = new Set(['python', 'py', 'python3', 'py3'])

interface Block {
  /** The first word of the info string, lower-cased: js for ```js */
  language: string
  /** The line of the opening fence, counted from 1 */
  line: number
  source: string
}

/** The fenced code blocks of a Markdown file. A line that starts with ``` opens one, the rest of
 *  that line being its info string, and the next line that is ``` and nothing else, trailing
 *  blanks aside, closes it */
function fencedBlocks(path: string): Block[] {
  const blocks: Block[] = []
  let open: Block | null = null
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (open === null) {
      const fence = /^```\s*(\S*)/.exec(line)
      if (fence !== null) {
        open = { language: (fence[1] ?? '').toLowerCase(), line: index + 1, source: '' }
      }
    } else if (line.trimEnd() === '```') {
      blocks.push(open)
      open = null
    } else {
      open.source += `${line}\n`
    }
  }
  return blocks
}

/** A doc as a message names it: its path in the repository */
const nameOf = (path: string): string => relative(PACKAGE_ROOT, path)

test('every handler example in the docs compiles', () => {
  for (const path of DOCS) {
    const examples = fencedBlocks(path).filter(
      (block) =>
        SCRIPT_LANGUAGES.has(block.language) &&
        block.source.includes('handler') &&
        !block.source.includes(LIBRARY_IMPORT),
    )
    // Else a change in how the Markdown is written could leave this checking nothing at all
    assert.ok(examples.length > 0, `${nameOf(path)} has no js or ts block with a handler in it`)
    for (const { line, source } of examples) {
      assert.doesNotThrow(
        () => compileScript(source, 'GET:/docs-example'),
        `${nameOf(path)}:${line}`,
      )
    }
  }
})

test('no doc shows a Python handler', () => {
  for (const path of DOCS) {
    assert.ok(
      !readFileSync(path, 'utf8').includes('def handler'),
      `${nameOf(path)} has a def handler in it`,
    )
    for (const { language, line } of fencedBlocks(path)) {
      assert.ok(!PYTHON.has(language), `${nameOf(path)}:${line} is a ${language} block`)
    }
  }
})

test('every library example in the READMEs runs as written', async (t) => {
  // The import as the package resolves it, pointed at the sources instead
  const entry = JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, 'src', 'index.ts')).href)
  for (const path of READMES) {
    const examples = fencedBlocks(path).filter((block) => block.source.includes(LIBRARY_IMPORT))
    // Else a change in how the Markdown is written could leave this running nothing at all
    assert.ok(examples.length > 0, `${nameOf(path)} has no block that imports tunnel-use`)
    // A directory to each README: an example on the same line of the other one would otherwise be
    // a module already imported, which import() hands back without running it again
    const dir = tmpDir(t)
    for (const { line, source } of examples) {
      const file = join(dir, `example-${line}.mts`)
      writeFileSync(file, source.replaceAll(`'tunnel-use'`, entry))
      await assert.doesNotReject(import(pathToFileURL(file).href), `${nameOf(path)}:${line}`)
    }
  }
})
