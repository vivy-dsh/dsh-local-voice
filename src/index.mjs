import { join } from 'node:path'
import { createVoiceService } from './service.mjs'
import { registerVoiceHttp } from './http.mjs'
import { registerVoiceInternal } from './internal.mjs'
import { createVoiceBridgeReadiness, createVoiceLibrarySender } from './bridge-readiness.mjs'
import { createImportPicker } from './import-picker.mjs'
import { prepareStateDir, projectHome, resolveComponentPath } from '../../_shared/paths.mjs'

export const name = 'dsh-local-voice'
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const env = process.env
  const home = projectHome(env)
  const stateDir = prepareStateDir(resolveComponentPath(env, 'DSH_VOICE_STATE_DIR', join(home, 'voice'), { label: '语音状态目录' }), '语音状态目录')
  const bridgeConfig = {
    qqConfigFile: resolveComponentPath(env, 'SURFCORE_CONFIG_FILE', join(home, 'surfcore', 'config.json'), { label: 'QQ 桥接配置' }),
    tokenFile: resolveComponentPath(env, 'SURFCORE_CONSOLE_TOKEN_FILE', join(home, 'surfcore', 'state', 'console-token'), { label: 'QQ 桥接令牌' }),
  }
  const service = createVoiceService({ stateDir, checkSendReadiness: createVoiceBridgeReadiness(bridgeConfig), sendLibraryVoice: createVoiceLibrarySender(bridgeConfig) })
  const picker = createImportPicker({ stateDir })
  const dispose = registerVoiceHttp(ctx, service, { chooseDirectory: () => picker.choose() })
  let disposeInternal
  try { disposeInternal = registerVoiceInternal(ctx, home, service) } catch (error) { dispose(); throw error }
  ctx.inject(['orchestrator'], child => {
    // Runtime registers the orchestrator service before it constructs its voice host; one microtask sees it.
    const attach = () => {
      const host = child.orchestrator?.voice ?? null
      service.useEffectHost(host)
      // Sends are fail-closed: with no Effect host they are refused instead of delivered untraced, so say why once.
      if (!host) ctx.logger?.warn?.('语音插件未接入 orchestrator 的 Effect host，语音发送会被拒绝（fail-closed，不再直发）')
    }
    if (child.orchestrator?.voice) attach()
    else queueMicrotask(attach)
  })
  ctx.effect(() => async () => {
    disposeInternal(); dispose()
    const results = await Promise.allSettled([picker.dispose(), service.dispose()])
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  })
}

export default { name, inject, apply }
