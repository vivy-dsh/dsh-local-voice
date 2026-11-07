import { spawn } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'

const prefix = '/dsh-voice/api'

export async function openSampleLocation(file, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!isAbsolute(file)) throw new Error('参考音频路径无效')
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/select,', file] : platform === 'darwin' ? ['-R', file] : [dirname(file)]
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 512 * 1024) throw new Error('请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function registerVoiceHttp(ctx, service, { openSample = openSampleLocation, chooseDirectory = async () => { throw new Error('当前系统请手动填写导入目录') } } = {}) {
  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    const fail = (status, code, error, hint) => send(res, status, { ok: false, code, error, hint })
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(String(req.headers.host ?? '').toLowerCase())) return fail(403, 'HOST_REJECTED', '只接受本机访问', '使用本地 DSH 面板打开语音插件')
    if (req.method !== 'GET' && req.headers.origin) {
      let same = false
      try { same = new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase() } catch {}
      if (!same) return fail(403, 'ORIGIN_REJECTED', '跨站请求被拒绝', '在 DSH 面板内重试')
    }
    const conn = ctx.get('connection')
    if (!conn || typeof conn.requestRejection !== 'function') return fail(503, 'AUTH_UNAVAILABLE', '会话验证不可用', '检查 DSH 连接服务')
    const rejection = conn.requestRejection(req)
    if (rejection !== undefined && rejection !== null && rejection !== false) return fail(typeof rejection === 'number' ? rejection : 403, 'AUTH_REJECTED', '会话未通过验证', '重新打开本地面板链接')
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/packs`) return send(res, 200, await service.list())
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/rules`) return send(res, 200, await service.rules())
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/library`) {
        const raw = url.searchParams.get('offset')
        if (raw !== null && !/^\d+$/.test(raw)) throw new Error('语音库页码无效')
        return send(res, 200, await service.library({ offset: raw === null ? 0 : Number(raw) }))
      }
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/packs/cloud-config`) return send(res, 200, await service.readCloudConfig(String(url.searchParams.get('id') || 'voice-cloud')))
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/packs/cloud-stats`) return send(res, 200, await service.readCloudStats(String(url.searchParams.get('id') || 'voice-cloud')))
      if (req.method === 'GET' && url.pathname === `${prefix}/voice/packs/sample`) {
        const sample = await service.packs.sampleFile('voice-cloud')
        if (sample.buffer.length > 20 * 1024 * 1024) return fail(400, 'SAMPLE_TOO_LARGE', '参考音频过大', '检查语音包')
        const extension = /\.(wav|mp3|m4a)$/i.exec(sample.name)?.[1]?.toLowerCase() || 'wav'
        const contentType = extension === 'mp3' ? 'audio/mpeg' : extension === 'm4a' ? 'audio/mp4' : 'audio/wav'
        res.writeHead(200, { 'content-type': contentType, 'content-length': sample.buffer.length, 'content-disposition': `attachment; filename="voice-reference.${extension}"`, 'cache-control': 'no-store' })
        res.end(sample.buffer)
        return
      }
      if (req.method !== 'POST') return fail(404, 'NOT_FOUND', '未知接口', '刷新语音插件后重试')
      if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
      const body = await readBody(req)
      if (url.pathname === `${prefix}/voice/packs/choose-import`) return send(res, 200, await chooseDirectory())
      if (url.pathname === `${prefix}/voice/packs/sample-open`) {
        const sample = await service.packs.sampleFile('voice-cloud')
        await openSample(sample.file)
        return send(res, 200, { ok: true, message: '已打开参考音频所在位置' })
      }
      if (url.pathname === `${prefix}/voice/rules`) return send(res, 200, await service.saveRules(body))
      if (url.pathname === `${prefix}/voice/library/probe`) return send(res, 200, await service.probeLibrary({ offset: body.offset ?? 0 }))
      if (url.pathname === `${prefix}/voice/library/send`) return send(res, 200, await service.sendLibraryVoice(body))
      if (url.pathname === `${prefix}/voice/self-check`) return send(res, 200, await service.selfCheck())
      if (url.pathname === `${prefix}/voice/preview`) {
        const audio = await service.previewAudio(String(body.id || ''), body.text)
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' })
        res.end(audio)
        return
      }
      const action = url.pathname.slice(`${prefix}/voice/packs/`.length)
      const id = String(body.id || '')
      let result
      if (url.pathname === `${prefix}/voice/packs/import-inspect`) result = await service.packs.inspectImport(id, String(body.sourceDir || ''))
      else if (url.pathname === `${prefix}/voice/packs/install`) result = await service.install(id, { mirror: String(body.mirror || 'official') })
      else if (url.pathname === `${prefix}/voice/packs/install-cancel`) result = service.cancelInstall(id)
      else if (url.pathname === `${prefix}/voice/packs/import`) result = await service.importStart(id, { sourceDir: String(body.sourceDir || ''), allowUnverified: body.allowUnverified === true })
      else if (url.pathname === `${prefix}/voice/packs/import-cancel`) result = service.packs.cancelImport(id)
      else if (url.pathname === `${prefix}/voice/packs/import-delete-source`) result = await service.deleteImportSource(id, String(body.sourceDir || ''))
      else if (url.pathname === `${prefix}/voice/packs/import-delete-backup`) result = await service.deleteImportBackup(id, String(body.backupDir || ''))
      else if (url.pathname === `${prefix}/voice/packs/enable`) result = await service.setPackEnabled(id, body.enabled !== false)
      else if (url.pathname === `${prefix}/voice/packs/cloud-config`) result = await service.saveCloudConfig(id, body)
      else if (url.pathname === `${prefix}/voice/packs/test`) result = await service.testPack(id, { text: body.text })
      else if (url.pathname === `${prefix}/voice/packs/start`) result = await service.start(id)
      else if (url.pathname === `${prefix}/voice/packs/activate`) result = await service.activate(id)
      else if (url.pathname === `${prefix}/voice/packs/clean`) result = await service.cleanupInstall(id)
      else if (url.pathname === `${prefix}/voice/packs/archive`) result = await service.archive(id)
      else if (url.pathname === `${prefix}/voice/packs/restore`) result = await service.restore(id, String(body.name || ''))
      else if (url.pathname === `${prefix}/voice/packs/stop`) result = await service.stop(id)
      else return fail(404, 'NOT_FOUND', '未知接口', '刷新语音插件后重试')
      if (result?.ok === false) return fail(400, 'VOICE_OPERATION_FAILED', result.error || `${action} 失败`, result.hint || '检查语音包状态后重试')
      return send(res, 200, result)
    } catch (error) {
      return fail(400, String(error?.code || 'VOICE_OPERATION_FAILED'), String(error?.message ?? error), String(error?.hint || '检查语音包状态和设置后重试'))
    }
  } })
}
