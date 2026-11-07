import { registerComponentInternal } from '../../_shared/ipc.mjs'

export function registerVoiceInternal(ctx, home, service) {
  return registerComponentInternal(ctx, { home, name: 'voice', handle: async ({ method, path, query, body }) => {
    if (method === 'GET' && path === '/health') return { ok: true }
    if (method === 'POST' && path === '/synthesize') return { ok: true, ...await service.synthesize(body, { defaultVoice: body.useDefaultVoice === true, routeVoice: body.useRouteVoice }) }
    if (method === 'GET' && path === '/rules') return service.rules()
    if (method === 'GET' && path === '/packs') return service.launchStatus()
    if (method === 'POST' && path === '/prepare-send') return service.prepareSend(body)
    if (method === 'POST' && path === '/commit-send') return service.commitSend(body.token, body)
    if (method === 'POST' && path === '/abort-send') return service.abortSend(body.token)
    if (method === 'GET' && path === '/library/list') return service.library({ offset: Number(query?.get('offset') ?? 0) || 0 })
    if (method === 'POST' && path === '/library/list') return service.library({ offset: Number(body.offset ?? 0) || 0 })
    if (method === 'POST' && path === '/library/resolve') return service.resolveLibrary(body)
    if (method === 'POST' && path === '/library/probe') return service.probeLibrary({ offset: Number(body.offset ?? 0) || 0 })
    if (method === 'POST' && path === '/policy/trigger') return service.policy(body)
    if (method === 'POST' && path === '/audit/check') return service.auditCheck(body.subject, body.knownTokens)
    if (method === 'GET' && path === '/budget/status') return service.budgetStatus(query?.get('scopeKey') || query?.get('key') || '')
    if (method === 'POST' && path === '/budget/status') return service.budgetStatus(body.scopeKey || body.key || '')
    if (method === 'POST' && path === '/packs/activate') {
      if (!['voice-local', 'voice-cloud'].includes(body.id)) throw new Error('未知语音包')
      return service.activate(body.id)
    }
    if (method === 'POST' && path === '/packs/stop-owned') return service.stopOwned()
    throw new Error('Unknown voice component operation')
  } })
}
