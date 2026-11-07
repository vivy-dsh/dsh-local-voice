import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function checkId(id) { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(id))) throw new Error('未知语音包') }
function checkDir(dir) {
  try { if (lstatSync(dir).isSymbolicLink()) throw new Error('语音包或备份目录不能是符号链接') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
function archivePaths(stateDir, id, name) {
  checkId(id)
  const root = join(stateDir, 'archives'), target = join(stateDir, 'packs', id)
  for (const path of [stateDir, join(stateDir, 'packs'), root, target]) checkDir(path)
  if (name !== undefined && !new RegExp(`^${id}--\\d{13}-[a-f0-9-]{36}$`).test(String(name))) throw new Error('无效的语音包备份')
  const archive = name === undefined ? '' : join(root, name)
  if (archive) { checkDir(archive); checkDir(join(archive, 'pack')) }
  return { root, target, archive }
}

export function listArchives(stateDir, id) {
  const { root } = archivePaths(stateDir, id)
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => {
    try {
      const { archive } = archivePaths(stateDir, id, name)
      const meta = JSON.parse(readFileSync(join(archive, 'metadata.json'), 'utf8'))
      return meta.id === id && lstatSync(join(archive, 'pack')).isDirectory()
    } catch { return false }
  }).sort().reverse()
}

export function archivePack(stateDir, id, enabled) {
  const { root, target } = archivePaths(stateDir, id)
  if (!existsSync(target) || !lstatSync(target).isDirectory()) throw new Error('语音包目录不存在')
  const name = `${id}--${Date.now()}-${randomUUID()}`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const { archive } = archivePaths(stateDir, id, name)
  mkdirSync(archive, { mode: 0o700 })
  let moved = false
  try {
    renameSync(target, join(archive, 'pack')); moved = true
    writeFileSync(join(archive, 'metadata.json'), `${JSON.stringify({ id, enabled: enabled === true, createdAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 })
    return name
  } catch (error) {
    if (moved) renameSync(join(archive, 'pack'), target)
    rmSync(archive, { recursive: true, force: true })
    throw error
  }
}

export function restorePack(stateDir, id, name) {
  const { target, archive } = archivePaths(stateDir, id, name)
  if (existsSync(target)) throw new Error('安装目录已有语音包，请先移除后再恢复')
  const meta = JSON.parse(readFileSync(join(archive, 'metadata.json'), 'utf8'))
  if (meta.id !== id || !lstatSync(join(archive, 'pack')).isDirectory()) throw new Error('无效的语音包备份')
  mkdirSync(join(stateDir, 'packs'), { recursive: true, mode: 0o700 })
  renameSync(join(archive, 'pack'), target)
  return { enabled: meta.enabled === true, archive, target }
}
