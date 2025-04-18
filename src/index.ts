#! /usr/bin/env node

import { Command } from 'commander'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { globbySync } from 'globby'
import { dirname, relative, resolve } from 'path'
import { loadConfig } from './util.js'

const program = new Command()

program
  .version('0.0.1', '-v, --version', 'output the current version')
  .option('-p, --project <file>', 'path to tsconfig.json')
  .option('-s, --src <path>', 'source root path')
  .option('-o, --out <path>', 'output root path')
  .option('-v, --verbose', 'output logs')

program.on('--help', () => {
  console.log(`
  $ tscpath -p tsconfig.json
`)
})

program.parse(process.argv)

const {
  out: flagOut,
  project = 'tsconfig.json',
  src: flagSrc,
  verbose = false,
} = program as {
  out?: string | undefined
  project?: string
  src?: string | undefined
  verbose?: boolean
}

const verboseLog = (...args: any[]): void => {
  if (verbose) {
    console.log(...args)
  }
}

const configFile = resolve(process.cwd(), project)

const rootDir = resolve(process.cwd())

verboseLog(`Using tsconfig: ${configFile}`)

const exitingErr = (): any => {
  throw new Error('--- exiting tsconfig-replace-paths due to parameters missing ---')
}

const missingConfigErr = (property: string): any => {
  console.error(`Whoops! Please set ${property} in your tsconfig or supply a flag`)
  exitingErr()
}

const missingDirectoryErr = (directory: string, flag: string): any => {
  console.error(
    `Whoops! ${directory} must be specified in your project => --project ${project}, or flagged with directory => ${flag} './path'`,
  )
  exitingErr()
}

// Imported the TS Config
const returnedTsConfig = loadConfig(configFile)

// Destructure only the necessary keys, and rename to give context
const { baseUrl, paths, outDir: tsConfigOutDir = '', rootDir: tsConfigRootDir = rootDir } = returnedTsConfig

// If no flagSrc or tsConfigRootDir, error
if (!flagSrc && tsConfigRootDir === '') {
  missingConfigErr('compilerOptions.rootDir')
}

// If no flagOut or tsConfigOutDir, error
if (!flagOut && tsConfigOutDir === '') {
  missingConfigErr('compilerOptions.outDir')
}

// Are we going to use the flag or ts config for src?
let usingSrcDir: string
if (flagSrc) {
  verboseLog('Using flag --src')
  usingSrcDir = resolve(flagSrc)
} else {
  verboseLog('Using compilerOptions.rootDir from your tsconfig')
  usingSrcDir = resolve(tsConfigRootDir)
}
if (!usingSrcDir) {
  missingDirectoryErr('rootDir', '--src')
}

// Log which src is being used
verboseLog(`Using src: ${usingSrcDir}`)

// Are we going to use the flag or ts config for out?
let usingOutDir: string
if (flagOut) {
  verboseLog('Using flag --out')
  usingOutDir = resolve(flagOut)
} else {
  verboseLog('Using compilerOptions.outDir from your tsconfig')
  usingOutDir = resolve(tsConfigOutDir)
}
if (!usingOutDir) {
  missingDirectoryErr('outDir', '--out')
}

// Log which out is being used
verboseLog(`Using out: ${usingOutDir}`)

if (!baseUrl) {
  throw new Error('compilerOptions.baseUrl is not set')
}
if (!paths) {
  throw new Error('compilerOptions.paths is not set')
}
if (!usingOutDir) {
  throw new Error('compilerOptions.outDir is not set')
}
if (!usingSrcDir) {
  throw new Error('compilerOptions.rootDir is not set')
}

verboseLog(`baseUrl: ${baseUrl}`)
verboseLog(`rootDir: ${usingSrcDir}`)
verboseLog(`outDir: ${usingOutDir}`)
verboseLog(`paths: ${JSON.stringify(paths, null, 2)}`)

const configDir = dirname(configFile)

const basePath = resolve(configDir, baseUrl)
verboseLog(`basePath: ${basePath}`)

const outPath = usingOutDir || resolve(basePath, usingOutDir)
verboseLog(`outPath: ${outPath}`)

const outFileToSrcFile = (x: string): string => resolve(usingSrcDir, relative(outPath, x))

const aliases = Object.keys(paths)
  .map(alias => ({
    prefix: alias.replace(/\*$/, ''),
    aliasPaths: paths[alias as keyof typeof paths].map(p => resolve(basePath, p.replace(/\*$/, ''))),
  }))
  .filter(({ prefix }) => prefix)
verboseLog(`aliases: ${JSON.stringify(aliases, null, 2)}`)

const toRelative = (from: string, x: string): string => {
  const rel = relative(from, x)
  return (rel.startsWith('.') ? rel : `./${rel}`).replace(/\\/g, '/')
}

const exts = ['.js', '.jsx', '.ts', '.tsx', '.d.ts', '.json']

let replaceCount = 0

const absToRel = (modulePath: string, outFile: string): string => {
  const alen = aliases.length

  for (let j = 0; j < alen; j += 1) {
    const { prefix, aliasPaths } = aliases[j]

    if (modulePath.startsWith(prefix)) {
      const modulePathRel = modulePath.substring(prefix.length)
      const srcFile = outFileToSrcFile(outFile)
      const outRel = relative(basePath, outFile)

      verboseLog(`${outRel} (source: ${relative(basePath, srcFile)}):`)
      verboseLog(`\timport '${modulePath}'`)

      const len = aliasPaths.length
      for (let i = 0; i < len; i += 1) {
        const apath = aliasPaths[i]
        let moduleSrc = resolve(apath, modulePathRel)
        const moduleExt = exts.find(ext => moduleSrc.endsWith(ext))
        if (moduleExt) {
          moduleSrc = moduleSrc.replace(moduleExt, '')
        }
        if (existsSync(moduleSrc) || exts.some(ext => existsSync(moduleSrc + ext))) {
          const rel = toRelative(dirname(srcFile), moduleExt ? `${moduleSrc}${moduleExt}` : moduleSrc)

          replaceCount += 1

          verboseLog(`\treplacing '${modulePath}' -> '${rel}' referencing ${relative(basePath, moduleSrc)}`)
          return rel
        }
      }
      verboseLog(`\tcould not replace ${modulePath}`)
    }
  }

  return modulePath
}

const requireRegex = /(?:import|require)\(['"]([^'"]*)['"]\)/g
const importRegex = /(?:import|from) ['"]([^'"]*)['"]/g

const replaceImportStatement = (orig: string, matched: string, outFile: string): string => {
  const index = orig.indexOf(matched)
  return orig.substring(0, index) + absToRel(matched, outFile) + orig.substring(index + matched.length)
}

const replaceAlias = (text: string, outFile: string): string =>
  text
    .replace(requireRegex, (orig, matched) => replaceImportStatement(orig, matched, outFile))
    .replace(importRegex, (orig, matched) => replaceImportStatement(orig, matched, outFile))

// import relative to absolute path
const files = globbySync(`${outPath.replaceAll('\\', '/')}/**/*.{js,jsx,ts,tsx}`, {
  dot: true,
  noDir: true,
} as any).map((x: any) => resolve(x))

let changedFileCount = 0

const flen = files.length
let count = 0

for (let i = 0; i < flen; i += 1) {
  const file = files[i]
  const text = readFileSync(file, 'utf8')
  const prevReplaceCount = replaceCount
  const newText = replaceAlias(text, file)
  if (text !== newText) {
    changedFileCount += 1
    verboseLog(`${file}: replaced ${replaceCount - prevReplaceCount} paths`)
    writeFileSync(file, newText, 'utf8')
    count = count + 1
  }
}

console.log(`Replaced ${replaceCount} paths in ${changedFileCount} files`)
