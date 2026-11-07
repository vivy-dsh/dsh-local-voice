import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

async function statFile(file) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('下载目标必须是普通文件')
    return stat
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Download into a project-owned staging path, resume partial files, and publish only verified bytes. */
async function downloadPartial({ url, partial, size, signal, fetchImpl, onProgress }) {
  let offset = (await statFile(partial))?.size || 0
  if (offset > size) throw new Error('已有下载残留大于预期，请先处理残留文件')
  if (offset < size) {
    const response = await fetchImpl(url, { headers: offset ? { range: `bytes=${offset}-` } : {}, signal })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    if (offset && response.status === 206) {
      if (!new RegExp(`^bytes ${offset}-\\d+/${size}$`).test(response.headers.get('content-range') || '')) throw new Error('断点续传响应范围无效')
    } else if (response.status === 200) offset = 0
    else throw new Error('下载服务器返回了意外范围')
    const flags = constants.O_WRONLY | constants.O_CREAT | (offset ? constants.O_APPEND : constants.O_TRUNC) | (constants.O_NOFOLLOW || 0)
    const file = await open(partial, flags, 0o600)
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk)
        if (offset + bytes.length > size) throw new Error('下载数据超过清单大小')
        let position = 0
        while (position < bytes.length) position += (await file.write(bytes, position, bytes.length - position)).bytesWritten
        offset += bytes.length
        onProgress(offset, size)
      }
    } finally { await file.close() }
  }
  if (offset !== size) throw new Error('下载尚未完成，已保留残留文件供续传')
}

async function publishExclusive(source, destination) {
  // Hard-link creation is atomic and fails if another process created the target.
  await link(source, destination)
  await unlink(source)
}

/** Download into a project-owned staging path, resume partial files, and publish only verified bytes. */
export async function downloadVerifiedAsset({ url, destination, sha256, size, signal, fetchImpl = fetch, onProgress = () => {} }) {
  if (!/^[a-f\d]{64}$/i.test(String(sha256)) || !Number.isSafeInteger(size) || size <= 0) throw new Error('下载清单缺少有效 SHA-256 或大小')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const existing = await statFile(destination)
  if (existing) {
    if (existing.size === size && await fileHash(destination) === sha256.toLowerCase()) return { path: destination, cached: true }
    throw new Error('下载目标已存在且校验失败，原文件未被覆盖')
  }
  const partial = `${destination}.part`
  await downloadPartial({ url, partial, size, signal, fetchImpl, onProgress })
  if (await fileHash(partial) !== sha256.toLowerCase()) {
    await rename(partial, `${partial}.corrupt-${randomUUID()}`)
    throw new Error('下载 SHA-256 校验失败；已保留异常文件')
  }
  await publishExclusive(partial, destination)
  return { path: destination, cached: false }
}

/** Some upstream releases have size-only parts; trust them only after the complete archive hash matches. */
export async function downloadVerifiedParts({ parts, destination, sha256, size, signal, fetchImpl = fetch, onProgress = () => {} }) {
  if (!Array.isArray(parts) || !parts.length || parts.some(part => !Number.isSafeInteger(part.size) || part.size <= 0) || parts.reduce((sum, part) => sum + part.size, 0) !== size || !/^[a-f\d]{64}$/i.test(String(sha256))) throw new Error('分卷清单无效')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const existing = await statFile(destination)
  if (existing) {
    if (existing.size === size && await fileHash(destination) === sha256.toLowerCase()) return { path: destination, cached: true }
    throw new Error('下载目标已存在且校验失败，原文件未被覆盖')
  }
  const files = []
  let preceding = 0
  for (const [index, part] of parts.entries()) {
    const partial = `${destination}.piece-${index}.part`
    await downloadPartial({ url: part.url, partial, size: part.size, signal, fetchImpl, onProgress: (done) => onProgress(preceding + done, size) })
    files.push(partial)
    preceding += part.size
  }
  const assembling = `${destination}.assembling-${randomUUID()}`
  const out = await open(assembling, 'wx', 0o600)
  const hash = createHash('sha256')
  try {
    for (const file of files) for await (const chunk of createReadStream(file)) {
      if (signal?.aborted) throw new Error('Install cancelled')
      hash.update(chunk)
      let position = 0
      while (position < chunk.length) position += (await out.write(chunk, position, chunk.length - position)).bytesWritten
    }
  } catch (error) { await out.close(); await unlink(assembling); throw error }
  await out.close()
  if (hash.digest('hex') !== sha256.toLowerCase()) {
    await rename(assembling, `${assembling}.corrupt`)
    for (const file of files) await rename(file, `${file}.corrupt-${randomUUID()}`)
    throw new Error('分卷合并后的 SHA-256 校验失败；已保留异常文件')
  }
  await publishExclusive(assembling, destination)
  for (const file of files) await unlink(file)
  return { path: destination, cached: false }
}
