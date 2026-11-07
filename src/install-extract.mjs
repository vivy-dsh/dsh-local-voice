import { createReadStream, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }

/** Inspect all archive paths before extraction; reject links that escape the staging directory. */
export async function extractInstallArchive({ root, archive, destination, signal }) {
  const project = realpathSync(resolve(root)), target = realpathSync(resolve(destination)), source = realpathSync(resolve(archive))
  if (!within(project, target) || !within(project, source)) throw new Error('安装归档路径必须在项目内')
  let invalid = ''
  const validate = entry => {
    const name = String(entry.path || '')
    const segments = name.replaceAll('\\', '/').split('/')
    if (!name || name.includes('\\') || /^(?:\/|[a-z]:)/i.test(name) || segments.includes('..') || segments.length > 256 || !within(target, resolve(target, name))) invalid ||= `归档路径不安全：${name}`
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      const link = String(entry.linkpath || '')
      const base = entry.type === 'SymbolicLink' ? resolve(target, name, '..') : target
      if (!link || link.includes('\\') || /^(?:\/|[a-z]:)/i.test(link) || !within(target, resolve(base, link))) invalid ||= `归档链接不安全：${name}`
    } else if (!['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(entry.type)) invalid ||= `不支持的归档项目：${entry.type}`
  }
  await pipeline(createReadStream(source), tar.t({ strict: true, onReadEntry: validate }), { signal })
  if (invalid) throw new Error(invalid)
  await pipeline(createReadStream(source), tar.x({ cwd: target, strict: true, keep: true, preservePaths: false, noChmod: true }), { signal })
}
