import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { createVoicePacks } from './voice-packs.js'
import { readVoiceResponse, synthesizeToFile } from './voice-tts.js'
import { archivePack, listArchives, restorePack } from './archives.mjs'
import { createOnlineVoiceInstaller } from './online-installer.mjs'
import { classifyVoiceError, pickFallbackRoute } from './voice-diagnostics.js'
import { cleanupTemp, describeAudio, inspectAudio, listAudioFiles, parseTargetKey, probeAudio, processAudioVolume, resolveFfmpeg, safeJoinLibrary } from './voice-core.mjs'
import { assertOutboundAuditOk, createVoiceLedger, evaluateVoiceTrigger, normalizeVoiceTrigger, normalizeVoiceLimits } from './voice-policy.mjs'

function localEndpoint(input) {
  let url
  try { url = new URL(String(input)) } catch { throw new Error('Voice endpoint must be a loopback HTTP URL') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Voice endpoint must be a loopback HTTP URL')
  return url.origin
}

/** The orchestrator's Effect-backed voice host; attached by the plugin once that service exists. Sends are refused until one is attached. */
let effectHost = null
/** Results of committed sends by token, so a repeated commit returns the first result instead of sending again. */
const committedSends = new Map()
const COMMITTED_SENDS_LIMIT = 1024

/** Attach the orchestrator's voice Effect host; a missing or unusable host leaves every send refused rather than delivered untraced. */
export function useEffectHost(host) {
  effectHost = host && typeof host.commit === 'function' ? host : null
}

/**
 * Refuses a send that has no Effect host: without one the send leaves no Effect record, so it would be untraceable.
 * Fail-closed is deliberate, so a bridge is never called behind the Effect queue's back.
 */
function effectHostRequired() {
  const error = new Error('语音发送需要 Effect host：当前未接入，已拒绝发送（不会直发）')
  error.code = 'VOICE_EFFECT_HOST_REQUIRED'
  return error
}

function rememberSend(token, result) {
  if (committedSends.has(token)) return
  committedSends.set(token, result)
  while (committedSends.size > COMMITTED_SENDS_LIMIT) committedSends.delete(committedSends.keys().next().value)
}

export function createVoiceService({ stateDir, fetchImpl = fetch, createPacks = createVoicePacks, createInstaller = createOnlineVoiceInstaller, checkSendReadiness = async () => ({ ok: false, error: 'QQ 桥接状态不可用' }), probeLibrary, sendLibraryVoice = async () => { throw new Error('QQ 桥接状态不可用') } }) {
  if (!stateDir) throw new Error('Voice state directory is required')
  const file = join(stateDir, 'config.json')
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const voice = saved.voice ?? {}
  const audioDir = join(stateDir, 'audio')
  const processingDir = join(stateDir, 'tmp')
  const auditFile = join(stateDir, 'data', 'audit.jsonl')
  const ledger = createVoiceLedger({ file: join(stateDir, 'data', 'send-ledger.json') })
  const SEND_TOKEN_TTL_MS = 5 * 60 * 1000
  const pendingSends = new Map()
  const LIBRARY_AUDIO_RE = /\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|amr|silk|slk|wma|spx)$/i
  const voicePacks = { ...(saved.voicePacks ?? {}), dir: join(stateDir, 'packs') }
  voicePacks.manifests = [
    { id: 'voice-local', url: join(stateDir, 'sources', 'voice-local') },
    { id: 'voice-cloud', url: join(stateDir, 'sources', 'voice-cloud') },
    ...(Array.isArray(saved.voicePacks?.manifests) ? saved.voicePacks.manifests.filter(item => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(item?.id ?? ''))) : []),
  ]
  const cfg = { voicePacks, socialV2: { voice }, configPath: file }
  const packs = createPacks(cfg)
  const installer = createInstaller({ stateDir })
  let operations = Promise.resolve()
  let closing = false
  let disposePromise = null
  const shutdown = new AbortController()
  const syntheses = new Set()
  const packTests = new Set()
  const librarySends = new Set()
  const testing = new Set()
  const starts = new Map()
  const stopErrors = failures => failures.map(item => String(item.status === 'rejected' ? (item.reason?.message ?? item.reason) : (item.value?.error || '停止失败')))
  const serial = fn => { if (closing) return Promise.reject(new Error('语音插件已关闭')); const next = operations.then(fn, fn); operations = next.catch(() => {}); return next }
  const cancelStarts = id => { for (const [key, controllers] of starts) if (id === undefined || key === id) for (const controller of controllers) controller.abort(new Error('语音启动已取消')) }
  const startOperation = (id, fn) => {
    const controller = new AbortController(), group = starts.get(id) ?? new Set()
    group.add(controller); starts.set(id, group)
    const result = serial(async () => { controller.signal.throwIfAborted(); return fn(controller.signal) })
    result.then(() => { group.delete(controller); if (!group.size && starts.get(id) === group) starts.delete(id) }, () => { group.delete(controller); if (!group.size && starts.get(id) === group) starts.delete(id) })
    return result
  }
  async function inspectPack(id) {
    if (testing.has(id)) throw new Error('语音包正在测试，请等待完成或停止服务')
    const online = installer.status(id)
    if (online && !['完成', '失败', '已取消'].includes(online.phase)) throw new Error('语音包正在安装，请等待完成或取消')
    const pack = (await packs.list()).packs.find(item => item.id === id)
    if (!pack) throw new Error('未知语音包')
    if (pack.import && !['完成', '失败'].includes(pack.import.phase)) throw new Error('语音包正在导入，请等待完成')
    return pack
  }
  async function ensureStopped(id, pack) {
    if (pack.running || await packs.hasOwnedWorkers?.(id)) {
      const stopped = await packs.stop(id)
      if (stopped?.ok === false) throw new Error(stopped.error || '语音包未能停止')
      pack = await inspectPack(id)
    }
    if (pack.running || pack.engineUp || await packs.hasOwnedWorkers?.(id)) throw new Error('语音进程或端口仍在使用，请先停止相关进程')
  }
  function containsPath(parent, child) {
    const suffix = relative(parent, child)
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  }
  function voiceSettings() {
    const maxSeconds = Number(voice.maxSeconds), maxBytes = Number(voice.maxBytes), volume = Number(voice.defaultVolume)
    return {
      maxSeconds: Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 300,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 20 * 1024 * 1024,
      defaultVolume: Number.isFinite(volume) && volume > 0 ? volume : 1,
      normalize: voice.normalize === true,
      loudness: voice.loudness ?? 'normal',
      ffmpegPath: typeof voice.ffmpegPath === 'string' ? voice.ffmpegPath : '',
      ffprobePath: typeof voice.ffprobePath === 'string' ? voice.ffprobePath : '',
      trigger: normalizeVoiceTrigger(voice.trigger ?? {}),
      limits: normalizeVoiceLimits(voice),
      audit: voice.audit !== false,
    }
  }
  async function resolveLibraryFile(name, { channel = 'agent' } = {}) {
    const raw = String(name ?? '')
    if (isAbsolute(raw) || raw.startsWith('~')) {
      if (channel === 'agent') throw new Error('AI 发送只能使用语音库内的相对文件名')
      throw new Error('请选择本地音频文件的绝对路径')
    }
    if (!raw || raw.includes('\\') || raw.includes('\0') || raw.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !LIBRARY_AUDIO_RE.test(raw)) throw new Error('语音库文件名无效')
    const root = resolve(audioDir), parts = raw.split('/'), target = join(root, ...parts)
    if (parts.length > 5) throw new Error('语音库文件路径过深')
    let current = root
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part)
      let item
      try { item = await lstat(current) } catch (error) { if (error.code === 'ENOENT') throw new Error('语音库文件不存在'); throw error }
      if (item.isSymbolicLink() || (current === target ? !item.isFile() : !item.isDirectory())) throw new Error('语音库文件无效或包含符号链接')
    }
    if (!containsPath(realpathSync(root), realpathSync(current))) throw new Error('语音库文件路径无效')
    return current
  }
  async function resolveOperatorFile(filePath) {
    if (typeof filePath !== 'string' || filePath.includes('\0') || filePath.length > 4096 || !isAbsolute(filePath)) throw new Error('请选择本地音频文件的绝对路径')
    const file = await realpath(filePath)
    if (!(await stat(file)).isFile()) throw new Error('所选音频路径不是普通文件')
    return file
  }
  function dropPending(token) {
    const pending = pendingSends.get(String(token ?? ''))
    if (!pending) return null
    pendingSends.delete(String(token))
    cleanupTemp(pending.file, pending.temp)
    return pending
  }
  function cleanupPending() { for (const token of [...pendingSends.keys()]) dropPending(token) }
  function writeAuditLine(pending, detail = {}) {
    try {
      mkdirSync(dirname(auditFile), { recursive: true, mode: 0o700 })
      appendFileSync(auditFile, `${JSON.stringify({
        at: new Date().toISOString(), target: pending.target, action: pending.action, channel: pending.channel,
        file: pending.file ? basename(pending.file) : null, messageId: detail.messageId ?? null, verified: detail.verified === true,
      })}\n`, { mode: 0o600 })
    } catch {}
  }
  async function prepareSend(input = {}) {
    if (closing) throw new Error('语音插件已关闭')
    refreshVoice()
    const channel = input.channel === 'operator' ? 'operator' : 'agent'
    const target = parseTargetKey(input.key ?? input.target)
    if (!target) throw new Error('发送目标应为 group:群号 或 private:QQ号')
    const settings = voiceSettings(), dryRun = input.dryRun === true
    let action = 'voice', text = null, file = null, temp = false, detail = ''
    try {
      if (input.text !== undefined) {
        const say = String(input.text ?? '').trim()
        if (!say) throw new Error('合成文本不能为空')
        const max = maxSynthesisChars()
        if (say.length > max) throw new Error(`要说的话最多 ${max} 字（收到 ${say.length}）`)
        action = 'text'
        text = say
        detail = `合成文本 ${say.length} 字`
      } else {
        file = channel === 'operator' && input.filePath !== undefined
          ? await resolveOperatorFile(input.filePath)
          : await resolveLibraryFile(input.file ?? input.audio ?? input.filePath, { channel })
        shutdown.signal.throwIfAborted()
        assertOutboundAuditOk(`[语音:${basename(file)}]`, { knownTokens: input.knownTokens, audit: settings.audit })
        const info = await inspectAudio(file, { maxBytes: settings.maxBytes, maxSeconds: settings.maxSeconds, ffprobePath: settings.ffprobePath || undefined })
        shutdown.signal.throwIfAborted()
        if (!info.ok) throw new Error(`音频不可发送：${info.error}`)
        const processed = await processAudioVolume(file, {
          volume: input.volume ?? settings.defaultVolume, normalize: input.normalize === true || settings.normalize,
          loudness: input.loudness ?? settings.loudness, ffmpegPath: settings.ffmpegPath || null, tmpDir: processingDir,
        })
        shutdown.signal.throwIfAborted()
        file = processed.path
        temp = processed.converted === true
        detail = `${describeAudio(info)}${processed.applied ? ` · ${processed.detail}` : ''}`
      }
      if (input.triggerContext) {
        const decision = evaluateVoiceTrigger({
          ...target, ownerId: String(input.ownerId ?? ''), trigger: settings.trigger,
          lastSpeaker: input.triggerContext.lastSpeaker, ownerLastAt: input.triggerContext.ownerAt,
          lastSentAt: input.triggerContext.lastSentAt, now: input.now,
        })
        if (!decision.ok) {
          const error = new Error(decision.block)
          error.code = 'voice.trigger-blocked'
          error.stage = 'trigger'
          throw error
        }
      }
      ledger.check(target.key, settings.limits)
      const token = randomUUID()
      pendingSends.set(token, { token, target: target.key, action, text, file, temp, channel, dryRun, detail, limits: settings.limits, expiresAt: Date.now() + SEND_TOKEN_TTL_MS })
      return { ok: true, token, dryRun, target: target.key, channel, action, path: file, temp, text, detail }
    } catch (error) {
      cleanupTemp(file, temp)
      throw error
    }
  }
  function checkedImportTarget(id) {
    const root = join(stateDir, 'packs'), target = join(root, id)
    if (lstatSync(root).isSymbolicLink() || lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || !lstatSync(join(target, 'config.toml')).isFile()) throw new Error('当前语音包目录无效，拒绝清理')
    return target
  }
  const readDiskConfig = () => {
    let disk
    try { disk = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
    if (!disk || typeof disk !== 'object' || Array.isArray(disk) || (disk.voice != null && (typeof disk.voice !== 'object' || Array.isArray(disk.voice)))) throw new Error('语音配置无效，已保留原文件')
    return disk
  }
  const updateLiveVoice = next => {
    for (const key of Object.keys(voice)) delete voice[key]
    Object.assign(voice, next)
  }
  const refreshVoice = () => { const disk = readDiskConfig(); updateLiveVoice(disk.voice ?? {}); return disk }
  const persist = (next, disk = readDiskConfig()) => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify({ ...disk, voice: next, voicePacks: disk.voicePacks ?? {} }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(tmp, file)
    } catch (error) { try { unlinkSync(tmp) } catch {} throw error }
    updateLiveVoice(next)
  }
  function switchVoiceRoute(tts, route) {
    const oldRoute = tts.route === 'cloud' ? 'cloud' : 'local'
    if (route === oldRoute) return { ...tts, route }
    const selections = tts.routeVoiceSelections ?? {}
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw new Error('线路音色记录无效，已保留原配置')
    const target = selections[route]
    if (target !== undefined && (!target || typeof target !== 'object' || Array.isArray(target) || (target.character !== undefined && typeof target.character !== 'string') || (target.voice !== undefined && typeof target.voice !== 'string'))) throw new Error('线路音色记录无效，已保留原配置')
    return { ...tts, route,
      routeVoiceSelections: { ...selections, [oldRoute]: { character: tts.character ?? '', voice: tts.voice ?? '' } },
      character: target?.character ?? '', voice: target?.voice ?? '' }
  }
  const maxSynthesisChars = () => {
    const configured = Number(voice.tts?.maxChars)
    return Number.isFinite(configured) && configured > 0 ? configured : 120
  }
  function cloudVoiceFingerprint() {
    const dir = join(stateDir, 'packs', 'voice-cloud', 'voices')
    let entries
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('云端音色目录无效')
      entries = readdirSync(dir)
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
    const first = entries.find(name => name.startsWith('age12'))
    if (!first) return ''
    const folder = join(dir, first), folderStat = lstatSync(folder)
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error('云端音色目录无效')
    const file = join(folder, 'voice.json')
    let stat
    try { stat = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return `missing:${first}`; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('云端音色文件无效或过大')
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  function voiceCharacters(ids = ['voice-local', 'voice-cloud']) {
    const names = new Set()
    for (const id of ids) {
      const file = join(stateDir, 'packs', id, 'config.toml')
      let content
      try {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`语音包配置无效：${id}`)
        content = readFileSync(file, 'utf8')
      } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      let parsed
      try { parsed = parseToml(content) } catch { throw new Error(`语音包配置格式无效：${id}`) }
      const section = parsed.voice?.characters
      if (section === undefined) continue
      if (!section || typeof section !== 'object' || Array.isArray(section) || Object.values(section).some(value => typeof value !== 'string')) throw new Error(`语音包音色映射无效：${id}`)
      for (const name of Object.keys(section)) names.add(name)
    }
    return [...names]
  }
  function synthesizeCore({ text, baseUrl, character, voice: voiceId, style, timeoutMs, cacheVersion } = {}, { defaultVoice = false, routeVoice } = {}) {
    shutdown.signal.throwIfAborted()
    refreshVoice()
    const say = String(text ?? '').trim(), maxChars = maxSynthesisChars()
    if (say.length > maxChars) throw new Error(`要说的话最多 ${maxChars} 字（收到 ${say.length}）`)
    const route = voice.tts?.route === 'cloud' ? 'cloud' : 'local'
    const endpoint = localEndpoint(baseUrl || voice.tts?.endpoints?.[route] || (route === 'local' ? voice.tts?.baseUrl : '') || (route === 'cloud' ? 'http://127.0.0.1:8767' : 'http://127.0.0.1:8765'))
    const timeout = timeoutMs ?? voice.tts?.timeoutMs
    let cloudEndpoint = ''
    try { cloudEndpoint = localEndpoint(voice.tts?.endpoints?.cloud || 'http://127.0.0.1:8767') } catch {}
    const cloudTransaction = join(stateDir, 'packs', 'voice-cloud', '.cloud-config-transaction.json')
    if (endpoint === cloudEndpoint && existsSync(cloudTransaction)) {
      return packs.readCloudConfig('voice-cloud').then(() => {
        if (existsSync(cloudTransaction)) throw new Error('云端配置恢复尚未完成')
        return synthesizeCore({ text, baseUrl, character, voice: voiceId, style, timeoutMs, cacheVersion }, { defaultVoice, routeVoice })
      })
    }
    const version = cacheVersion ?? voice.tts?.cacheVersion ?? null
    const effectiveVersion = endpoint === cloudEndpoint ? [version, cloudVoiceFingerprint()] : version
    if (routeVoice !== undefined && !['local', 'cloud'].includes(routeVoice)) throw new Error('无效的语音线路')
    const target = routeVoice ? switchVoiceRoute(voice.tts ?? {}, routeVoice) : null
    const selectedCharacter = target ? target.character || '' : defaultVoice || voiceId ? '' : character || voice.tts?.character
    const selectedVoice = target ? (selectedCharacter ? '' : target.voice || '') : defaultVoice ? '' : voiceId || (selectedCharacter ? '' : voice.tts?.voice)
    return synthesizeToFile({ text: say, character: selectedCharacter, voice: selectedVoice, style,
      baseUrl: endpoint, outDir: join(stateDir, 'cache'), fetchImpl,
      timeoutMs: Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Math.min(120000, Number(timeout)) : 60000,
      cacheVersion: effectiveVersion, signal: shutdown.signal })
  }
  function synthesize(options, internalOptions) {
    if (closing) throw new Error('语音插件已关闭')
    const operation = Promise.resolve(synthesizeCore(options, internalOptions))
    syntheses.add(operation)
    operation.finally(() => syntheses.delete(operation)).catch(() => {})
    return operation
  }
  async function preview(id, text) {
    refreshVoice()
    if (!['voice-local', 'voice-cloud'].includes(id)) throw new Error('未知语音包')
    const sample = String(text ?? '')
    if (sample.length > 500) throw new Error('试听文本最多 500 字')
    const route = id === 'voice-cloud' ? 'cloud' : 'local'
    const baseUrl = voice.tts?.endpoints?.[route] || (route === 'local' ? voice.tts?.baseUrl : '') || (route === 'cloud' ? 'http://127.0.0.1:8767' : 'http://127.0.0.1:8765')
    const activeRoute = voice.tts?.route === 'cloud' ? 'cloud' : 'local'
    if (route === activeRoute) return synthesize({ text: sample, baseUrl })
    const target = switchVoiceRoute(voice.tts ?? {}, route)
    const character = target.character || '', voiceId = character ? '' : target.voice || ''
    return synthesize({ text: sample, baseUrl, character, voice: voiceId }, { defaultVoice: !character && !voiceId })
  }
  function finishPending(pending, detail = {}) {
    cleanupTemp(pending.file, pending.temp)
    if (pending.dryRun !== true) {
      ledger.commit(pending.target)
      writeAuditLine(pending, detail)
    }
    return { ok: true, target: pending.target, action: pending.action,
      ...(detail.messageId !== undefined ? { messageId: detail.messageId } : {}),
      ...(detail.verified === true ? { verified: true } : {}) }
  }
  /** A bridge receipt as the effect payload records it; without any receipt the payload carries none. */
  function externalReceipt(detail = {}) {
    const receipt = {}
    if (detail.messageId !== undefined && detail.messageId !== null) receipt.messageId = String(detail.messageId)
    if (detail.verified === true) receipt.verified = true
    if (detail.duration !== undefined && Number.isFinite(Number(detail.duration))) receipt.duration = Number(detail.duration)
    return Object.keys(receipt).length ? { external: receipt } : {}
  }
  /**
   * Records the prepared send as a `voice` Effect and, when the send still has to reach the bridge, runs it through `options.deliver`.
   * A repeated commit of one token returns the first result, so a retried request cannot send a second message.
   * Without an Effect host the send is refused and its staged file dropped, so no delivery can escape the Effect record.
   */
  async function commitSend(token, detail = {}, options = {}) {
    const key = String(token ?? '')
    const remembered = committedSends.get(key)
    if (remembered) return remembered
    const pending = pendingSends.get(key)
    if (!pending) throw new Error('语音发送凭据无效或已过期')
    if (Date.now() > pending.expiresAt) { dropPending(key); throw new Error('语音发送凭据已过期') }
    // A dry run is only a validation, so it records no Effect and needs no host.
    if (pending.dryRun === true) {
      pendingSends.delete(key)
      const finished = finishPending(pending, detail)
      rememberSend(key, finished)
      return finished
    }
    if (!effectHost) { dropPending(key); throw effectHostRequired() }
    const description = typeof detail.detail === 'string' && detail.detail ? detail.detail : pending.detail
    const payload = { target: pending.target, action: pending.action,
      ...(pending.file ? { file: basename(pending.file) } : {}), channel: pending.channel,
      ...(description ? { detail: description } : {}), ...externalReceipt(detail) }
    let receipt
    try {
      receipt = await effectHost.commit(payload, { key, ...(options.deliver ? { deliver: options.deliver } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) })
    } catch (error) {
      pendingSends.delete(key)
      cleanupTemp(pending.file, pending.temp)
      throw error
    }
    pendingSends.delete(key)
    const merged = { ...detail,
      ...(receipt?.messageId !== undefined ? { messageId: receipt.messageId } : {}),
      ...(receipt?.verified !== undefined ? { verified: receipt.verified } : {}),
      ...(receipt?.duration !== undefined ? { duration: receipt.duration } : {}) }
    const finished = finishPending(pending, merged)
    rememberSend(key, finished)
    return finished
  }
  function abortSend(token) {
    const key = String(token ?? '')
    const status = effectHost?.status?.(key)
    if (status && (status.inFlight === true || ['sent', 'unknown', 'failed'].includes(status.state))) return { ok: false, aborted: false, state: status.state, inFlight: status.inFlight === true }
    if (status?.state === 'pending') effectHost.cancel(key)
    const pending = dropPending(key)
    return { ok: true, aborted: Boolean(pending) }
  }
  const localProbeLibrary = async ({ offset = 0 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('语音库页码无效')
    const settings = voiceSettings(), files = listAudioFiles(audioDir), page = files.slice(offset, offset + 100)
    const voices = await Promise.all(page.map(async file => {
      const name = relative(audioDir, file).split(sep).join('/')
      const info = await inspectAudio(file, { maxBytes: settings.maxBytes, maxSeconds: settings.maxSeconds, ffprobePath: settings.ffprobePath || undefined })
      return info.ok
        ? { name, ok: true, detail: describeAudio(info), bytes: info.size, duration: info.duration ?? null }
        : { name, ok: false, error: info.error }
    }))
    return { ok: true, dir: audioDir, offset, voices, truncated: offset + 100 < files.length }
  }
  return {
    async probeLibrary({ offset = 0 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('语音库页码无效')
      if (probeLibrary) return probeLibrary({ offset })
      return localProbeLibrary({ offset })
    },
    prepareSend,
    commitSend,
    abortSend,
    /** Attach the orchestrator's voice Effect host to this plugin instance's sends. */
    useEffectHost,
    async resolveLibrary(input = {}) {
      const file = await resolveLibraryFile(input.file ?? input.audio ?? input.name, { channel: input.channel === 'operator' ? 'operator' : 'agent' })
      return { ok: true, path: file }
    },
    policy(input = {}) {
      refreshVoice()
      const target = parseTargetKey(input.key ?? input.target)
      if (!target) throw new Error('发送目标应为 group:群号 或 private:QQ号')
      const trigger = normalizeVoiceTrigger(input.trigger ?? voice.trigger ?? {})
      const decision = evaluateVoiceTrigger({
        ...target, ownerId: String(input.ownerId ?? ''), trigger,
        lastSpeaker: input.lastSpeaker ?? input.triggerContext?.lastSpeaker,
        ownerLastAt: input.ownerLastAt ?? input.triggerContext?.ownerAt,
        lastSentAt: input.lastSentAt ?? input.triggerContext?.lastSentAt, now: input.now,
      })
      return { ok: true, allowed: decision.ok, block: decision.block, trigger, limits: normalizeVoiceLimits(voice) }
    },
    auditCheck(subject, knownTokens = []) {
      assertOutboundAuditOk(subject, { knownTokens })
      return { ok: true }
    },
    budgetStatus(scopeKey = '') { return { ...ledger.snapshot(scopeKey), limits: normalizeVoiceLimits(voice) } },
    sendLibraryVoice(input) {
      if (closing) return Promise.reject(new Error('语音插件已关闭'))
      const operation = (async () => {
        if (typeof input?.dryRun !== 'boolean') throw new Error('请明确选择只校验或发送')
        const target = String(input.target || '').trim(), name = String(input.file || '')
        if (!/^(?:group|private):\d{1,24}$/.test(target)) throw new Error('发送目标应为 group:群号 或 private:QQ号')
        if (input.filePath !== undefined && (name || input.text !== undefined)) throw new Error('文本、语音库文件和本地路径不能同时提供')
        if (input.text !== undefined && name) throw new Error('文本与音频文件不能同时提供')
        const prepared = await prepareSend({ ...input, target, channel: 'operator' })
        const direct = () => sendLibraryVoice(prepared.action === 'text'
          ? { target: prepared.target, text: prepared.text, dryRun: false }
          : { target: prepared.target, file: prepared.path, dryRun: false })
        try {
          shutdown.signal.throwIfAborted()
          if (closing) throw new Error('语音插件已关闭')
          // A dry run only asks the bridge to validate, so it never becomes an Effect.
          if (input.dryRun === true) {
            const preview = await sendLibraryVoice(prepared.action === 'text'
              ? { target: prepared.target, text: prepared.text, dryRun: true }
              : { target: prepared.target, file: prepared.path, dryRun: true })
            dropPending(prepared.token)
            return preview
          }
          // The bridge is reached only through the Effect host, which records the send; a missing host refuses it.
          return await commitSend(prepared.token, {}, { deliver: direct })
        } catch (error) {
          dropPending(prepared.token)
          throw error
        }
      })()
      librarySends.add(operation)
      operation.finally(() => librarySends.delete(operation)).catch(() => {})
      return operation
    },
    list() { return serial(async () => { const list = await packs.list(); return { ...list, onlineInstallSupported: installer.supported === true, directoryPickerSupported: process.platform === 'win32', packs: list.packs.map(pack => ({ ...pack, install: installer.status(pack.id), archives: listArchives(stateDir, pack.id) })) } }) },
    launchStatus() { if (closing) throw new Error('语音插件已关闭'); return packs.launchStatus() },
    async library({ offset = 0 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('语音库页码无效')
      const dir = join(stateDir, 'audio'), voices = []
      let root
      try { root = await lstat(dir) } catch (error) { if (error.code === 'ENOENT') return { ok: true, dir, count: 0, offset, voices, truncated: false }; throw error }
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('语音库目录无效或为符号链接')
      const audio = /\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|amr|silk|slk|wma|spx)$/i
      async function walk(current, depth) {
        if (depth > 4) return
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue
          const full = join(current, entry.name)
          if (entry.isDirectory()) await walk(full, depth + 1)
          else if (entry.isFile() && audio.test(entry.name)) voices.push({ name: relative(dir, full).split(sep).join('/') })
        }
      }
      await walk(dir, 0)
      voices.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      return { ok: true, dir, count: voices.length, offset, voices: voices.slice(offset, offset + 100), truncated: offset + 100 < voices.length }
    },
    install: (id, options) => serial(async () => { const pack = await inspectPack(id); if (pack.installed || pack.running || pack.engineUp || await packs.hasOwnedWorkers?.(id)) throw new Error('语音包或相关进程、端口已在使用'); return installer.start(id, options) }),
    cancelInstall: id => installer.cancel(id),
    cleanupInstall: id => serial(() => installer.cleanup(id)),
    saveCloudConfig: (id, body) => serial(async () => { await inspectPack(id); return packs.cloudConfig(id, body) }),
    readCloudConfig: id => serial(async () => { await inspectPack(id); return packs.readCloudConfig(id) }),
    readCloudStats: id => serial(async () => { await inspectPack(id); return packs.cloudStats(id) }),
    setPackEnabled: (id, enabled) => serial(async () => { await inspectPack(id); return packs.setEnabled(id, enabled) }),
    testPack(id, { text } = {}) {
      if (closing) return Promise.reject(new Error('语音插件已关闭'))
      const operation = (async () => {
        const request = await serial(async () => {
          refreshVoice()
          const limit = maxSynthesisChars()
          const value = text === undefined ? '你好呀，语音包已经装好了。'.slice(0, limit) : String(text).trim()
          if (!value) throw new Error('测试文本不能为空')
          if (value.length > limit) throw new Error(`要说的话最多 ${limit} 字（收到 ${value.length}）`)
          await inspectPack(id)
          testing.add(id)
          const configuredTimeout = Number(voice.tts?.timeoutMs)
          const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(120000, Math.floor(configuredTimeout)) : 60000
          return { text: value, timeoutMs }
        })
        try {
          shutdown.signal.throwIfAborted()
          const result = await packs.test(id, { ...request, signal: shutdown.signal })
          shutdown.signal.throwIfAborted()
          return result
        } finally { testing.delete(id) }
      })()
      packTests.add(operation)
      operation.finally(() => packTests.delete(operation)).catch(() => {})
      return operation
    },
    deleteImportSource: (id, sourceDir) => serial(async () => {
      const pack = await inspectPack(id), source = resolve(String(sourceDir || ''))
      if (!pack.importSource || resolve(pack.importSource) !== source) throw new Error('源目录不是已记录的导入源文件夹')
      const target = checkedImportTarget(id), stat = lstatSync(source)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('源目录必须是普通目录')
      const sourceReal = realpathSync(source), targetReal = realpathSync(target)
      if (containsPath(sourceReal, targetReal) || containsPath(targetReal, sourceReal)) throw new Error('源目录与安装目录重叠，拒绝清理')
      return packs.deleteImportSource(id, source)
    }),
    deleteImportBackup: (id, backupDir) => serial(async () => {
      const pack = await inspectPack(id), backup = resolve(String(backupDir || ''))
      if (!pack.backupDir || resolve(pack.backupDir) !== backup) throw new Error('备份目录不是已记录的导入备份')
      const target = resolve(checkedImportTarget(id)), stat = lstatSync(backup)
      if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(backup) !== dirname(target) || !new RegExp(`^${id}\\.backup-\\d+$`).test(backup.slice(dirname(backup).length + 1))) throw new Error('备份目录无效，拒绝清理')
      return packs.deleteImportBackup(id, backup)
    }),
    start: id => startOperation(id, async signal => { await inspectPack(id); signal.throwIfAborted(); return packs.start(id, { signal }) }),
    stop: id => { cancelStarts(id); return serial(() => packs.stop(id)) },
    stopOwned: () => { cancelStarts(); return serial(async () => {
      const failures = await packs.stopOwned()
      const errors = stopErrors(failures)
      return { ok: errors.length === 0, failures: errors, ...(errors.length ? { error: errors.join('；') } : {}) }
    }) },
    importStart: (id, options) => serial(async () => {
      const pack = await inspectPack(id)
      if (await packs.hasOwnedWorkers?.(id)) throw new Error('语音包仍有受管进程在运行，请先停止后再导入')
      if (pack.cloudConfigError) throw new Error(pack.cloudConfigError)
      if (id === 'voice-cloud' && existsSync(join(stateDir, 'packs', id, '.cloud-config-transaction.json'))) await packs.readCloudConfig(id)
      return packs.startImport(id, options)
    }),
    archive(id) { return serial(async () => {
      const pack = await inspectPack(id)
      await ensureStopped(id, pack)
      const name = archivePack(stateDir, id, pack.enabled)
      try { await packs.setEnabled(id, false) } catch (error) {
        const restored = restorePack(stateDir, id, name)
        rmSync(restored.archive, { recursive: true, force: true })
        throw error
      }
      return { ok: true, name }
    }) },
    restore(id, name) { return serial(async () => {
      const pack = await inspectPack(id)
      await ensureStopped(id, pack)
      const restored = restorePack(stateDir, id, name)
      try { await packs.setEnabled(id, restored.enabled) } catch (error) {
        renameSync(restored.target, join(restored.archive, 'pack'))
        throw error
      }
      rmSync(restored.archive, { recursive: true, force: true })
      return { ok: true }
    }) },
    activate(id) { return startOperation(id, async signal => {
      await inspectPack(id)
      signal.throwIfAborted()
      const already = await packs.isOwnedRunning(id)
      signal.throwIfAborted()
      const started = already ? { ok: true, already: true } : await packs.start(id, { signal })
      if (started?.ok === false) return started
      signal.throwIfAborted()
      let defaultVoiceNotice = false
      try {
        const disk = readDiskConfig(), next = structuredClone(disk.voice ?? {})
        const previous = next.tts ?? {}, route = id === 'voice-cloud' ? 'cloud' : 'local'
        next.tts = { ...switchVoiceRoute(previous, route), enabled: true }
        defaultVoiceNotice = (previous.route === 'cloud' ? 'cloud' : 'local') !== route && !!(previous.character || previous.voice) && !(next.tts.character || next.tts.voice)
        persist(next, disk)
      } catch (error) {
        if (!already) {
          try { const stopped = await packs.stop(id); if (stopped?.ok === false) throw new Error(stopped.error || '停止失败') }
          catch (stopError) { throw new Error(`${String(error?.message ?? error)}；新启动的语音服务未能停止：${String(stopError?.message ?? stopError)}`) }
        }
        throw error
      }
      const warnings = started.warning ? [started.warning] : []
      if (defaultVoiceNotice) warnings.push('新线路使用引擎默认音色，原线路音色已保存')
      try {
        for (const other of (await packs.list()).packs) {
          if (other.id === id) continue
          if (testing.has(other.id)) { warnings.push(`旧语音包 ${other.id} 正在测试，未自动停止`); continue }
          try {
            if (await (packs.hasOwnedWorkers ? packs.hasOwnedWorkers(other.id) : packs.isOwnedRunning(other.id))) {
              const stopped = await packs.stop(other.id)
              if (stopped?.ok === false) throw new Error(stopped.error || '停止失败')
            }
          } catch (error) { warnings.push(`旧语音包 ${other.id} 未能停止：${String(error?.message ?? error)}`) }
        }
      } catch (error) { warnings.push(`无法检查旧语音包：${String(error?.message ?? error)}`) }
      return { ...started, ok: true, route: id === 'voice-cloud' ? 'cloud' : 'local', ...(warnings.length ? { warning: warnings.join('；') } : {}) }
    }) },
    async rules() {
      refreshVoice()
      const ttsCharactersByRoute = { local: [], cloud: [] }, ttsCharacterErrorsByRoute = {}
      for (const route of ['local', 'cloud']) {
        try { ttsCharactersByRoute[route] = voiceCharacters([`voice-${route}`]) }
        catch (error) { ttsCharacterErrorsByRoute[route] = String(error?.message ?? error) }
      }
      const selectedRoute = voice.tts?.route === 'cloud' ? 'cloud' : 'local'
      const savedSelections = voice.tts?.routeVoiceSelections
      const ttsCharacterByRoute = Object.fromEntries(['local', 'cloud'].map(route => [route, typeof savedSelections?.[route]?.character === 'string' ? savedSelections[route].character : '']))
      ttsCharacterByRoute[selectedRoute] = typeof voice.tts?.character === 'string' ? voice.tts.character : ''
      return { ok: true, enabled: voice.enabled === true, triggerWho: voice.trigger?.who || 'owner', members: voice.trigger?.members ?? [], groups: voice.trigger?.groups ?? [], maxPerMinute: voice.maxPerMinute ?? 2, maxPerHour: voice.maxPerHour ?? 10, maxSeconds: voice.maxSeconds ?? 300, maxBytes: voice.maxBytes ?? 20 * 1024 * 1024,
      defaultVolume: voice.defaultVolume ?? 1, loudness: voice.loudness ?? 'normal', autoReadback: voice.autoReadback !== false, ffmpegPath: voice.ffmpegPath ?? '', ffprobePath: voice.ffprobePath ?? '',
      ttsTimeoutMs: voice.tts?.timeoutMs ?? 60000, ttsMaxChars: voice.tts?.maxChars ?? 120, ttsCharacter: voice.tts?.character ?? '', ttsCharacterByRoute, ttsCharacterSavedByRoute: { ...ttsCharacterByRoute }, ttsCharacters: [...new Set([...ttsCharactersByRoute.local, ...ttsCharactersByRoute.cloud])], ttsCharactersByRoute, ttsCharacterErrorsByRoute, ttsCacheVersion: voice.tts?.cacheVersion ?? 0,
      aiEnabled: voice.tts?.enabled === true, route: ['local', 'cloud'].includes(voice.tts?.route) ? voice.tts.route : 'local',
      endpoints: { local: voice.tts?.endpoints?.local || voice.tts?.baseUrl || 'http://127.0.0.1:8765', cloud: voice.tts?.endpoints?.cloud || 'http://127.0.0.1:8767' },
      pricePerKChar: Number(voice.cloud?.pricePerKChar) || 0, monthlyQuota: Number(voice.cloud?.monthlyQuota) || 0 } },
    async selfCheck() {
      refreshVoice()
      const route = voice.tts?.route === 'cloud' ? 'cloud' : 'local'
      const endpoint = localEndpoint(voice.tts?.endpoints?.[route] || (route === 'local' ? voice.tts?.baseUrl : '') || (route === 'cloud' ? 'http://127.0.0.1:8767' : 'http://127.0.0.1:8765'))
      const stages = []
      try {
        const response = await fetchImpl(`${endpoint}/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
        const raw = await readVoiceResponse(response, 64 * 1024)
        let body = {}
        try { body = JSON.parse(raw.toString('utf8')) } catch {}
        stages.push({ id: 'service', label: '语音服务', ok: response.ok, detail: `HTTP ${response.status}${body?.engine ? ` · ${String(body.engine).slice(0, 80)}` : ''}` })
      } catch (error) { stages.push({ id: 'service', label: '语音服务', ok: false, detail: String(error?.message ?? error).slice(0, 160) }) }
      try {
        const started = Date.now()
        if (voice.tts?.enabled !== true) throw new Error('语音合成未开启')
        const endpoints = { local: localEndpoint(voice.tts?.endpoints?.local || voice.tts?.baseUrl || 'http://127.0.0.1:8765'), cloud: localEndpoint(voice.tts?.endpoints?.cloud || 'http://127.0.0.1:8767') }
        const sample = '语音自检'.slice(0, Math.max(1, Math.floor(maxSynthesisChars())))
        let used = route, savedFallbackVoice = false
        try { await synthesize({ text: sample, baseUrl: endpoint, cacheVersion: `self-check-${randomUUID()}` }) }
        catch (error) {
          const fallback = pickFallbackRoute(route, endpoints, classifyVoiceError(error?.message ?? error).code)
          if (!fallback) throw error
          try {
            const target = switchVoiceRoute(voice.tts ?? {}, fallback)
            await synthesize({ text: sample, baseUrl: endpoints[fallback], cacheVersion: `self-check-${randomUUID()}` }, { routeVoice: fallback })
            savedFallbackVoice = !!(target.character || target.voice); used = fallback
          }
          catch (second) { throw new Error(`${String(second?.message ?? second)}（主路 ${route} 也失败：${String(error?.message ?? error).slice(0, 160)}）`) }
        }
        stages.push({ id: 'synthesis', label: '语音合成', ok: true, detail: `${used === route ? `线路 ${route}` : `已换路 ${route}→${used}，使用备用线路${savedFallbackVoice ? '已保存音色' : '默认音色'}`} · 成功（${Date.now() - started} ms）` })
      } catch (error) {
        const info = classifyVoiceError(error?.message ?? error)
        stages.push({ id: 'synthesis', label: '语音合成', ok: false, code: info.code, hint: info.hint, detail: String(error?.message ?? error).slice(0, 220) })
      }
      const settings = voiceSettings()
      if (settings.normalize || Math.abs(settings.defaultVolume - 1) > 1e-9 || settings.ffmpegPath) {
        const missing = []
        for (const [label, tool] of [
          ['ffprobe', settings.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe'],
          ['ffmpeg', resolveFfmpeg({ ffmpegPath: settings.ffmpegPath || null })],
        ]) {
          const result = spawnSync(tool, ['-version'], { stdio: 'ignore', timeout: 3000, windowsHide: true })
          if (result.error || result.status !== 0) missing.push(label)
        }
        stages.push({ id: 'audio-tools', label: '音频工具', ok: missing.length === 0,
          detail: missing.length ? `缺少 ${missing.join('、')}：音量处理与时长校验不可用，请安装或指定路径` : 'ffmpeg 与 ffprobe 可用' })
      }
      const enabled = voice.enabled === true && voice.tts?.enabled === true
      let readiness
      try { readiness = await checkSendReadiness() } catch { readiness = { ok: false, error: 'QQ 桥接状态不可用' } }
      const ready = enabled && readiness?.ok === true && readiness.toolEnabled === true && readiness.connected === true
      const detail = !enabled ? '语音或合成开关未开启' : readiness?.ok !== true ? String(readiness?.error || 'QQ 桥接状态不可用') : readiness.toolEnabled !== true ? 'QQ 发语音工具未开启' : readiness.connected !== true ? 'QQ 桥接接收连接未就绪' : '语音与工具已开启，QQ 桥接接收连接正常；未实际发送消息'
      stages.push({ id: 'send-prerequisites', label: '发送配置', ok: ready, detail })
      return { ok: true, healthy: stages.every(stage => stage.ok), stages }
    },
    async saveRules(input) {
      const endpoints = {}
      const triggerLists = {}
      for (const key of ['members', 'groups']) if (input[key] !== undefined) {
        const label = key === 'groups' ? '群号' : 'QQ 号'
        if (!Array.isArray(input[key]) || input[key].some(id => !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) || !/^\d{1,24}$/.test(String(id)))) throw new Error(`${label}名单中有无效号码`)
        triggerLists[key] = [...new Set(input[key].map(String))]
        if (triggerLists[key].length > 500) throw new Error(`${label}名单最多 500 个号码`)
      }
      for (const [key, max] of [['maxPerMinute', 60], ['maxPerHour', 600]]) if (input[key] !== undefined) {
        const value = input[key]
        if (!((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > max) throw new Error(`${key === 'maxPerMinute' ? '每分钟' : '每小时'}上限无效（${key}），请输入 0 至 ${max} 的整数`)
      }
      for (const [key, label] of [['pricePerKChar', '每千字单价'], ['monthlyQuota', '每月额度']]) if (input[key] !== undefined) {
        const value = input[key]
        const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
        const number = Number(value)
        if (!validType || !Number.isFinite(number) || number < 0 || (key === 'monthlyQuota' && !Number.isSafeInteger(number))) throw new Error(`${label}无效，请输入非负${key === 'monthlyQuota' ? '整数' : '数值'}`)
      }
      for (const key of ['maxSeconds', 'maxBytes']) if (input[key] !== undefined && (!Number.isSafeInteger(Number(input[key])) || Number(input[key]) <= 0)) throw new Error(`${key} must be a positive integer`)
      if (input.defaultVolume !== undefined && (!Number.isFinite(Number(input.defaultVolume)) || Number(input.defaultVolume) < 0.1 || Number(input.defaultVolume) > 4)) throw new Error('defaultVolume must be between 0.1 and 4')
      if (input.loudness !== undefined && !(['quiet', 'normal', 'loud'].includes(input.loudness) || (typeof input.loudness === 'number' && Number.isFinite(input.loudness) && input.loudness >= -40 && input.loudness <= -5))) throw new Error('Invalid loudness')
      for (const [key, min, max] of [['ttsTimeoutMs', 1, 120000], ['ttsMaxChars', 1, Number.MAX_SAFE_INTEGER], ['ttsCacheVersion', 0, Number.MAX_SAFE_INTEGER]]) {
        if (input[key] !== undefined && (!((typeof input[key] === 'number' && Number.isSafeInteger(input[key])) || (typeof input[key] === 'string' && /^\d+$/.test(input[key]))) || !Number.isSafeInteger(Number(input[key])) || Number(input[key]) < min || Number(input[key]) > max)) throw new Error(`Invalid ${key}`)
      }
      if (input.ttsCharacter !== undefined && (typeof input.ttsCharacter !== 'string' || input.ttsCharacter.length > 100)) throw new Error('Invalid ttsCharacter')
      if (input.allowUnverifiedCharacter !== undefined && typeof input.allowUnverifiedCharacter !== 'boolean') throw new Error('Invalid allowUnverifiedCharacter')
      for (const key of ['ffmpegPath', 'ffprobePath']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].includes('\0') || input[key].length > 4096)) throw new Error(`Invalid ${key}`)
      if (input.endpoints !== undefined) {
        if (!input.endpoints || typeof input.endpoints !== 'object' || Array.isArray(input.endpoints)) throw new Error('Invalid voice endpoints')
        for (const key of ['local', 'cloud']) if (input.endpoints[key] !== undefined) endpoints[key] = localEndpoint(input.endpoints[key])
      }
      const disk = readDiskConfig(), voice = structuredClone(disk.voice ?? {})
      const oldTts = voice.tts ?? {}, oldRoute = oldTts.route === 'cloud' ? 'cloud' : 'local'
      const route = ['local', 'cloud'].includes(input.route) ? input.route : oldRoute
      const routeTts = switchVoiceRoute(oldTts, route)
      const endpointFor = (which, saved, changed = {}) => changed[which] || saved.endpoints?.[which] || (which === 'local' ? saved.baseUrl : '') || (which === 'cloud' ? 'http://127.0.0.1:8767' : 'http://127.0.0.1:8765')
      const endpoint = localEndpoint(endpointFor(route, oldTts, endpoints))
      const oldEndpoint = localEndpoint(endpointFor(oldRoute, oldTts))
      const name = String(input.ttsCharacter ?? routeTts.character ?? '').trim()
      const changed = name !== String(oldTts.character ?? '').trim() || route !== oldRoute || endpoint !== oldEndpoint
      const manifest = (Array.isArray(disk.voicePacks?.manifests) ? disk.voicePacks.manifests : []).findLast(item => item?.id === `voice-${route}`)
      const packPort = Number(manifest?.port) || (route === 'cloud' ? 8767 : 8765)
      if (name && changed && input.allowUnverifiedCharacter !== true && Number(new URL(endpoint).port) === packPort) {
        const names = voiceCharacters([`voice-${route}`])
        if (names.length && !names.includes(name)) {
          const hint = /-(gsv|cloud)$|^huayan$/i.test(name) ? `「${name}」是音色 ID，映射名可用：${names.join('、')}` : `映射名「${name}」不存在；可用映射名：${names.join('、')}`
          throw new Error(hint)
        }
      }
      if (typeof input.enabled === 'boolean') voice.enabled = input.enabled
      voice.trigger = { ...(voice.trigger ?? {}) }
      if (['owner', 'anyone', 'list'].includes(input.triggerWho)) voice.trigger.who = input.triggerWho
      for (const key of ['members', 'groups']) if (triggerLists[key]) voice.trigger[key] = triggerLists[key]
      if (input.maxPerMinute !== undefined) voice.maxPerMinute = Number(input.maxPerMinute)
      if (input.maxPerHour !== undefined) voice.maxPerHour = Number(input.maxPerHour)
      for (const key of ['maxSeconds', 'maxBytes']) if (input[key] !== undefined) {
        voice[key] = Number(input[key])
      }
      if (input.defaultVolume !== undefined) voice.defaultVolume = Number(input.defaultVolume)
      if (input.loudness !== undefined) voice.loudness = input.loudness
      if (typeof input.autoReadback === 'boolean') voice.autoReadback = input.autoReadback
      if (input.ffmpegPath !== undefined) voice.ffmpegPath = input.ffmpegPath.trim()
      if (input.ffprobePath !== undefined) voice.ffprobePath = input.ffprobePath.trim()
      voice.tts = routeTts
      for (const [field, target] of [['ttsTimeoutMs', 'timeoutMs'], ['ttsMaxChars', 'maxChars'], ['ttsCacheVersion', 'cacheVersion']]) if (input[field] !== undefined) voice.tts[target] = Number(input[field])
      if (input.ttsCharacter !== undefined) voice.tts.character = input.ttsCharacter.trim()
      if (Object.keys(endpoints).length) voice.tts.endpoints = { ...(voice.tts.endpoints ?? {}), ...endpoints }
      if (typeof input.aiEnabled === 'boolean') voice.tts.enabled = input.aiEnabled
      if (['local', 'cloud'].includes(input.route)) voice.tts.route = input.route
      voice.cloud = { ...(voice.cloud ?? {}) }
      if (input.pricePerKChar !== undefined) voice.cloud.pricePerKChar = Number(input.pricePerKChar)
      if (input.monthlyQuota !== undefined) voice.cloud.monthlyQuota = Number(input.monthlyQuota)
      persist(voice, disk)
      return { ok: true }
    },
    synthesize,
    preview,
    async previewAudio(id, text) {
      const result = await preview(id, text)
      const stat = lstatSync(result.path)
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('试听音频无效或过大')
      return readFileSync(result.path)
    },
    dispose() {
      if (!disposePromise) {
        closing = true
        shutdown.abort(new Error('语音插件已关闭'))
        cancelStarts()
        disposePromise = (async () => {
          const failures = []
          const attempt = async fn => { try { await fn() } catch (error) { failures.push(String(error?.message ?? error)) } }
          await attempt(() => operations)
          await attempt(() => installer.stopAll())
          await attempt(() => packs.stopImports?.())
          await Promise.allSettled([...syntheses, ...packTests, ...librarySends])
          cleanupPending()
          await attempt(async () => { failures.push(...stopErrors(await packs.stopOwned())) })
          if (failures.length) throw new Error(`语音插件清理失败：${failures.join('；')}`)
        })()
      }
      return disposePromise
    },
    packs,
  }
}
