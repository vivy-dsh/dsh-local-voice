import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stagePinnedSource, VOICE_SOURCE_LOCK } from './install-source.mjs'
import { downloadVerifiedAsset, downloadVerifiedParts } from './install-download.mjs'
import { extractInstallArchive } from './install-extract.mjs'
import { validateModelManifest, mirrorUrl } from './install-manifest.mjs'
import { runInstallCommand } from './install-runner.mjs'
import { prepareConfig } from './voice-pack-import.js'

const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function localDirectory(root, path) {
  const rel = relative(root, resolve(path))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('语音安装目录不能指向项目外')
  let current = root
  for (const name of rel.split(sep).filter(Boolean)) {
    current = join(current, name)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('语音安装目录不能是符号链接或非目录')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
    }
    if (!within(root, realpathSync(current))) throw new Error('语音安装目录不能指向项目外')
  }
  return path
}

/** Prepare a project-local copy that handles spaces and Windows drive letters correctly. */
export function prepareProjectBootstrap(destination, id = '', { localPython = false } = {}) {
  const source = join(destination, 'scripts', 'bootstrap-env.mjs')
  const target = join(destination, 'scripts', 'bootstrap-project.mjs')
  const original = readFileSync(source, 'utf8')
  const before = "const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1')), '..');"
  if (original.split(before).length !== 2) throw new Error('固定版本的语音环境准备脚本格式不匹配')
  let adapted = original.replace(before, "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');")
  if (localPython) {
    const start = adapted.indexOf('function findPythons() {')
    const end = adapted.indexOf('function pickPython(', start)
    if (start < 0 || end < 0 || adapted.indexOf('function findPythons() {', start + 1) >= 0) throw new Error('固定版本的 Python 检测脚本格式不匹配')
    adapted = `${adapted.slice(0, start)}function findPythons() {\n  const exe = path.join(root, 'runtime', 'python', 'python.exe');\n  return fs.existsSync(exe) ? [{ exe: [exe], version: '3.12', minor: 12 }] : [];\n}\n\n${adapted.slice(end)}`
  }
  if (id === 'voice-cloud') {
    const check = 'if (fs.existsSync(reqGsv))'
    if (adapted.split(check).length !== 2) throw new Error('固定版本的云端环境准备脚本格式不匹配')
    adapted = adapted.replace(check, 'if (false && fs.existsSync(reqGsv))')
  }
  adapted = adapted.replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
  writeFileSync(target, `import { fileURLToPath } from 'node:url';\n${adapted}`, { flag: 'wx', mode: 0o600 })
  return target
}

export function prepareRelocatedVenv(stage, target) {
  for (const name of ['.venv', '.venv-gsv']) {
    const file = join(stage, name, 'pyvenv.cfg')
    if (!existsSync(file)) continue
    const original = readFileSync(file, 'utf8')
    const updated = original.split(resolve(stage)).join(resolve(target)).split(resolve(stage).replaceAll('\\', '/')).join(resolve(target).replaceAll('\\', '/'))
    if (updated !== original) writeFileSync(file, updated, { mode: 0o600 })
  }
}

const LOCAL_PYTHON = Object.freeze({
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-x86_64-pc-windows-msvc-install_only.tar.gz',
  size: 47113364,
  sha256: '590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5',
})

/** Bootstrap writes the ffmpeg executable path into TOML; keep it valid after publication. */
export function prepareRelocatedConfig(stage, target) {
  const file = join(stage, 'config.toml')
  const source = readFileSync(file, 'utf8')
  const oldPath = resolve(stage).replaceAll('\\', '/')
  const finalPath = resolve(target).replaceAll('\\', '/')
  const next = source.replaceAll(`${oldPath}/`, `${finalPath}/`)
  if (next !== source) writeFileSync(file, next, { mode: 0o600 })
}

async function defaultBootstrap({ root, destination, id, signal, onOutput, mirror }) {
  const cache = localDirectory(root, join(root, 'downloads', id))
  const archive = join(cache, 'python-3.12.16-windows-x64.tar.gz')
  await downloadVerifiedAsset({ ...LOCAL_PYTHON, url: mirrorUrl(LOCAL_PYTHON.url, mirror), destination: archive, signal })
  const runtime = localDirectory(root, join(destination, 'runtime'))
  await extractInstallArchive({ root, archive, destination: runtime, signal })
  if (!existsSync(join(runtime, 'python', 'python.exe'))) throw new Error('项目内 Python 运行环境缺失')
  const script = prepareProjectBootstrap(destination, id, { localPython: true })
  await runInstallCommand({ root, cwd: destination, command: process.execPath, args: [script], signal, onOutput })
}

/** Online installation uses fixed source commits and SHA-256 verified release archives. */
export function createOnlineVoiceInstaller({ stateDir, platform = process.platform, stageSource = stagePinnedSource, downloadAsset = downloadVerifiedAsset, downloadParts = downloadVerifiedParts, extract = extractInstallArchive, bootstrap = defaultBootstrap }) {
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('语音安装状态目录必须是绝对路径')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const root = realpathSync(stateDir), jobs = new Map()
  const status = id => { const job = jobs.get(id); if (!job) return null; const { controller, promise, ...view } = job; return { ...view } }
  function start(id, { mirror = 'official' } = {}) {
    const lock = VOICE_SOURCE_LOCK[id]
    if (!lock) return Promise.reject(new Error('未知语音包'))
    if (platform !== 'win32') return Promise.reject(new Error('上游语音包的在线安装目前仅支持 Windows；可在此系统使用自备本地引擎'))
    try { mirrorUrl('https://github.com/example', mirror) } catch (error) { return Promise.reject(error) }
    const current = jobs.get(id)
    if (current && !['完成', '失败', '已取消'].includes(current.phase)) return Promise.reject(new Error('语音包正在安装'))
    const packs = localDirectory(root, join(root, 'packs'))
    const target = join(packs, id)
    if (existsSync(target)) return Promise.reject(new Error('语音包目录已存在，原文件未覆盖'))
    const stagingRoot = localDirectory(root, join(root, 'install-staging'))
    const downloads = localDirectory(root, join(root, 'downloads', id))
    const stage = join(stagingRoot, `${id}-${randomUUID()}`)
    const controller = new AbortController()
    const job = { id, phase: '准备源码', progress: 0, error: '', mirror, startedAt: Date.now(), controller, promise: null, stage }
    jobs.set(id, job)
    const check = () => { if (controller.signal.aborted) throw new Error('Install cancelled') }
    const output = text => { job.logTail = `${job.logTail || ''}${text}`.slice(-1000) }
    job.promise = (async () => {
      try {
        await stageSource({ root, destination: stage, sourceUrl: lock.url, commit: lock.commit, signal: controller.signal, onOutput: output })
        check()
        const archives = validateModelManifest(id, JSON.parse(readFileSync(join(stage, 'models.json'), 'utf8')))
        await prepareConfig(stage, '')
        const total = archives.reduce((sum, asset) => sum + asset.size, 0)
        let completed = 0
        for (const asset of archives) {
          check(); job.phase = `下载 ${asset.name}`
          const destination = join(downloads, asset.name)
          const common = { destination, sha256: asset.sha256, size: asset.size, signal: controller.signal,
            onProgress: done => { job.progress = Math.min(80, Math.round((completed + done) / total * 80)) } }
          if (asset.parts?.length) await downloadParts({ ...common, parts: asset.parts.map(part => ({ ...part, url: mirrorUrl(part.url, mirror) })) })
          else await downloadAsset({ ...common, url: mirrorUrl(asset.url, mirror) })
          completed += asset.size
          check(); job.phase = `解压 ${asset.name}`
          const targetDir = asset.dest === '.' ? stage : localDirectory(root, join(stage, asset.dest))
          await extract({ root, archive: destination, destination: targetDir, signal: controller.signal })
        }
        if (id === 'voice-cloud') {
          const voiceDir = localDirectory(root, join(stage, 'voices', 'age12-cloud'))
          const voiceFile = join(voiceDir, 'voice.json')
          if (!existsSync(voiceFile)) writeFileSync(voiceFile, `${JSON.stringify({ engine: 'cloud', speaker: '', strict: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        }
        check(); job.phase = '准备 Python 环境'; job.progress = 85
        await bootstrap({ root, destination: stage, id, signal: controller.signal, onOutput: output, mirror })
        check()
        const python = join(stage, '.venv', 'Scripts', 'python.exe')
        if (!existsSync(python) || !existsSync(join(stage, 'models')) || (id === 'voice-local' && (!existsSync(join(stage, '.venv-gsv', 'Scripts', 'python.exe')) || !existsSync(join(stage, 'vendor', 'GPT-SoVITS', 'code'))))) throw new Error('语音运行环境或模型缺失，安装未发布')
        prepareRelocatedConfig(stage, target)
        prepareRelocatedVenv(stage, target)
        writeFileSync(join(stage, '.installed-meta.json'), `${JSON.stringify({ commit: lock.commit, installedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        if (existsSync(target)) throw new Error('语音包目录已出现，原文件未覆盖')
        renameSync(stage, target)
        job.phase = '完成'; job.progress = 100; job.stage = null
      } catch (error) {
        job.phase = controller.signal.aborted ? '已取消' : '失败'
        job.error = String(error?.message ?? error)
      }
    })()
    return Promise.resolve({ ok: true })
  }
  function cancel(id) {
    const job = jobs.get(id)
    if (!job || ['完成', '失败', '已取消'].includes(job.phase)) return { ok: false, error: '没有进行中的安装' }
    job.controller.abort()
    return { ok: true }
  }
  function cleanup(id) {
    if (!VOICE_SOURCE_LOCK[id]) throw new Error('未知语音包')
    const job = jobs.get(id)
    if (job && !['完成', '失败', '已取消'].includes(job.phase)) throw new Error('语音包正在安装，不能清理')
    const moves = []
    const downloadsRoot = join(root, 'downloads'), stagingRoot = join(root, 'install-staging')
    for (const parent of [downloadsRoot, stagingRoot]) {
      if (!existsSync(parent)) continue
      if (lstatSync(parent).isSymbolicLink() || !within(root, realpathSync(parent))) throw new Error('安装残留目录不能是符号链接')
    }
    const download = join(downloadsRoot, id)
    if (existsSync(download)) moves.push({ source: download, relative: 'downloads' })
    if (existsSync(stagingRoot)) for (const name of readdirSync(stagingRoot)) {
      if (new RegExp(`^${id}-[a-f0-9-]{36}$`).test(name)) moves.push({ source: join(stagingRoot, name), relative: join('staging', name) })
    }
    for (const item of moves) if (lstatSync(item.source).isSymbolicLink() || !within(root, realpathSync(item.source))) throw new Error('安装残留不能是符号链接')
    if (!moves.length) return { ok: true, backup: null, moved: 0 }
    const backups = localDirectory(root, join(root, 'installer-backups'))
    const name = `${id}-${randomUUID()}`, backup = join(backups, name)
    mkdirSync(backup, { mode: 0o700 })
    const completed = []
    try {
      for (const item of moves) {
        const dest = join(backup, item.relative)
        localDirectory(root, resolve(dest, '..'))
        renameSync(item.source, dest); completed.push({ ...item, dest })
      }
    } catch (error) {
      for (const item of completed.reverse()) renameSync(item.dest, item.source)
      try { rmdirSync(join(backup, 'staging')) } catch {}
      try { rmdirSync(backup) } catch {}
      throw error
    }
    return { ok: true, backup: name, moved: completed.length }
  }
  async function stopAll() { for (const job of jobs.values()) if (!['完成', '失败', '已取消'].includes(job.phase)) job.controller.abort(); await Promise.all([...jobs.values()].map(job => job.promise)) }
  return { start, cancel, cleanup, status, supported: platform === 'win32', wait: id => jobs.get(id)?.promise ?? Promise.resolve(), stopAll }
}
