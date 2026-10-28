import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const omittedTrees = new Set(['.git', '.gradle', 'node_modules', 'vendor', 'build', 'dist', 'lib'])

/** List tracked and non-ignored new Markdown files, excluding generated trees.
 * @param {string} root Repository directory.
 * @param {readonly string[]} [candidates] Explicit file names for an isolated fixture.
 * @returns {Promise<string[]>} Unique repository-relative Markdown paths.
 */
export async function listDocumentationFiles(root, candidates) {
  const names = candidates ?? (await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout.split('\0')
  return [...new Set(names.map(name => name.replaceAll('\\', '/')).filter(name =>
    name.toLowerCase().endsWith('.md') && !name.split('/').some(segment => omittedTrees.has(segment))))].sort()
}

function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/giu, value => {
    const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    const named = names[value.toLowerCase()]
    if (named !== undefined) return named
    const code = value[2]?.toLowerCase() === 'x' ? Number.parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1))
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : value
  })
}

function headingSlug(text) {
  return decodeEntities(text.replace(/!?\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/<[^>]+>/gu, '').replaceAll('`', ''))
    .trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/gu, '-')
}

function withoutInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?)\1(?!`)/gu, match => match.replace(/[^\n]/gu, ' '))
}

function visibleMarkdown(source, file, errors) {
  const lines = source.replaceAll('\r\n', '\n')
    .replace(/<!--[\s\S]*?-->/gu, match => match.replace(/[^\n]/gu, ' ')).split('\n')
  let fence
  const visible = lines.map((line, index) => {
    const marker = /^ {0,3}(?:>\s*)?(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence !== undefined) {
      if (marker?.[1]?.[0] === fence.character && marker[1].length >= fence.length && marker[2]?.trim() === '') fence = undefined
      return ''
    }
    if (marker !== null && (marker[1]?.[0] !== '`' || !marker[2]?.includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length, line: index + 1 }
      return ''
    }
    return line
  }).join('\n')
  if (fence !== undefined) errors.push({ file, line: fence.line, message: 'Unclosed fenced code block' })
  return visible
}

function inspectMarkdown(source, file, errors) {
  const visible = visibleMarkdown(source, file, errors)
  const anchors = new Set()
  const links = []
  const openTags = []
  const lines = visible.split('\n')
  const prose = withoutInlineCode(visible)
  const proseLines = prose.split('\n')
  const lineNumber = offset => prose.slice(0, offset).split('\n').length
  const usedHeadings = new Set()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1]
      ?? (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/u.test(lines[index + 1]) && line.trim() !== '' ? line : undefined)
    if (heading !== undefined) {
      const base = headingSlug(heading)
      let slug = base
      for (let number = 1; usedHeadings.has(slug); number++) slug = `${base}-${number}`
      usedHeadings.add(slug)
      anchors.add(slug)
    }
    const definition = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]+>|\S+)/u.exec(proseLines[index])
    if (definition !== null) links.push({ target: definition[1].replace(/^<|>$/gu, ''), line: index + 1 })
  }
  // Read destinations independently of labels, including nested image labels.
  for (const match of prose.matchAll(/\]\(\s*(<[^>]*>|(?:\\.|[^\s()\\]|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/gu)) {
    links.push({ target: match[1].replace(/^<|>$/gu, '').replace(/\\([()])/gu, '$1'), line: lineNumber(match.index) })
  }
  for (const match of prose.matchAll(/<\/?([a-z][\w-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu)) {
    const tag = match[1].toLowerCase()
    const markup = match[0]
    const line = lineNumber(match.index)
    for (const attribute of markup.matchAll(/\b(href|src|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)) {
      const value = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4])
      if (attribute[1].toLowerCase() === 'id' || (tag === 'a' && attribute[1].toLowerCase() === 'name')) anchors.add(value)
      else if (attribute[1].toLowerCase() === 'href' || attribute[1].toLowerCase() === 'src') links.push({ target: value, line })
    }
    if (!['details', 'table', 'p', 'sub'].includes(tag) || /\/\s*>$/u.test(markup)) continue
    if (!markup.startsWith('</')) openTags.push({ tag, line })
    else if (openTags.at(-1)?.tag === tag) openTags.pop()
    else errors.push({ file, line, message: `Unexpected closing </${tag}>` })
  }
  for (const opening of openTags) errors.push({ file, line: opening.line, message: `Unclosed <${opening.tag}>` })
  return { anchors, links }
}

function localTarget(target) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('//')) {
    const ownAsset = /^https:\/\/raw\.githubusercontent\.com\/saya-ch\/dsh-mobile\/[^/]+\/(assets\/[^?#]+)(?:\?[^#]*)?(#.*)?$/iu.exec(target)
    return ownAsset === null ? undefined : `/${ownAsset[1]}${ownAsset[2] ?? ''}`
  }
  return target
}

function inside(root, path) {
  const name = relative(root, path)
  return name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(name)
}

/** Check local targets, Markdown headings, explicit HTML anchors and basic markup balance.
 * External URLs are not fetched; fenced examples and inline code are ignored.
 * @param {string} root Repository directory.
 * @param {readonly string[]} files Repository-relative Markdown paths.
 * @returns {Promise<Array<{file: string, line: number, message: string}>>} Findings; an empty list passes.
 */
export async function validateDocumentation(root, files) {
  const errors = []
  const documents = new Map()
  async function document(file) {
    if (!documents.has(file)) {
      const source = await readFile(resolve(root, file), 'utf8')
      documents.set(file, inspectMarkdown(source, file, errors))
      if (extname(file).toLowerCase() === '.md' && (!/\r?\n$/u.test(source) || /(?:\r?\n[ \t]*){2}$/u.test(source))) {
        errors.push({ file, line: source.split('\n').length, message: 'File must end with exactly one newline' })
      }
    }
    return documents.get(file)
  }
  for (const file of files) {
    if (!inside(root, resolve(root, file))) { errors.push({ file, line: 1, message: 'Document is outside the repository' }); continue }
    let parsed
    try { parsed = await document(file) }
    catch (error) { errors.push({ file, line: 1, message: `Cannot read document: ${error.code ?? error.message}` }); continue }
    for (const link of parsed.links) {
      const target = localTarget(decodeEntities(link.target))
      if (target === undefined) continue
      let path
      let fragment
      try {
        const separator = target.indexOf('#')
        path = decodeURIComponent((separator < 0 ? target : target.slice(0, separator)).split('?')[0])
        fragment = separator < 0 ? '' : decodeURIComponent(target.slice(separator + 1))
      } catch { errors.push({ file, line: link.line, message: `Invalid local URL encoding: ${link.target}` }); continue }
      const absolute = path === '' ? resolve(root, file) : path.startsWith('/') ? resolve(root, `.${path}`) : resolve(root, dirname(file), path)
      if (!inside(root, absolute)) { errors.push({ file, line: link.line, message: `Local target is outside the repository: ${link.target}` }); continue }
      let info
      try { info = await stat(absolute) }
      catch { errors.push({ file, line: link.line, message: `Missing local target: ${link.target}` }); continue }
      if (fragment === '' || info.isDirectory() || !['.md', '.html', '.htm', '.svg'].includes(extname(absolute).toLowerCase())) continue
      const destination = relative(root, absolute).replaceAll('\\', '/')
      try {
        const destinationDocument = await document(destination)
        if (!destinationDocument.anchors.has(fragment)) errors.push({ file, line: link.line, message: `Missing local fragment: ${link.target}` })
      } catch (error) { errors.push({ file, line: link.line, message: `Cannot read local target: ${link.target} (${error.code ?? error.message})` }) }
    }
  }
  return errors
}

async function main(args) {
  let root = repositoryRoot
  let files
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root' && args[index + 1] !== undefined) root = resolve(args[++index])
    else if (args[index] === '--files' && args[index + 1] !== undefined) { files = args.slice(index + 1); break }
    else throw new Error(`Unsupported or incomplete option: ${args[index]}`)
  }
  const selected = await listDocumentationFiles(root, files)
  if (selected.length === 0) throw new Error('No Markdown documents selected')
  const findings = await validateDocumentation(root, selected)
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`)
  if (findings.length > 0) process.exitCode = 1
  else console.log(`documentation check passed: ${selected.length} Markdown files`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`documentation check failed: ${error.message}`); process.exitCode = 1 })
}
