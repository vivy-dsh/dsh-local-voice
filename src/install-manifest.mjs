const RELEASE_PATHS = Object.freeze({
  'voice-local': '/Mieksido/surfvoicelocal/releases/download/',
  'voice-cloud': '/Mieksido/surfvoicecloud/releases/download/',
})

/** The source commit pins this file; reject paths and URLs that escape the known release. */
export function validateModelManifest(id, manifest) {
  const prefix = RELEASE_PATHS[id]
  if (!prefix || !Array.isArray(manifest?.archives) || !manifest.archives.length || manifest.archives.length > 20) throw new Error('语音模型清单无效')
  function validateUrl(raw) {
    let url
    if (String(raw).includes('..') || /%2e/i.test(String(raw))) throw new Error('语音模型下载地址包含非法路径')
    try { url = new URL(raw) } catch { throw new Error('语音模型下载地址无效') }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) || !/^[-a-zA-Z0-9._/]+$/.test(url.pathname) || url.pathname.includes('..')) throw new Error('语音模型下载地址不属于固定的上游发布源')
  }
  const names = new Set()
  for (const archive of manifest.archives) {
    if (!archive || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar\.gz$/.test(String(archive.name ?? '')) || names.has(archive.name)) throw new Error('语音模型归档名称无效')
    names.add(archive.name)
    if (!/^[a-f\d]{64}$/i.test(String(archive.sha256 ?? '')) || !Number.isSafeInteger(archive.size) || archive.size <= 0 || !['.', 'models'].includes(archive.dest)) throw new Error('语音模型归档校验信息无效')
    if (Array.isArray(archive.parts) && archive.parts.length) {
      if (archive.parts.length > 64 || archive.parts.some(part => !Number.isSafeInteger(part.size) || part.size <= 0) || archive.parts.reduce((sum, part) => sum + part.size, 0) !== archive.size) throw new Error('语音模型分卷清单无效')
      for (const part of archive.parts) validateUrl(part.url)
    } else validateUrl(archive.url)
  }
  return manifest.archives
}

export const VOICE_MIRRORS = Object.freeze({ official: '', ghfast: 'https://ghfast.top', ghproxy: 'https://gh-proxy.com', ghproxyNet: 'https://ghproxy.net' })
export function mirrorUrl(url, mirror = 'official') {
  if (!Object.hasOwn(VOICE_MIRRORS, mirror)) throw new Error('未知下载镜像')
  return VOICE_MIRRORS[mirror] ? `${VOICE_MIRRORS[mirror]}/${url}` : url
}
