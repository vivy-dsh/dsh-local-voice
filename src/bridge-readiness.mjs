import { readFileSync } from 'node:fs'
import { request } from 'node:http'

/** Read only the already-running loopback bridge; never start it or send a QQ message. */
export function createVoiceBridgeReadiness({ qqConfigFile, tokenFile, timeoutMs = 3000 }) {
  return async () => {
    let config = {}
    try { config = JSON.parse(readFileSync(qqConfigFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') return { ok: false, error: 'QQ 桥接配置无效' } }
    let token = String(config.consoleToken || '').trim()
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) { try { token = readFileSync(tokenFile, 'utf8').trim() } catch { token = '' } }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return { ok: false, error: 'QQ 桥接令牌不可用' }
    const port = Number(config.consolePort || 3100)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'QQ 桥接端口无效' }
    return new Promise(resolve => {
      let settled = false
      const finish = value => { if (!settled) { settled = true; resolve(value) } }
      const req = request({ hostname: '127.0.0.1', port, method: 'GET', path: '/api/voice/readiness', headers: { 'x-console-token': token } }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy() })
        res.on('end', () => {
          try {
            const data = JSON.parse(text)
            if (res.statusCode < 200 || res.statusCode >= 300 || data.ok !== true || typeof data.toolEnabled !== 'boolean' || typeof data.connected !== 'boolean') throw new Error('invalid')
            finish({ ok: true, toolEnabled: data.toolEnabled, connected: data.connected })
          } catch { finish({ ok: false, error: 'QQ 桥接状态不可用' }) }
        })
        res.on('error', () => finish({ ok: false, error: 'QQ 桥接状态不可用' }))
      })
      req.setTimeout(timeoutMs, () => {
        const error = new Error('QQ 桥接检查超时')
        error.code = 'voice.bridge-timeout'
        req.destroy(error)
      })
      req.on('error', error => finish({ ok: false, error: error?.code === 'voice.bridge-timeout' ? 'QQ 桥接检查超时' : 'QQ 桥接未运行或不可访问' }))
      req.end()
    })
  }
}

/** Probe only the existing QQ bridge; never start it or transmit audio. */
export function createVoiceLibraryProbe({ qqConfigFile, tokenFile, timeoutMs = 120000 }) {
  return ({ offset = 0 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('语音库页码无效')
    return voiceBridgeRequest({ qqConfigFile, tokenFile, timeoutMs, path: `/api/voice/list?probe=1${offset ? `&offset=${offset}` : ''}` }).then(data => {
    if (!Array.isArray(data.voices)) throw new Error('QQ 桥接返回的语音库无效')
    return data
    })
  }
}

export function createVoiceLibrarySender({ qqConfigFile, tokenFile, timeoutMs = 120000 }) {
  return body => voiceBridgeRequest({ qqConfigFile, tokenFile, timeoutMs, path: '/api/voice/send', body })
}

async function voiceBridgeRequest({ qqConfigFile, tokenFile, timeoutMs, path, body }) {
    let config = {}
    try { config = JSON.parse(readFileSync(qqConfigFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw new Error('QQ 桥接配置无效') }
    let token = String(config.consoleToken || '').trim()
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) { try { token = readFileSync(tokenFile, 'utf8').trim() } catch { token = '' } }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('QQ 桥接令牌不可用')
    const port = Number(config.consolePort || 3100)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QQ 桥接端口无效')
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body)
      const req = request({ hostname: '127.0.0.1', port, method: payload === null ? 'GET' : 'POST', path, headers: { 'x-console-token': token, ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('QQ 桥接响应过大')) })
        res.on('end', () => {
          try {
            const data = JSON.parse(text)
            if (res.statusCode < 200 || res.statusCode >= 300 || data.ok !== true) throw new Error(String(data.error || 'QQ 桥接检查失败'))
            resolve(data)
          } catch (error) { reject(error) }
        })
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('QQ 桥接检查超时')))
      req.on('error', reject)
      req.end(payload)
    })
}
