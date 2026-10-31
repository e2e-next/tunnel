// Where the package is, worked out in this one module. It sits one level below
// the package root both as source (src/package-info.ts, which Node runs
// directly) and as build output (dist/package-info.js, in a checkout and once
// installed), so the parent of its own directory is the root either way. That
// holds only while modules stay one level down, which is one reason src/ has no
// subdirectories.
//
// No other module works out a path relative to the package root: they all
// import PACKAGE_ROOT from here.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The package root, the directory holding package.json, with no trailing
 * separator. Right in a checkout and once installed.
 */
export const PACKAGE_ROOT = dirname(import.meta.dirname)

/**
 * The version in package.json: the one source of the version number. Read
 * through PACKAGE_ROOT rather than imported from '../package.json', so the
 * assumption that this module sits one level down is made in PACKAGE_ROOT alone.
 */
export const VERSION: string = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version

/** The built panel: panel.js, panel.css and its font. `make panel` writes them here and they are committed,
 *  so neither a checkout nor an install needs to build the panel */
export const PANEL_STATIC_DIR = join(PACKAGE_ROOT, 'assets', 'panel')

/** The guide `tunnel agents` and the MCP guide tool print, shipped in the package so it describes the
 *  installed version rather than the default branch */
export const AGENTS_GUIDE = join(PACKAGE_ROOT, 'assets', 'AGENTS.md')
