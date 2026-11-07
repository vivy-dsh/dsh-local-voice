import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const VOICE_OWNER_WINDOW_MS = 10 * 60 * 1000
export const DEFAULT_VOICE_LIMITS = Object.freeze({ maxPerMinute: 2, maxPerHour: 10 })

// 与 SurfCore src/sensitive.js 保持同一启发式规则：路径 / 凭据赋值。
// 裸 32-hex 会话令牌匹配不到这里，必须由调用方传入 knownTokens 精确拦截。
export const SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i

function limit(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function normalizeVoiceLimits(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    maxPerMinute: limit(source.maxPerMinute, DEFAULT_VOICE_LIMITS.maxPerMinute),
    maxPerHour: limit(source.maxPerHour, DEFAULT_VOICE_LIMITS.maxPerHour),
  }
}

export function normalizeVoiceTrigger(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    who: ['owner', 'anyone', 'list'].includes(String(source.who)) ? String(source.who) : 'owner',
    members: Array.isArray(source.members) ? source.members.map(String) : [],
    groups: Array.isArray(source.groups) ? source.groups.map(String) : [],
  }
}

export function normalizeVoicePolicy(raw = {}, { ownerId = '' } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ownerId: String(ownerId ?? source.ownerId ?? ''),
    trigger: normalizeVoiceTrigger(source.trigger ?? source),
    limits: normalizeVoiceLimits(source),
  }
}

/**
 * 语音触发规则。返回 { ok, block }；block 为可展示给操作者的原因。
 *
 * 群聊只认时间窗口内的主人发言（或名单成员的最近发言），不要求最后一条消息来自主人；
 * 别人插话不会撤销授权，但一条主人/成员消息最多换一条语音。
 */
export function evaluateVoiceTrigger({
  key = '', kind = 'private', id = '', ownerId = '', trigger = {},
  lastSpeaker = null, ownerLastAt = 0, lastSentAt = 0,
  now = Date.now(), windowMs = VOICE_OWNER_WINDOW_MS,
} = {}) {
  const rules = normalizeVoiceTrigger(trigger)
  const target = String(id || key.replace(/^(?:group|private):/, ''))
  const block = message => ({ ok: false, block: message })

  if (kind === 'group' && rules.groups.length && !rules.groups.includes(target)) return block('这个群不在语音触发名单里')
  if (rules.who === 'anyone') return { ok: true, block: null }

  if (kind === 'private') {
    if (rules.who === 'owner' && String(target) !== String(ownerId ?? '')) return block('仅主人可触发语音（当前私聊对象不是主人）')
    if (rules.who === 'list' && !rules.members.includes(String(target)) && String(target) !== String(ownerId ?? '')) return block('该成员不在语音触发名单里')
    return { ok: true, block: null }
  }

  if (kind !== 'group') return block('未知会话类型')

  if (rules.who === 'list') {
    const speaker = lastSpeaker && typeof lastSpeaker === 'object' ? lastSpeaker : null
    const at = Number(speaker?.at ?? 0)
    const allowed = speaker?.isOwner === true || (speaker && rules.members.includes(String(speaker.userId ?? '')))
    if (!allowed) return block('该成员不在语音触发名单里')
    if (!at || now - at > windowMs) return block('最近没有允许的成员发言，不能触发语音')
    if (Number(lastSentAt) >= at) return block('这条消息已经发过语音了，等下一条消息')
    return { ok: true, block: null }
  }

  const ownerAt = Number(ownerLastAt) || 0
  if (!ownerAt) return block('仅主人可触发语音（这个群还没有主人发言记录）')
  if (now - ownerAt > windowMs) return block('最近 10 分钟主人都没说话，不能主动发语音')
  if (Number(lastSentAt) >= ownerAt) return block('这条消息已经发过语音了，等主人再说一句')
  return { ok: true, block: null }
}

function rateLimited(per, n) {
  const error = new Error(`语音发送频率超限（每${per}最多 ${n} 条），请稍后再试`)
  error.code = 'voice.rate-limited'
  error.stage = 'send'
  error.hint = '这是发送限流，不是 TTS 故障：等一会儿再发，或调大语音设置里的每分钟/每小时上限'
  return error
}

/** 只检查不记账：参数错误、审计拦截或网关失败都不该占额度。 */
export function voiceBudgetCheck(sentTimes = [], { maxPerMinute, maxPerHour, now = Date.now() } = {}) {
  const limits = normalizeVoiceLimits({ maxPerMinute, maxPerHour })
  const bucket = Array.isArray(sentTimes) ? sentTimes.map(Number).filter(Number.isFinite) : []
  const inMinute = bucket.filter(t => now - t < 60_000).length
  const inHour = bucket.filter(t => now - t < 3_600_000).length
  if (limits.maxPerMinute > 0 && inMinute + 1 > limits.maxPerMinute) throw rateLimited('分钟', limits.maxPerMinute)
  if (limits.maxPerHour > 0 && inHour + 1 > limits.maxPerHour) throw rateLimited('小时', limits.maxPerHour)
}

/** 真正发出后记账，同时裁掉一小时前的旧时间戳。 */
export function voiceBudgetCommit(sentTimes = [], at = Date.now()) {
  const bucket = (Array.isArray(sentTimes) ? sentTimes.map(Number).filter(Number.isFinite) : []).filter(t => at - t < 3_600_000)
  bucket.push(at)
  return bucket
}

/** 跨重启共享的限流账本；插件是唯一写入方。损坏时保留原文件并显式报错。 */
export function createVoiceLedger({ file, now = Date.now } = {}) {
  if (!file) throw new Error('Voice ledger file is required')
  function read() {
    if (!existsSync(file)) return { version: 1, scopes: {} }
    let data
    try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('语音发送账本损坏，原文件已保留') }
    if (!data || data.version !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('语音发送账本格式无效，原文件已保留')
    for (const value of Object.values(data.scopes)) {
      if (!Array.isArray(value) || value.some(t => !Number.isFinite(Number(t)))) throw new Error('语音发送账本格式无效，原文件已保留')
    }
    return data
  }
  function write(data) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(temp, file)
    } catch (error) { try { unlinkSync(temp) } catch {} throw error }
  }
  return {
    check(scopeKey, limits) {
      const data = read(), at = now()
      const bucket = (data.scopes[String(scopeKey)] ?? []).filter(t => at - Number(t) < 3_600_000)
      voiceBudgetCheck(bucket, { ...limits, now: at })
      return { ok: true, times: bucket }
    },
    commit(scopeKey, at = now()) {
      const data = read(), key = String(scopeKey)
      data.scopes[key] = voiceBudgetCommit(data.scopes[key] ?? [], at)
      for (const [scope, times] of Object.entries(data.scopes)) {
        const kept = times.filter(t => at - Number(t) < 3_600_000)
        if (kept.length) data.scopes[scope] = kept
        else delete data.scopes[scope]
      }
      write(data)
      return { ok: true, at }
    },
    snapshot(scopeKey) {
      const data = read(), at = now()
      const times = (data.scopes[String(scopeKey)] ?? []).filter(t => at - Number(t) < 3_600_000)
      return { ok: true, times, inMinute: times.filter(t => at - t < 60_000).length, inHour: times.length }
    },
  }
}

/** 出站语音的文件名审计：文件名会泄露路径、凭据与已知会话令牌。 */
export function assertOutboundAuditOk(subject, { sensitiveRe = SENSITIVE_RE, knownTokens = [], audit = true } = {}) {
  if (!audit) return
  const text = String(subject ?? '')
  const known = (Array.isArray(knownTokens) ? knownTokens : []).some(token => token && text.includes(String(token)))
  if (known || sensitiveRe.test(text)) {
    const error = new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发')
    error.code = 'voice.audit-blocked'
    error.stage = 'audit'
    throw error
  }
}
