/**
 * Voice settings — browser half of dsh-local-voice.
 *
 * One `settings.section` page owns the whole voice surface: ASR configuration
 * and runtime, TTS configuration, voice packs, the audio library, cloud
 * credentials and diagnostics. The host halves of dsh-local-asr and
 * dsh-local-voice stay the source of truth; this page talks to their public
 * HTTP surfaces only.
 *
 * Drafts and operational state live in the apply-scope store because the
 * settings shell unmounts inactive sections.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-voice',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useSyncExternalStore } = React

    const ASR_API = '/dsh-asr/api'
    const VOICE_API = '/dsh-voice/api'
    const LANGUAGES = [['auto', '自动'], ['zh', '中文'], ['en', '英文'], ['yue', '粤语'], ['ja', '日语'], ['ko', '韩语']]
    const PRECISIONS = [['int8', 'int8（约 228MiB）'], ['fp32', 'fp32（约 894MiB）']]
    const TRIGGER_WHO = [['owner', '主人'], ['anyone', '所有人'], ['list', '名单']]
    const TABS = [['overview', '总览'], ['asr', '识别'], ['tts', '合成'], ['packs', '语音包'], ['library', '语音库'], ['test', '测试']]
    const MAX_PREVIEW_CHARS = 500

    const CSS = `
.vc-section{--vc-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--vc-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.4));--vc-brand:var(--dsw-alias-brand-primary,#2f6fed);--vc-ok:var(--dsw-alias-state-success-primary,#1a7f4b);--vc-warn:var(--dsw-alias-state-warn-primary,#a86a00);--vc-bad:var(--dsw-alias-state-error-primary,#c43b3b);--vc-fg:var(--dsw-alias-label-primary,#1f2329);--vc-fg2:var(--dsw-alias-label-secondary,rgba(0,0,0,.64));--vc-fg3:var(--dsw-alias-label-tertiary,rgba(0,0,0,.46));--vc-bg:var(--dsw-alias-bg-base,#fff);--vc-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));--vc-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--vc-fg);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.vc-section *{box-sizing:border-box}
.vc-section h1,.vc-section h2,.vc-section h3,.vc-section p{margin:0}
.vc-section a{color:var(--vc-brand)}
.vc-section audio{width:100%;height:34px}
.vc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.vc-head-main{min-width:0}
.vc-title{margin:0;font-size:16px;line-height:24px;font-weight:600}
.vc-intro{margin:0;font-size:12.5px;line-height:20px;color:var(--vc-fg3)}
.vc-dots{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px 10px;padding-top:2px;max-width:55%}
.vc-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--vc-fg2);white-space:nowrap}
.vc-dot::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--vc-fg3);flex:none}
.vc-dot.ok::before{background:var(--vc-ok)}
.vc-dot.warn::before{background:var(--vc-warn)}
.vc-dot.bad::before{background:var(--vc-bad)}
.vc-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--vc-line);scrollbar-width:none}
.vc-tabs::-webkit-scrollbar{display:none}
.vc-tab{flex:none;appearance:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;margin:0;padding:8px 12px 6px;font:inherit;font-size:12.5px;font-weight:500;color:var(--vc-fg2);cursor:pointer}
.vc-tab:hover{background:var(--vc-bg2);color:var(--vc-fg)}
.vc-tab.on{color:var(--vc-brand);border-bottom-color:var(--vc-brand);font-weight:650}
.vc-tab:focus-visible{outline:2px solid var(--vc-brand);outline-offset:-2px}
.vc-grid{display:flex;flex-direction:column;gap:11px;min-width:0}
.vc-card{margin:0;padding:12px 14px 14px;border:1px solid var(--vc-line);border-radius:12px;background:var(--vc-bg1);min-width:0}
.vc-card-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:650;margin-bottom:5px}
.vc-card-note{margin-bottom:8px;font-size:12px;color:var(--vc-fg2);word-break:break-word}
.vc-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}
.vc-card-body>p{font-size:12px;color:var(--vc-fg2);word-break:break-word}
.vc-card-body>h3{font-size:12.5px;font-weight:650;margin-top:4px}
.vc-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:9px 11px;min-width:0}
.vc-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11.5px;color:var(--vc-fg3)}
.vc-field>span{overflow-wrap:anywhere}
.vc-section input[type=text],.vc-section input[type=number],.vc-section input[type=password],.vc-section input:not([type]),.vc-section select,.vc-section textarea{width:100%;min-width:0;font:inherit;font-size:12.5px;color:var(--vc-fg);background:var(--vc-bg);border:1px solid var(--vc-line-strong);border-radius:8px;padding:5px 8px;height:30px;outline:none}
.vc-section textarea{height:auto;min-height:68px;padding:7px 9px;resize:vertical;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.vc-section input:focus,.vc-section select:focus,.vc-section textarea:focus{border-color:var(--vc-brand);box-shadow:0 0 0 3px rgba(47,111,237,.16)}
.vc-section input:disabled,.vc-section select:disabled,.vc-section textarea:disabled{opacity:.55;cursor:not-allowed}
.vc-section input[type=checkbox]{accent-color:var(--vc-brand)}
.vc-check{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--vc-fg);cursor:pointer}
.vc-check input{width:15px;height:15px;margin:0;accent-color:var(--vc-brand);flex:none}
.vc-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;min-width:0}
.vc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.vc-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--vc-line-strong);background:var(--vc-bg);color:var(--vc-fg);font:inherit;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer}
.vc-btn:hover:not(:disabled){background:var(--vc-bg2)}
.vc-btn:disabled{opacity:.45;cursor:not-allowed}
.vc-btn.primary{background:var(--vc-brand);border-color:var(--vc-brand);color:#fff}
.vc-btn.primary:hover:not(:disabled){filter:brightness(1.07)}
.vc-btn.quiet{border-color:transparent;background:transparent;color:var(--vc-fg2)}
.vc-btn.danger{color:var(--vc-bad);border-color:rgba(196,59,59,.42);background:rgba(196,59,59,.07)}
.vc-btn.danger:hover:not(:disabled){background:rgba(196,59,59,.14);border-color:var(--vc-bad)}
.vc-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--vc-line-strong);font-size:11px;line-height:1.6;color:var(--vc-fg2);background:var(--vc-bg2);white-space:nowrap}
.vc-chip.ok{color:var(--vc-ok);border-color:rgba(26,127,75,.35);background:rgba(26,127,75,.1)}
.vc-chip.warn{color:var(--vc-warn);border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.1)}
.vc-chip.bad{color:var(--vc-bad);border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.1)}
.vc-chip.info{color:var(--vc-brand);border-color:rgba(47,111,237,.35);background:rgba(47,111,237,.1)}
.vc-hint{font-size:11.5px;line-height:17px;color:var(--vc-fg3);word-break:break-word}
.vc-alert{margin:0;padding:7px 10px;border-radius:8px;border:1px solid rgba(196,59,59,.35);background:rgba(196,59,59,.08);color:var(--vc-bad);font-size:12px;line-height:18px;word-break:break-word}
.vc-alert.warn{border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.08);color:var(--vc-warn)}
.vc-stage{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border:1px solid var(--vc-line);border-radius:9px;background:var(--vc-bg)}
.vc-stage-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;font-weight:600}
.vc-stage p{font-size:12px;color:var(--vc-fg2);word-break:break-word}
.vc-item{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:5px 0;border-bottom:1px dashed var(--vc-line);font-size:12px;color:var(--vc-fg2);word-break:break-word}
.vc-item:last-child{border-bottom:0;padding-bottom:0}
.vc-item>span:first-child{flex:0 0 auto;font-weight:600;color:var(--vc-fg)}
.vc-kv{display:grid;grid-template-columns:minmax(92px,auto) 1fr;gap:4px 12px;margin:0;font-size:12px}
.vc-kv dt{color:var(--vc-fg3)}
.vc-kv dd{margin:0;color:var(--vc-fg);word-break:break-all}
.vc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--vc-fg2);word-break:break-all}
.vc-meter{height:8px;border-radius:999px;background:var(--vc-bg2);overflow:hidden;border:1px solid var(--vc-line)}
.vc-meter>span{display:block;height:100%;background:var(--vc-brand);transition:width .2s}
.vc-meter>span.ok{background:var(--vc-ok)}
.vc-meter>span.warn{background:var(--vc-warn)}
.vc-meter>span.bad{background:var(--vc-bad)}
.vc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}
.vc-stat{padding:9px 11px;border:1px solid var(--vc-line);border-radius:10px;background:var(--vc-bg);min-width:0}
.vc-stat-value{display:block;font-size:22px;line-height:1.15;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;word-break:break-word}
.vc-stat-unit{margin-left:3px;font-size:11px;font-weight:500;color:var(--vc-fg3)}
.vc-stat-label{display:block;margin-top:2px;font-size:11px;color:var(--vc-fg3)}
.vc-stat.ok .vc-stat-value{color:var(--vc-ok)}
.vc-stat.warn .vc-stat-value{color:var(--vc-warn)}
.vc-stat.bad .vc-stat-value{color:var(--vc-bad)}
.vc-pack{padding:12px 13px;border:1px solid var(--vc-line);border-radius:11px;background:var(--vc-bg);display:flex;flex-direction:column;gap:6px;min-width:0}
.vc-pack+.vc-pack{margin-top:9px}
.vc-pack-head{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.vc-pack-head>strong{font-size:13.5px;font-weight:650;word-break:break-word}
.vc-pack p{font-size:12px;color:var(--vc-fg2);word-break:break-word}
.vc-pre{margin:0;padding:9px 11px;max-height:240px;overflow:auto;border:1px solid var(--vc-line);border-radius:9px;background:var(--vc-bg2);color:var(--vc-fg);font:11.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.vc-savebar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:9px;padding:9px 11px;border:1px solid var(--vc-line-strong);border-radius:10px;background:var(--vc-bg)}
.vc-dirty{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--vc-fg3)}
.vc-dirty::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--vc-ok);flex:none}
.vc-dirty.on{color:var(--vc-warn)}
.vc-dirty.on::before{background:var(--vc-warn)}
.vc-saved{font-size:11.5px;color:var(--vc-ok)}
.vc-loading{padding:12px 0;font-size:12px;color:var(--vc-fg3)}
.vc-empty{padding:12px;text-align:center;font-size:12px;color:var(--vc-fg3);border:1px dashed var(--vc-line-strong);border-radius:9px}
.vc-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;max-width:min(560px,92vw);padding:9px 14px;border-radius:10px;border:1px solid var(--vc-line-strong);background:var(--vc-bg);color:var(--vc-fg);font-size:12.5px;box-shadow:0 8px 28px rgba(16,24,40,.18)}
.vc-toast::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--vc-ok);flex:none}
@media(max-width:640px){.vc-fields{grid-template-columns:1fr}.vc-card{padding:11px 12px 13px}.vc-head{flex-direction:column}.vc-dots{max-width:100%;justify-content:flex-start}.vc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.vc-pack{padding:11px 12px}}
@media(prefers-reduced-motion:reduce){.vc-section *{transition:none!important}}
`

    // ── HTTP ──────────────────────────────────────────────────────────────

    async function call(prefix, path, body) {
      let response
      try {
        response = await fetch(`${prefix}${path}`, body === undefined
          ? { headers: { accept: 'application/json' } }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      } catch (error) {
        const wrapped = new Error(String(error?.message ?? error))
        wrapped.unreachable = true
        throw wrapped
      }
      let data = null
      try { data = await response.json() } catch { data = null }
      if (!response.ok || data?.ok === false) {
        const error = new Error([data?.error, data?.hint].filter(Boolean).join('：') || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return data
    }

    async function callAudio(id, text) {
      let response
      try {
        response = await fetch(`${VOICE_API}/voice/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, text }),
        })
      } catch (error) {
        const wrapped = new Error(String(error?.message ?? error))
        wrapped.unreachable = true
        throw wrapped
      }
      if (!response.ok) {
        let data = null
        try { data = await response.json() } catch { data = null }
        const error = new Error([data?.error, data?.hint].filter(Boolean).join('：') || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return response.blob()
    }

    // ── Conversions and validation ────────────────────────────────────────

    const messageOf = error => String(error?.message ?? error ?? '未知错误')
    const isBlank = value => value === '' || value === null || value === undefined
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
    const cx = (...parts) => parts.filter(Boolean).join(' ')
    const flatten = children => Array.isArray(children) ? children.flat(Infinity) : [children]
    const splitList = text => String(text ?? '').split(/[,，\s]+/).map(item => item.trim()).filter(Boolean)
    const splitLines = text => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    const isUnavailable = error => error?.unreachable === true || [401, 404, 503].includes(error?.status)

    function readInt(value, label, min, max = Number.MAX_SAFE_INTEGER) {
      if (isBlank(value)) return { error: `${label}不能为空` }
      const number = Number(value)
      if (!Number.isInteger(number) || number < min || number > max) {
        return { error: max === Number.MAX_SAFE_INTEGER ? `${label}需要不小于 ${min} 的整数` : `${label}需要 ${min} 至 ${max} 的整数` }
      }
      return { value: number }
    }

    function readNumber(value, label, min, max = Infinity) {
      if (isBlank(value)) return { error: `${label}不能为空` }
      const number = Number(value)
      if (!Number.isFinite(number) || number < min || number > max) {
        return { error: max === Infinity ? `${label}需要不小于 ${min} 的数值` : `${label}需要 ${min} 至 ${max} 的数值` }
      }
      return { value: number }
    }

    function firstError(...results) {
      return results.find(result => result?.error)
    }

    function asrDraftFrom(rules) {
      return {
        enabled: rules?.enabled !== false,
        engine: rules?.engine ?? 'sensevoice',
        language: rules?.ui?.language ?? 'auto',
        maxSeconds: rules?.limits?.maxSeconds ?? 120,
        maxBytesMiB: Math.round((rules?.limits?.maxBytes ?? 8388608) / 1048576),
        maxPerMinute: rules?.limits?.maxPerMinute ?? 6,
        maxPerHour: rules?.limits?.maxPerHour ?? 120,
        cacheEnabled: rules?.cache?.enabled !== false,
        maxEntries: rules?.cache?.maxEntries ?? 200,
        audit: rules?.audit !== false,
        precision: rules?.sensevoice?.precision ?? 'int8',
        threads: rules?.sensevoice?.threads ?? 2,
        segmentSeconds: rules?.sensevoice?.segmentSeconds ?? 30,
        vadThreshold: rules?.sensevoice?.vadThreshold ?? 0.5,
        idleTimeoutMs: rules?.sensevoice?.idleTimeoutMs ?? 600000,
        sourcesText: (rules?.sensevoice?.modelSources ?? []).join('\n'),
      }
    }

    function ttsDraftFrom(rules) {
      const characters = rules?.ttsCharacterByRoute ?? {}
      return {
        enabled: rules?.enabled === true,
        aiEnabled: rules?.aiEnabled === true,
        triggerWho: rules?.triggerWho ?? 'owner',
        membersText: (rules?.members ?? []).join(', '),
        groupsText: (rules?.groups ?? []).join(', '),
        route: rules?.route === 'cloud' ? 'cloud' : 'local',
        characters: { local: characters.local ?? '', cloud: characters.cloud ?? '' },
        endpoints: { local: rules?.endpoints?.local ?? '', cloud: rules?.endpoints?.cloud ?? '' },
        maxPerMinute: rules?.maxPerMinute ?? 2,
        maxPerHour: rules?.maxPerHour ?? 10,
        maxSeconds: rules?.maxSeconds ?? 300,
        maxBytes: rules?.maxBytes ?? 20971520,
        defaultVolume: rules?.defaultVolume ?? 1,
        loudness: String(rules?.loudness ?? 'normal'),
        autoReadback: rules?.autoReadback !== false,
        ttsTimeoutMs: rules?.ttsTimeoutMs ?? 60000,
        ttsMaxChars: rules?.ttsMaxChars ?? 120,
        ttsCacheVersion: rules?.ttsCacheVersion ?? 0,
        pricePerKChar: rules?.pricePerKChar ?? 0,
        monthlyQuota: rules?.monthlyQuota ?? 0,
        ffmpegPath: rules?.ffmpegPath ?? '',
        ffprobePath: rules?.ffprobePath ?? '',
        allowUnverifiedCharacter: false,
      }
    }

    function asrPayload(draft) {
      const maxSeconds = readInt(draft.maxSeconds, '单条最长秒数', 1)
      const maxBytesMiB = readInt(draft.maxBytesMiB, '单条最大 MiB', 1)
      const maxPerMinute = readInt(draft.maxPerMinute, '每分钟次数', 0)
      const maxPerHour = readInt(draft.maxPerHour, '每小时次数', 0)
      const maxEntries = readInt(draft.maxEntries, '缓存条数', 1)
      const threads = readInt(draft.threads, '线程数', 1)
      const segmentSeconds = readInt(draft.segmentSeconds, '最长切段秒数', 1)
      const idleTimeoutMs = readInt(draft.idleTimeoutMs, '空闲回收毫秒', 0)
      const vadThreshold = readNumber(draft.vadThreshold, 'VAD 阈值', 0, 1)
      const bad = firstError(maxSeconds, maxBytesMiB, maxPerMinute, maxPerHour, maxEntries, threads, segmentSeconds, idleTimeoutMs, vadThreshold)
      if (bad) return bad
      if (typeof draft.engine !== 'string' || draft.engine.trim() === '') return { error: '识别引擎不能为空' }
      if (!PRECISIONS.some(([value]) => value === draft.precision)) return { error: '模型精度无效' }
      const sources = splitLines(draft.sourcesText)
      return {
        value: {
          enabled: draft.enabled === true,
          engine: draft.engine.trim(),
          limits: {
            maxSeconds: maxSeconds.value,
            maxBytes: maxBytesMiB.value * 1048576,
            maxPerMinute: maxPerMinute.value,
            maxPerHour: maxPerHour.value,
          },
          cache: { enabled: draft.cacheEnabled === true, maxEntries: maxEntries.value },
          audit: draft.audit === true,
          sensevoice: {
            precision: draft.precision,
            threads: threads.value,
            segmentSeconds: segmentSeconds.value,
            vadThreshold: vadThreshold.value,
            idleTimeoutMs: idleTimeoutMs.value,
            modelSources: sources.length > 0 ? sources : null,
          },
          ui: { language: draft.language },
        },
      }
    }

    function ttsPayload(draft) {
      const maxPerMinute = readInt(draft.maxPerMinute, '每分钟上限', 0, 60)
      const maxPerHour = readInt(draft.maxPerHour, '每小时上限', 0, 600)
      const maxSeconds = readInt(draft.maxSeconds, '音频最长时长', 1)
      const maxBytes = readInt(draft.maxBytes, '音频最大大小', 1)
      const defaultVolume = readNumber(draft.defaultVolume, '默认音量', 0.1, 4)
      const ttsTimeoutMs = readInt(draft.ttsTimeoutMs, '合成超时', 1, 120000)
      const ttsMaxChars = readInt(draft.ttsMaxChars, '每次合成字数', 1)
      const ttsCacheVersion = readInt(draft.ttsCacheVersion, '音色缓存版本', 0)
      const pricePerKChar = readNumber(draft.pricePerKChar, '每千字单价', 0)
      const monthlyQuota = readInt(draft.monthlyQuota, '每月额度', 0)
      const bad = firstError(maxPerMinute, maxPerHour, maxSeconds, maxBytes, defaultVolume, ttsTimeoutMs, ttsMaxChars, ttsCacheVersion, pricePerKChar, monthlyQuota)
      if (bad) return bad
      const route = draft.route === 'cloud' ? 'cloud' : 'local'
      const loudness = String(draft.loudness ?? '').trim()
      const loud = /^-\d+(?:\.\d+)?$/.test(loudness) ? Number(loudness) : loudness
      if (!(['quiet', 'normal', 'loud'].includes(loud) || (typeof loud === 'number' && loud >= -40 && loud <= -5))) {
        return { error: '响度需要 quiet / normal / loud，或 -40 至 -5 之间的数值' }
      }
      const character = String(draft.characters?.[route] ?? '').trim()
      if (character.length > 100) return { error: '音色映射名最多 100 个字符' }
      const endpoints = { local: String(draft.endpoints?.local ?? '').trim(), cloud: String(draft.endpoints?.cloud ?? '').trim() }
      if (!endpoints.local || !endpoints.cloud) return { error: '两条线路的引擎地址都不能为空' }
      return {
        value: {
          enabled: draft.enabled === true,
          aiEnabled: draft.aiEnabled === true,
          triggerWho: draft.triggerWho,
          members: splitList(draft.membersText),
          groups: splitList(draft.groupsText),
          route,
          ttsCharacter: character,
          endpoints,
          maxPerMinute: maxPerMinute.value,
          maxPerHour: maxPerHour.value,
          maxSeconds: maxSeconds.value,
          maxBytes: maxBytes.value,
          defaultVolume: defaultVolume.value,
          loudness: loud,
          autoReadback: draft.autoReadback === true,
          ttsTimeoutMs: ttsTimeoutMs.value,
          ttsMaxChars: ttsMaxChars.value,
          ttsCacheVersion: ttsCacheVersion.value,
          pricePerKChar: pricePerKChar.value,
          monthlyQuota: monthlyQuota.value,
          ffmpegPath: String(draft.ffmpegPath ?? '').trim(),
          ffprobePath: String(draft.ffprobePath ?? '').trim(),
          allowUnverifiedCharacter: draft.allowUnverifiedCharacter === true,
        },
      }
    }

    // ── Store ─────────────────────────────────────────────────────────────

    function createStore() {
      const asrSide = () => ({
        phase: 'idle', error: '', catalog: null, status: null, prepare: null, prepareError: '', prepareBusy: false,
        saved: null, draft: null, revision: 0, saving: false, saveError: '', savedMessage: '',
        check: null, checking: false, checkError: '',
      })
      const ttsSide = () => ({
        phase: 'idle', error: '', packs: [], installSupported: false, pickerSupported: false,
        cloud: null, cloudError: '',
        saved: null, draft: null, revision: 0, saving: false, saveError: '', savedMessage: '',
        check: null, checking: false, checkError: '',
        previewText: '你好，语音测试。', previewRoute: 'local', previewUrl: '', previewing: false, previewError: '',
      })
      const voiceSide = () => ({
        mirror: 'official', source: '', inspection: null, allowUnverified: false,
        credentials: { appId: '', accessKey: '', speaker: '' }, cloudConfig: null,
        library: null, libraryProbe: null,
        trialTarget: '', trialFile: '', trialDryRun: true, trialResult: null,
        trialKind: 'file', trialText: '', trialPath: '',
        testingPacks: [], startingPack: '', busy: false, opError: '', opErrorKey: '', message: '',
      })
      let state = Object.freeze({ tab: 'overview', asr: asrSide(), tts: ttsSide(), voice: voiceSide() })
      const listeners = new Set()
      const intervals = new Set()
      let started = false
      let prepareTimer = null
      let messageTimer = null

      const publish = next => {
        state = Object.freeze(next)
        for (const listener of [...listeners]) listener()
      }
      const patch = (side, changes) => publish({ ...state, [side]: { ...state[side], ...changes } })

      const subscribe = listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const getSnapshot = () => state

      function setTab(tab) {
        publish({ ...state, tab: TABS.some(([id]) => id === tab) ? tab : 'overview' })
        if (typeof document !== 'undefined') {
          const pane = document.getElementById('voice-settings-tab')
          if (pane) pane.scrollTop = 0
        }
      }

      function notify(message) {
        if (messageTimer !== null) { clearTimeout(messageTimer); messageTimer = null }
        if (message) messageTimer = setTimeout(() => { messageTimer = null; patch('voice', { message: '' }) }, 4500)
        patch('voice', { message: message ?? '' })
      }

      function reportOperationError(key, error) {
        patch('voice', { opErrorKey: key, opError: messageOf(error) })
      }

      function clearOperationError(key) {
        if (!state.voice.opErrorKey || state.voice.opErrorKey === key) patch('voice', { opError: '', opErrorKey: '' })
      }

      // ── ASR ─────────────────────────────────────────────────────────────

      async function loadAsrMeta() {
        try {
          const [status, catalog, prepare] = await Promise.all([
            call(ASR_API, '/asr/status'),
            call(ASR_API, '/asr/catalog'),
            call(ASR_API, '/asr/prepare'),
          ])
          patch('asr', { status, catalog, prepare, prepareError: '' })
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('dsh-local-voice: ASR status refresh failed', error)
        }
      }

      async function loadAsr() {
        if (state.asr.phase === 'loading') return
        patch('asr', { phase: 'loading', error: '' })
        try {
          const [rules, status, catalog, prepare] = await Promise.all([
            call(ASR_API, '/asr/rules'),
            call(ASR_API, '/asr/status'),
            call(ASR_API, '/asr/catalog'),
            call(ASR_API, '/asr/prepare'),
          ])
          patch('asr', {
            phase: 'ready', error: '', status, catalog, prepare,
            saved: rules, draft: asrDraftFrom(rules), revision: 0,
            saveError: '', savedMessage: '',
          })
          if (prepare?.active === true) schedulePreparePoll()
        } catch (error) {
          patch('asr', { phase: isUnavailable(error) ? 'unavailable' : 'error', error: messageOf(error), draft: null })
        }
      }

      function editAsr(changes) {
        const side = state.asr
        if (!side.draft) return
        patch('asr', { draft: { ...side.draft, ...changes }, revision: side.revision + 1, saveError: '', savedMessage: '' })
      }

      async function saveAsr() {
        const side = state.asr
        if (!side.draft || side.saving) return
        const payload = asrPayload(side.draft)
        if (payload.error) { patch('asr', { saveError: payload.error }); return }
        const revision = side.revision
        patch('asr', { saving: true, saveError: '', savedMessage: '' })
        try {
          await call(ASR_API, '/asr/rules', payload.value)
          const fresh = await call(ASR_API, '/asr/rules')
          const edited = state.asr.revision !== revision
          patch('asr', {
            saving: false, saved: fresh,
            draft: edited ? state.asr.draft : asrDraftFrom(fresh),
            savedMessage: edited ? '已保存；保存期间的新修改尚未保存' : '已保存；已重新读取服务端配置',
          })
          if (!edited) void loadAsrMeta()
        } catch (error) {
          patch('asr', { saving: false, saveError: messageOf(error) })
        }
      }

      function discardAsr() {
        const side = state.asr
        if (!side.saved) return
        patch('asr', { draft: asrDraftFrom(side.saved), revision: side.revision + 1, saveError: '', savedMessage: '' })
      }

      async function runAsrCheck() {
        if (state.asr.checking) return
        patch('asr', { checking: true, checkError: '' })
        try {
          const check = await call(ASR_API, '/asr/self-check', {})
          patch('asr', { checking: false, check })
        } catch (error) {
          patch('asr', { checking: false, checkError: messageOf(error) })
        }
      }

      async function startPrepare() {
        if (state.asr.prepareBusy || state.asr.prepare?.active === true) return
        patch('asr', { prepareBusy: true, prepareError: '' })
        try {
          const prepare = await call(ASR_API, '/asr/prepare', {})
          patch('asr', { prepare })
          if (prepare?.active === true) schedulePreparePoll()
        } catch (error) {
          patch('asr', { prepareError: messageOf(error) })
        } finally {
          patch('asr', { prepareBusy: false })
        }
      }

      async function cancelPrepare() {
        if (state.asr.prepareBusy) return
        patch('asr', { prepareBusy: true, prepareError: '' })
        try {
          const prepare = await call(ASR_API, '/asr/prepare-cancel', {})
          patch('asr', { prepare })
        } catch (error) {
          patch('asr', { prepareError: messageOf(error) })
        } finally {
          patch('asr', { prepareBusy: false })
        }
      }

      function schedulePreparePoll() {
        if (prepareTimer !== null) return
        prepareTimer = setInterval(async () => {
          try {
            const prepare = await call(ASR_API, '/asr/prepare')
            patch('asr', { prepare, prepareError: '' })
            if (prepare?.active !== true) {
              clearInterval(prepareTimer)
              prepareTimer = null
              void loadAsrMeta()
            }
          } catch (error) {
            clearInterval(prepareTimer)
            prepareTimer = null
            patch('asr', { prepareError: messageOf(error) })
          }
        }, 1500)
      }

      // ── TTS rules ───────────────────────────────────────────────────────

      async function loadCloudStats() {
        try {
          const cloud = await call(VOICE_API, '/voice/packs/cloud-stats?id=voice-cloud')
          patch('tts', { cloud, cloudError: '' })
        } catch (error) {
          patch('tts', { cloud: null, cloudError: messageOf(error) })
        }
      }

      async function refreshPacks() {
        try {
          const list = await call(VOICE_API, '/voice/packs')
          const packs = Array.isArray(list?.packs) ? list.packs : []
          patch('tts', {
            packs,
            installSupported: list?.onlineInstallSupported === true,
            pickerSupported: list?.directoryPickerSupported === true,
          })
          clearOperationError('refresh')
        } catch (error) {
          reportOperationError('refresh', error)
        }
      }

      async function loadTts() {
        if (state.tts.phase === 'loading') return
        patch('tts', { phase: 'loading', error: '' })
        try {
          const [rules, list] = await Promise.all([call(VOICE_API, '/voice/rules'), call(VOICE_API, '/voice/packs')])
          const packs = Array.isArray(list?.packs) ? list.packs : []
          patch('tts', {
            phase: 'ready', error: '', packs,
            installSupported: list?.onlineInstallSupported === true,
            pickerSupported: list?.directoryPickerSupported === true,
            saved: rules, draft: ttsDraftFrom(rules), revision: 0,
            saveError: '', savedMessage: '',
          })
          if (packs.some(pack => pack.id === 'voice-cloud' && pack.installed)) void loadCloudStats()
        } catch (error) {
          patch('tts', { phase: isUnavailable(error) ? 'unavailable' : 'error', error: messageOf(error), draft: null })
        }
      }

      function editTts(changes) {
        const side = state.tts
        if (!side.draft) return
        patch('tts', { draft: { ...side.draft, ...changes }, revision: side.revision + 1, saveError: '', savedMessage: '' })
      }

      function editTtsCharacter(value) {
        const side = state.tts
        if (!side.draft) return
        const route = side.draft.route
        patch('tts', {
          draft: { ...side.draft, characters: { ...side.draft.characters, [route]: value } },
          revision: side.revision + 1, saveError: '', savedMessage: '',
        })
      }

      function editTtsRoute(route) {
        const side = state.tts
        if (!side.draft || !['local', 'cloud'].includes(route)) return
        patch('tts', { draft: { ...side.draft, route }, revision: side.revision + 1, saveError: '', savedMessage: '' })
      }

      async function saveTts() {
        const side = state.tts
        if (!side.draft || side.saving) return
        const payload = ttsPayload(side.draft)
        if (payload.error) { patch('tts', { saveError: payload.error }); return }
        const revision = side.revision
        const route = side.draft.route
        const other = route === 'cloud' ? 'local' : 'cloud'
        const serverChars = side.saved?.ttsCharacterByRoute ?? {}
        const otherDirty = String(side.draft.characters[other] ?? '') !== String(serverChars[other] ?? '')
        patch('tts', { saving: true, saveError: '', savedMessage: '' })
        try {
          await call(VOICE_API, '/voice/rules', payload.value)
          const fresh = await call(VOICE_API, '/voice/rules')
          const edited = state.tts.revision !== revision
          let nextDraft = ttsDraftFrom(fresh)
          if (otherDirty) nextDraft = { ...nextDraft, characters: { ...nextDraft.characters, [other]: state.tts.draft.characters[other] } }
          const message = edited ? '已保存；保存期间的新修改尚未保存'
            : otherDirty ? '当前线路已保存；另一线路的音色草稿仍未保存'
              : '已保存；已重新读取服务端配置'
          patch('tts', {
            saving: false, saved: fresh,
            draft: edited ? state.tts.draft : nextDraft,
            savedMessage: message,
          })
          if (!edited) await refreshPacks()
        } catch (error) {
          patch('tts', { saving: false, saveError: messageOf(error) })
        }
      }

      function discardTts() {
        const side = state.tts
        if (!side.saved) return
        patch('tts', { draft: ttsDraftFrom(side.saved), revision: side.revision + 1, saveError: '', savedMessage: '' })
      }

      async function runTtsCheck() {
        if (state.tts.checking) return
        patch('tts', { checking: true, checkError: '' })
        try {
          const check = await call(VOICE_API, '/voice/self-check', {})
          patch('tts', { checking: false, check })
        } catch (error) {
          patch('tts', { checking: false, checkError: messageOf(error) })
        }
      }

      function setPreviewText(text) {
        patch('tts', { previewText: text, previewError: '' })
      }

      function setPreviewRoute(route) {
        patch('tts', { previewRoute: route === 'cloud' ? 'cloud' : 'local', previewError: '' })
      }

      function usePreview(blob) {
        const url = URL.createObjectURL(blob)
        const previous = state.tts.previewUrl
        patch('tts', { previewing: false, previewUrl: url })
        if (previous) URL.revokeObjectURL(previous)
      }

      async function preview() {
        const side = state.tts
        if (side.previewing) return
        const text = String(side.previewText ?? '').trim()
        if (!text) { patch('tts', { previewError: '试听文本不能为空' }); return }
        if (text.length > MAX_PREVIEW_CHARS) { patch('tts', { previewError: `试听文本最多 ${MAX_PREVIEW_CHARS} 字` }); return }
        patch('tts', { previewing: true, previewError: '' })
        try {
          usePreview(await callAudio(`voice-${side.previewRoute}`, text))
        } catch (error) {
          patch('tts', { previewing: false, previewError: messageOf(error) })
        }
      }

      // ── Packs, library and cloud operations ─────────────────────────────

      async function voiceAction(path, body) {
        const testing = path === '/voice/packs/test'
        const stopping = path === '/voice/packs/stop'
        const starting = path === '/voice/packs/start' || path === '/voice/packs/activate'
        if (starting) patch('voice', { startingPack: body?.id ?? '' })
        if (testing) patch('voice', { testingPacks: [...state.voice.testingPacks, body.id] })
        else if (!stopping) patch('voice', { busy: true })
        notify('')
        try {
          const result = await call(VOICE_API, path, body)
          clearOperationError(path)
          if (path === '/voice/packs/import-inspect') {
            patch('voice', { inspection: { ...result, requestedId: body.id, requestedSource: body.sourceDir }, allowUnverified: false })
          }
          if (path === '/voice/packs/cloud-config') {
            patch('voice', { credentials: { appId: '', accessKey: '', speaker: '' }, cloudConfig: null })
          }
          notify(
            path === '/voice/packs/import-inspect'
              ? `${result.verified ? '完整性已验证' : '未提供完整性校验文件'} · ${result.sourceDir || ''} · ${result.warnings?.map(warning => warning.message).join('；') || ''}`
              : path === '/voice/packs/clean'
                ? result.backup ? `残留已移到项目内备份：installer-backups/${result.backup}` : '没有安装残留'
                : path === '/voice/packs/test'
                  ? `合成成功，耗时 ${result.ms} 毫秒，音频 ${result.seconds} 秒`
                  : result.warning ? `操作已提交；${result.warning}` : result.phase || '操作已提交',
          )
          await refreshPacks()
          return result
        } catch (error) {
          reportOperationError(path, error)
          return undefined
        } finally {
          if (starting) patch('voice', { startingPack: '' })
          if (testing) patch('voice', { testingPacks: state.voice.testingPacks.filter(id => id !== body.id) })
          else if (!stopping) patch('voice', { busy: false })
        }
      }

      async function previewPack(id) {
        if (state.voice.busy) return
        const text = String(state.tts.previewText ?? '').trim()
        if (!text) { notify('试听文本不能为空'); return }
        if (text.length > MAX_PREVIEW_CHARS) { notify(`试听文本最多 ${MAX_PREVIEW_CHARS} 字`); return }
        patch('voice', { busy: true })
        notify('')
        try {
          usePreview(await callAudio(id, text))
          clearOperationError('preview')
          notify('试听音频已生成')
        } catch (error) {
          reportOperationError('preview', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function deleteImportSource(pack) {
        if (!window.confirm(`删除导入源文件夹？\n\n${pack.importSource}\n\n此操作会永久删除该目录；请先确认已导入的语音包可以正常使用。`)) return
        await voiceAction('/voice/packs/import-delete-source', { id: pack.id, sourceDir: pack.importSource })
      }

      async function deleteImportBackup(pack) {
        if (!window.confirm(`删除旧包导入备份？\n\n${pack.backupDir}\n\n此操作会永久删除该备份；请先确认当前语音包可以正常使用。`)) return
        await voiceAction('/voice/packs/import-delete-backup', { id: pack.id, backupDir: pack.backupDir })
      }

      async function chooseImport() {
        const before = state.voice.source
        patch('voice', { busy: true })
        try {
          const result = await call(VOICE_API, '/voice/packs/choose-import', {})
          if (result.path) {
            patch('voice', {
              source: state.voice.source === before ? result.path : state.voice.source,
              inspection: null,
              allowUnverified: false,
            })
            notify('选择完成，请核对导入目录')
          } else if (result.cancelled) {
            notify('已取消选择目录')
          }
          clearOperationError('choose-import')
        } catch (error) {
          reportOperationError('choose-import', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function openSample() {
        patch('voice', { busy: true })
        try {
          const result = await call(VOICE_API, '/voice/packs/sample-open', {})
          clearOperationError('sample-open')
          notify(result.message || '已打开参考音频所在位置')
        } catch (error) {
          reportOperationError('sample-open', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function readCloudConfig() {
        patch('voice', { busy: true })
        try {
          const result = await call(VOICE_API, '/voice/packs/cloud-config?id=voice-cloud')
          patch('voice', {
            cloudConfig: result,
            credentials: { appId: result.appId || '', accessKey: '', speaker: result.speaker || '' },
          })
          clearOperationError('cloud-config')
        } catch (error) {
          reportOperationError('cloud-config', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function readCloudStats() {
        patch('voice', { busy: true })
        try {
          const cloud = await call(VOICE_API, '/voice/packs/cloud-stats?id=voice-cloud')
          patch('tts', { cloud, cloudError: '' })
          clearOperationError('cloud-stats')
        } catch (error) {
          reportOperationError('cloud-stats', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function loadLibrary(quiet = false) {
        if (!quiet) patch('voice', { busy: true })
        try {
          const library = await call(VOICE_API, '/voice/library')
          patch('voice', { library, libraryProbe: null, trialFile: '' })
          if (!quiet) clearOperationError('voice-library')
        } catch (error) {
          if (!quiet) reportOperationError('voice-library', error)
        } finally {
          if (!quiet) patch('voice', { busy: false })
        }
      }

      async function probeLibrary() {
        const current = state.voice.library
        patch('voice', { busy: true, libraryProbe: null })
        try {
          const result = await call(VOICE_API, '/voice/library/probe', { offset: current?.offset || 0 })
          const names = voices => JSON.stringify((voices || []).map(item => item.name))
          if (current && names(result.voices) !== names(current.voices)) throw new Error('语音库内容已变化，请刷新语音库后重新检查')
          patch('voice', { libraryProbe: result })
          clearOperationError('voice-library-probe')
        } catch (error) {
          reportOperationError('voice-library-probe', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      async function libraryPage(delta) {
        const current = state.voice.library
        const offset = Math.max(0, (current?.offset || 0) + delta)
        if (current && offset === current.offset) return
        patch('voice', { busy: true })
        try {
          const library = await call(VOICE_API, `/voice/library?offset=${offset}`)
          patch('voice', { library, libraryProbe: null, trialFile: '' })
          clearOperationError('voice-library')
        } catch (error) {
          reportOperationError('voice-library', error)
        } finally {
          patch('voice', { busy: false })
        }
      }

      function setTrialField(name, value) {
        patch('voice', name === 'kind' ? { trialKind: value, trialResult: null } : { [name]: value })
      }

      async function sendTrial() {
        const side = state.voice
        const target = String(side.trialTarget ?? '').trim()
        if (!target) return
        const kind = side.trialKind
        const content = kind === 'text' ? String(side.trialText ?? '').trim() : kind === 'path' ? String(side.trialPath ?? '').trim() : side.trialFile
        if (!content) return
        if (!side.trialDryRun) {
          const described = kind === 'text' ? '文本合成的语音' : `语音 ${kind === 'path' ? side.trialPath : side.trialFile}`
          if (!window.confirm(`向 ${target} 发送${described}？`)) return
        }
        patch('voice', { busy: true, trialResult: null })
        try {
          const result = await call(VOICE_API, '/voice/library/send', {
            target,
            ...(kind === 'text' ? { text: side.trialText } : kind === 'path' ? { filePath: side.trialPath } : { file: side.trialFile }),
            dryRun: side.trialDryRun,
          })
          patch('voice', { trialResult: result })
          clearOperationError('voice-library-send')
        } catch (error) {
          reportOperationError('voice-library-send', new Error(`${messageOf(error)}${side.trialDryRun ? '' : '；如请求中断，请先核对 QQ 消息再重试'}`))
        } finally {
          patch('voice', { busy: false })
        }
      }

      // ── Lifecycle ───────────────────────────────────────────────────────

      function ensureLoaded() {
        if (started) return
        started = true
        void loadAsr()
        void loadTts()
        void loadLibrary(true)
        const packsTimer = setInterval(() => { void refreshPacks() }, 3000)
        intervals.add(packsTimer)
        const cloudTimer = setInterval(() => {
          if (state.tts.packs.some(pack => pack.id === 'voice-cloud' && pack.installed)) void loadCloudStats()
        }, 5000)
        intervals.add(cloudTimer)
      }

      function dispose() {
        for (const timer of intervals) clearInterval(timer)
        intervals.clear()
        if (prepareTimer !== null) { clearInterval(prepareTimer); prepareTimer = null }
        if (messageTimer !== null) { clearTimeout(messageTimer); messageTimer = null }
        const url = state.tts.previewUrl
        if (url) { try { URL.revokeObjectURL(url) } catch {} }
        listeners.clear()
      }

      return {
        subscribe, getSnapshot, ensureLoaded, setTab, dispose,
        reloadAsr: loadAsr, reloadTts: loadTts,
        editAsr, editTts, editTtsCharacter, editTtsRoute,
        saveAsr, saveTts, discardAsr, discardTts,
        runAsrCheck, runTtsCheck, startPrepare, cancelPrepare,
        setPreviewText, setPreviewRoute, preview, previewPack,
        setMirror: value => patch('voice', { mirror: value }),
        setSource: value => patch('voice', { source: value, inspection: null, allowUnverified: false }),
        setAllowUnverified: value => patch('voice', { allowUnverified: value === true }),
        setCredentials: changes => patch('voice', { credentials: { ...state.voice.credentials, ...changes } }),
        voiceAction, chooseImport, openSample, readCloudConfig, readCloudStats,
        deleteImportSource, deleteImportBackup,
        refreshLibrary: () => loadLibrary(false), probeLibrary, libraryPage,
        setTrialField, sendTrial,
        clearOperationError,
      }
    }

    // ── UI helpers ────────────────────────────────────────────────────────

    const card = (key, title, children, note) => h('section', { key, className: 'vc-card' },
      title ? h('h2', { className: 'vc-card-title' }, title) : null,
      note ? h('p', { className: 'vc-card-note' }, note) : null,
      h('div', { className: 'vc-card-body' }, ...flatten(children)))

    const field = (label, control) => h('label', { className: 'vc-field' }, h('span', null, label), control)
    const fields = children => h('div', { className: 'vc-fields' }, ...flatten(children))
    const row = children => h('div', { className: 'vc-row' }, ...flatten(children))
    const actions = children => h('div', { className: 'vc-actions' }, ...flatten(children))
    const check = (label, checked, onChange) => h('label', { className: 'vc-check' },
      h('input', { type: 'checkbox', checked: checked === true, onChange: event => onChange(event.target.checked) }), label)
    const button = (label, onClick, options = {}) => h('button', {
      key: options.key,
      type: 'button',
      className: cx('vc-btn', options.primary && 'primary', options.quiet && 'quiet', options.danger && 'danger'),
      disabled: options.disabled === true,
      onClick,
    }, options.busy ? `${label}…` : label)
    const chip = (label, tone) => h('span', { className: cx('vc-chip', tone) }, label)
    const hint = text => h('p', { className: 'vc-hint' }, text)
    const alert = (text, tone) => h('p', { className: cx('vc-alert', tone), role: 'alert' }, text)
    const empty = text => h('p', { className: 'vc-empty' }, text)
    const select = (value, options, onChange, label) => h('select', { value, onChange: event => onChange(event.target.value), 'aria-label': label },
      ...options.map(([id, name]) => h('option', { key: id, value: id }, name)))
    const textInput = (value, onChange, label, options = {}) => h('input', {
      type: 'text', value: value ?? '', maxLength: options.maxLength, placeholder: options.placeholder,
      'aria-label': label, onChange: event => onChange(event.target.value),
    })
    const numberInput = (value, onChange, label, options = {}) => h('input', {
      type: 'number', value: value ?? '', min: options.min, max: options.max, step: options.step,
      'aria-label': label, onChange: event => onChange(event.target.value),
    })
    const textarea = (value, onChange, label, options = {}) => h('textarea', {
      value: value ?? '', maxLength: options.maxLength, placeholder: options.placeholder,
      'aria-label': label, onChange: event => onChange(event.target.value),
    })
    const kv = pairs => h('dl', { className: 'vc-kv' }, ...pairs.flatMap(([term, value]) => [
      h('dt', { key: `t-${term}` }, term), h('dd', { key: `d-${term}` }, value),
    ]))
    const mono = text => h('span', { className: 'vc-mono' }, text)
    const pre = value => h('pre', { className: 'vc-pre' }, value)
    const item = (key, children) => h('div', { key, className: 'vc-item' }, ...flatten(children))
    const stat = (key, label, value, unit, tone) => h('div', { key, className: cx('vc-stat', tone) },
      h('span', { className: 'vc-stat-value' }, value, unit ? h('span', { className: 'vc-stat-unit' }, unit) : null),
      h('span', { className: 'vc-stat-label' }, label))
    const meter = (value, tone) => h('div', { className: 'vc-meter', role: 'progressbar', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { className: cx(tone), style: { width: `${Math.max(0, Math.min(100, Number(value) || 0))}%` } }))

    function stageList(stages) {
      if (!stages?.length) return empty('尚未运行自检。')
      return stages.map(stage => h('div', { key: stage.id, className: 'vc-stage' },
        h('div', { className: 'vc-stage-head' },
          chip(stage.ok ? '通过' : '失败', stage.ok ? 'ok' : 'bad'),
          h('strong', null, stage.label),
          stage.ms === undefined ? null : h('span', { className: 'vc-hint' }, `${stage.ms}ms`)),
        h('p', null, String(stage.detail ?? '')),
        stage.hint ? h('p', { className: 'vc-hint' }, `建议：${stage.hint}`) : null))
    }

    function sideNotice(side, name) {
      if (side.phase === 'loading' || side.phase === 'idle') return h('p', { className: 'vc-loading' }, `正在读取${name}配置…`)
      if (side.phase === 'unavailable') {
        return h('div', { className: 'vc-card-body' },
          alert(`${name}插件未连接：${side.error}`),
          hint(`确认 dsh-local-${name === '语音识别' ? 'asr' : 'voice'} 已安装并在 profile 中启用，然后重启 DSH。`))
      }
      if (side.phase === 'error') return alert(side.error)
      return null
    }

    const dirtyOf = (side, builder) => side.draft !== null && !same(side.draft, builder(side.saved))

    const saveBar = (key, side, dirty, onSave, onDiscard) => h('div', { key, className: 'vc-savebar' },
      h('span', { className: cx('vc-dirty', dirty && 'on') }, dirty ? '有未保存的修改' : '配置已保存'),
      row([
        side.savedMessage ? h('span', { className: 'vc-saved' }, side.savedMessage) : null,
        button('放弃改动', onDiscard, { disabled: !dirty || side.saving }),
        button('保存', onSave, { primary: true, disabled: !dirty || side.saving, busy: side.saving }),
      ]),
      side.saveError ? alert(side.saveError) : null)

    const formatSize = bytes => Number.isFinite(Number(bytes)) && Number(bytes) >= 0
      ? (Number(bytes) >= 1e9 ? `${(Number(bytes) / 1e9).toFixed(2)} GB` : `${(Number(bytes) / 1e6).toFixed(2)} MB`)
      : '未知'
    const packStatus = pack => pack.running ? '运行中' : pack.managed ? '预热中' : pack.installed ? '已安装 · 已停止' : '未安装'
    const packTone = pack => pack.running ? 'ok' : pack.managed ? 'warn' : pack.installed ? 'info' : 'bad'

    function asrEngine(state) {
      const catalog = state.asr.catalog
      return catalog?.engines?.find(item => item.id === catalog?.engine) ?? null
    }

    function preparePercent(prepare) {
      const transfer = prepare?.transfer
      if (transfer && transfer.totalAll > 0) return Math.min(100, Math.round((transfer.receivedAll / transfer.totalAll) * 100))
      const total = prepare?.model?.bytes?.total
      return total ? Math.min(100, Math.round(((prepare.model.bytes.have ?? 0) / total) * 100)) : 0
    }

    // ── Tabs ──────────────────────────────────────────────────────────────

    function OverviewTab({ state, store }) {
      const asr = state.asr, tts = state.tts
      const asrDirty = dirtyOf(asr, asrDraftFrom)
      const ttsDirty = dirtyOf(tts, ttsDraftFrom)
      const engine = asrEngine(state)
      const installed = tts.packs.filter(pack => pack.installed)
      const running = tts.packs.filter(pack => pack.running || pack.managed)
      const selfCheckFailed = [...(asr.check?.stages ?? []), ...(tts.check?.stages ?? [])].some(stage => !stage.ok)
      const checked = asr.check !== null || tts.check !== null

      const asrBody = () => {
        const notice = sideNotice(asr, '语音识别')
        if (notice) return [notice]
        if (!asr.draft) return [empty('识别配置尚未读取。')]
        return [
          row([
            chip(asr.draft.enabled ? '识别已开启' : '识别已关闭', asr.draft.enabled ? 'ok' : 'warn'),
            chip(engine?.ready ? '模型已就绪' : '模型未就绪', engine?.ready ? 'ok' : 'warn'),
            engine?.worker?.running ? chip(`识别进程 pid ${engine.worker.pid}`, 'info') : chip('识别进程按需启动', ''),
          ]),
          check('启用语音识别', asr.draft.enabled, value => store.editAsr({ enabled: value })),
          hint(`引擎 ${engine?.name ?? asr.draft.engine} · 单条 ${asr.draft.maxSeconds}s / ${asr.draft.maxBytesMiB}MiB · 每分钟 ${asr.draft.maxPerMinute} 次`),
          hint('详细参数与模型准备在「识别」页；输入框左侧的麦克风仍可直接录音。'),
          saveBar('asr-save', asr, asrDirty, () => { void store.saveAsr() }, () => store.discardAsr()),
        ]
      }

      const ttsBody = () => {
        const notice = sideNotice(tts, '语音合成')
        if (notice) return [notice]
        if (!tts.draft) return [empty('合成配置尚未读取。')]
        return [
          row([
            chip(tts.draft.enabled ? '语音已开启' : '语音已关闭', tts.draft.enabled ? 'ok' : 'warn'),
            chip(tts.draft.aiEnabled ? '合成已开启' : '合成已关闭', tts.draft.aiEnabled ? 'ok' : 'warn'),
            chip(tts.draft.route === 'cloud' ? '云端线路' : '本地线路', 'info'),
            chip(`已安装 ${installed.length} · 运行中 ${running.length}`, running.length ? 'ok' : ''),
          ]),
          check('允许机器人发送语音', tts.draft.enabled, value => store.editTts({ enabled: value })),
          check('允许语音合成', tts.draft.aiEnabled, value => store.editTts({ aiEnabled: value })),
          hint('触发、线路、音色与合成参数在「合成」页；语音包、语音库与云端配置在对应页面。'),
          saveBar('tts-save', tts, ttsDirty, () => { void store.saveTts() }, () => store.discardTts()),
        ]
      }

      return h('div', { className: 'vc-grid' },
        card('status', '运行状态', [
          h('div', { className: 'vc-stats' },
            stat('installed', '已安装语音包', installed.length, '个', installed.length ? 'ok' : ''),
            stat('running', '运行中', running.length, '个', running.length ? 'ok' : ''),
            stat('library', '语音库文件', state.voice.library ? state.voice.library.count : '—', state.voice.library ? '个' : ''),
            stat('cloud', '本月合成', tts.cloud ? (tts.cloud.monthChars ?? 0) : '—', tts.cloud ? '字' : '')),
          hint(`当前线路：${tts.saved?.route === 'cloud' ? '云端合成' : tts.saved ? '本地合成' : '线路未读取'}${tts.saved?.enabled ? ' · 已允许机器人发送语音' : tts.saved ? ' · 语音发送已关闭' : ''}。`),
          tts.packs.length
            ? tts.packs.map(pack => item(pack.id, [
              h('span', null, pack.name),
              chip(packStatus(pack), packTone(pack)),
              hint(pack.installed ? `${pack.running ? '运行中' : pack.managed ? '等待就绪' : '未运行'}${pack.port ? ` · 端口 ${pack.port}` : ''}` : '尚未安装'),
            ]))
            : empty('尚未发现语音包。'),
        ]),
        card('asr', '语音识别', asrBody(), '把录音变成文字；默认本机 SenseVoice。'),
        card('tts', '语音合成', ttsBody(), '把文字变成语音；线路与音色决定实际引擎。'),
        card('cloud', '云端用量', [
          tts.packs.some(pack => pack.id === 'voice-cloud' && pack.installed)
            ? tts.cloud
              ? h('div', { className: 'vc-stats' },
                stat('model', '模型', tts.cloud.model || '未配置', ''),
                stat('today', '今日字数', tts.cloud.todayChars ?? 0, '字'),
                stat('month', '本月字数', tts.cloud.monthChars ?? 0, '字'),
                stat('cost', '估算费用', tts.cloud.monthCost == null ? '—' : `¥${tts.cloud.monthCost}`, '', tts.cloud.monthCost == null ? '' : 'warn'),
                stat('remain', '剩余额度', tts.cloud.remainChars == null ? '—' : tts.cloud.remainChars, tts.cloud.remainChars == null ? '' : '字'))
              : hint('正在读取云端用量…')
            : hint('云端语音包未安装，或尚未启用云端合成。'),
          tts.cloudError ? alert(`云端用量刷新失败：${tts.cloudError}`, 'warn') : null,
        ]),
        card('check', '最近自检', [
          item('asr', [
            h('span', null, '识别'),
            chip(asr.check ? (asr.check.stages?.every(stage => stage.ok) ? '通过' : '异常') : '未自检', asr.check ? (asr.check.stages?.every(stage => stage.ok) ? 'ok' : 'bad') : ''),
            button('运行识别自检', () => { void store.runAsrCheck() }, { quiet: true, disabled: asr.phase !== 'ready' || asr.checking, busy: asr.checking }),
          ]),
          item('tts', [
            h('span', null, '合成'),
            chip(tts.check ? (tts.check.stages?.every(stage => stage.ok) ? '通过' : '异常') : '未自检', tts.check ? (tts.check.stages?.every(stage => stage.ok) ? 'ok' : 'bad') : ''),
            button('运行合成自检', () => { void store.runTtsCheck() }, { quiet: true, disabled: tts.phase !== 'ready' || tts.checking, busy: tts.checking }),
          ]),
          hint(checked ? (selfCheckFailed ? '有自检项失败，详情见「测试」页。' : '自检全部通过。') : '尚未运行自检；在「测试」页检查服务、合成与发送配置。'),
        ]))
    }

    function AsrTab({ state, store }) {
      const side = state.asr
      const notice = sideNotice(side, '语音识别')
      if (notice || side.phase !== 'ready' || !side.draft) return h('div', { className: 'vc-grid' }, card('notice', '语音识别', notice ?? empty('识别配置尚未读取。')))
      const draft = side.draft
      const engine = asrEngine(state)
      const prepare = side.prepare
      const percent = preparePercent(prepare)
      const preparing = prepare?.active === true
      const engines = (side.catalog?.engines ?? []).map(item => [item.id, item.ready ? `${item.name}（已就绪）` : item.name])
      if (engines.length === 0) engines.push([draft.engine, draft.engine])
      const recent = side.status?.recent ?? []
      return h('div', { className: 'vc-grid' },
        card('general', '总开关与引擎', [
          check('启用语音识别', draft.enabled, value => store.editAsr({ enabled: value })),
          check('记录审计（不含音频）', draft.audit, value => store.editAsr({ audit: value })),
          fields([
            field('识别引擎', select(draft.engine, engines, value => store.editAsr({ engine: value }), '识别引擎')),
            field('默认语言', select(draft.language, LANGUAGES, value => store.editAsr({ language: value }), '默认语言')),
          ]),
        ]),
        card('limits', '限额', [
          fields([
            field('单条最长（秒）', numberInput(draft.maxSeconds, value => store.editAsr({ maxSeconds: value }), '单条最长秒数', { min: 1 })),
            field('单条最大（MiB）', numberInput(draft.maxBytesMiB, value => store.editAsr({ maxBytesMiB: value }), '单条最大 MiB', { min: 1 })),
            field('每分钟次数', numberInput(draft.maxPerMinute, value => store.editAsr({ maxPerMinute: value }), '每分钟次数', { min: 0 })),
            field('每小时次数', numberInput(draft.maxPerHour, value => store.editAsr({ maxPerHour: value }), '每小时次数', { min: 0 })),
          ]),
          hint('0 表示不限制；超限请求在推理前就被拒绝。'),
        ]),
        card('cache', '缓存', [
          check('按音频内容缓存识别结果', draft.cacheEnabled, value => store.editAsr({ cacheEnabled: value })),
          field('最多保留条数', numberInput(draft.maxEntries, value => store.editAsr({ maxEntries: value }), '缓存条数', { min: 1 })),
        ]),
        card('sensevoice', 'SenseVoice 参数', [
          fields([
            field('模型精度', select(draft.precision, PRECISIONS, value => store.editAsr({ precision: value }), '模型精度')),
            field('线程数', numberInput(draft.threads, value => store.editAsr({ threads: value }), '线程数', { min: 1 })),
            field('最长切段（秒）', numberInput(draft.segmentSeconds, value => store.editAsr({ segmentSeconds: value }), '最长切段秒数', { min: 1 })),
            field('VAD 阈值', numberInput(draft.vadThreshold, value => store.editAsr({ vadThreshold: value }), 'VAD 阈值', { min: 0, max: 1, step: 0.05 })),
            field('空闲回收（毫秒）', numberInput(draft.idleTimeoutMs, value => store.editAsr({ idleTimeoutMs: value }), '空闲回收毫秒', { min: 0 })),
          ]),
          field('下载源（每行一个，留空用内置源）', textarea(draft.sourcesText, value => store.editAsr({ sourcesText: value }), '下载源', { placeholder: 'https://huggingface.co\nhttps://hf-mirror.com' })),
        ]),
        card('engine', '识别引擎', [
          kv([
            ['引擎', engine ? `${engine.name}（${engine.location === 'host-local' ? '本机' : '云端'}）` : '—'],
            ['识别语言', (engine?.languages ?? []).join(' / ') || '—'],
            ['模型精度', engine?.precision ?? '—'],
            ['校验时间', engine?.model?.verifiedAt ? new Date(engine.model.verifiedAt).toLocaleString() : '未准备'],
            ['模型目录', mono(engine?.model?.directory ?? '—')],
          ]),
          hint(`本小时已用 ${side.status?.budget?.inHour ?? 0} 次（近一分钟 ${side.status?.budget?.inMinute ?? 0} 次）。`),
        ]),
        card('prepare', '模型准备', [
          row([
            chip(preparing ? `下载中 ${percent}%` : prepare?.ready ? '模型已就绪' : '模型未就绪', preparing ? 'warn' : prepare?.ready ? 'ok' : 'bad'),
            meter(percent, preparing ? 'warn' : prepare?.ready ? 'ok' : ''),
          ]),
          hint(`模型目录：${engine?.model?.directory ?? '—'}`),
          side.prepareError ? alert(side.prepareError) : null,
          row([
            button(prepare?.ready ? '模型已就绪' : '下载并准备模型', () => { void store.startPrepare() }, { primary: true, disabled: preparing || prepare?.ready === true || side.prepareBusy, busy: side.prepareBusy }),
            button('取消准备', () => { void store.cancelPrepare() }, { disabled: !preparing || side.prepareBusy }),
          ]),
        ]),
        card('recent', '最近识别', recent.length === 0
          ? [empty('还没有识别记录。')]
          : recent.map((entry, index) => item(`${entry.ts}-${index}`, [
            mono(new Date(entry.ts).toLocaleTimeString()),
            h('span', null, entry.ok === false ? `失败：${entry.error ?? entry.code}` : `${(entry.audioSeconds ?? 0).toFixed(1)}s → ${entry.chars ?? 0} 字${entry.cached ? '（缓存命中）' : ''}`),
            mono(entry.source ?? ''),
          ]))),
        saveBar('asr-save', side, dirtyOf(side, asrDraftFrom), () => { void store.saveAsr() }, () => store.discardAsr()))
    }

    function TtsTab({ state, store }) {
      const side = state.tts
      const notice = sideNotice(side, '语音合成')
      if (notice || side.phase !== 'ready' || !side.draft) return h('div', { className: 'vc-grid' }, card('notice', '语音合成', notice ?? empty('合成配置尚未读取。')))
      const draft = side.draft
      const route = draft.route
      const names = side.saved?.ttsCharactersByRoute?.[route] ?? []
      const mappingError = side.saved?.ttsCharacterErrorsByRoute?.[route]
      return h('div', { className: 'vc-grid' },
        card('scope', '触发与范围', [
          check('允许机器人发送语音', draft.enabled, value => store.editTts({ enabled: value })),
          fields([
            field('触发者', select(draft.triggerWho, TRIGGER_WHO, value => store.editTts({ triggerWho: value }), '触发者')),
            draft.triggerWho === 'list' ? field('允许的 QQ 号（逗号分隔）', textInput(draft.membersText, value => store.editTts({ membersText: value }), '允许的 QQ 号')) : null,
            field('允许的群号（逗号分隔）', textInput(draft.groupsText, value => store.editTts({ groupsText: value }), '允许的群号')),
          ]),
        ]),
        card('route', '线路与音色', [
          fields([
            field('合成线路', select(route, [['local', '本地'], ['cloud', '云端']], value => store.editTtsRoute(value), '合成线路')),
            field('引擎音色映射名（可留空）', textInput(draft.characters[route], value => store.editTtsCharacter(value), '引擎音色映射名', { maxLength: 100 })),
          ]),
          hint('保存只写入当前线路的音色；另一线路的未保存音色会保留为草稿。'),
          mappingError ? alert(`当前线路映射读取失败：${mappingError}`, 'warn') : hint(names.length ? `当前线路可用映射名：${names.join('、')}。这里填写映射名，不是音色 ID。` : '当前线路未发现映射名；使用自备引擎时可勾选下方覆盖。'),
          check('本次使用自备引擎映射，不按语音包名单校验', draft.allowUnverifiedCharacter, value => store.editTts({ allowUnverifiedCharacter: value })),
        ]),
        card('endpoints', '引擎地址', [
          fields([
            field('本地引擎地址', textInput(draft.endpoints.local, value => store.editTts({ endpoints: { ...draft.endpoints, local: value } }), '本地引擎地址')),
            field('云端包本机地址', textInput(draft.endpoints.cloud, value => store.editTts({ endpoints: { ...draft.endpoints, cloud: value } }), '云端包本机地址')),
          ]),
        ]),
        card('limits', '频率与音频限制', [
          fields([
            field('每分钟上限（0 为不限）', numberInput(draft.maxPerMinute, value => store.editTts({ maxPerMinute: value }), '每分钟上限', { min: 0, max: 60 })),
            field('每小时上限（0 为不限）', numberInput(draft.maxPerHour, value => store.editTts({ maxPerHour: value }), '每小时上限', { min: 0, max: 600 })),
            field('音频最长时长（秒）', numberInput(draft.maxSeconds, value => store.editTts({ maxSeconds: value }), '音频最长时长', { min: 1 })),
            field('音频最大大小（字节）', numberInput(draft.maxBytes, value => store.editTts({ maxBytes: value }), '音频最大大小', { min: 1 })),
            field('默认音量倍数（0.1–4）', numberInput(draft.defaultVolume, value => store.editTts({ defaultVolume: value }), '默认音量', { min: 0.1, max: 4, step: 0.1 })),
            field('归一化响度（quiet / normal / loud 或 -40 至 -5 LUFS）', textInput(draft.loudness, value => store.editTts({ loudness: value }), '归一化响度')),
          ]),
          check('发送后自动回读校验', draft.autoReadback, value => store.editTts({ autoReadback: value })),
        ]),
        card('synthesis', '合成参数', [
          fields([
            field('合成超时（毫秒）', numberInput(draft.ttsTimeoutMs, value => store.editTts({ ttsTimeoutMs: value }), '合成超时', { min: 1, max: 120000 })),
            field('每次合成字数上限', numberInput(draft.ttsMaxChars, value => store.editTts({ ttsMaxChars: value }), '每次合成字数', { min: 1 })),
            field('音色缓存版本', numberInput(draft.ttsCacheVersion, value => store.editTts({ ttsCacheVersion: value }), '音色缓存版本', { min: 0 })),
            field('云端每千字单价', numberInput(draft.pricePerKChar, value => store.editTts({ pricePerKChar: value }), '云端每千字单价', { min: 0, step: 0.01 })),
            field('云端每月额度', numberInput(draft.monthlyQuota, value => store.editTts({ monthlyQuota: value }), '云端每月额度', { min: 0 })),
          ]),
          check('允许语音合成', draft.aiEnabled, value => store.editTts({ aiEnabled: value })),
        ]),
        card('paths', '运行时路径', [
          hint('留空时自动查找；相对路径以 SurfCore 目录为准。'),
          fields([
            field('ffmpeg 路径', textInput(draft.ffmpegPath, value => store.editTts({ ffmpegPath: value }), 'ffmpeg 路径')),
            field('ffprobe 路径（留空优先查找 ffmpeg 同目录）', textInput(draft.ffprobePath, value => store.editTts({ ffprobePath: value }), 'ffprobe 路径')),
          ]),
        ]),
        saveBar('tts-save', side, dirtyOf(side, ttsDraftFrom), () => { void store.saveTts() }, () => store.discardTts()))
    }

    function PacksTab({ state, store }) {
      const tts = state.tts, voice = state.voice
      const busy = voice.busy
      const mirror = [
        ['official', '官方 GitHub'], ['ghfast', 'ghfast'], ['ghproxy', 'gh-proxy'], ['ghproxyNet', 'ghproxy.net'],
      ]
      const packButton = (label, onClick, disabled = false, options = {}) => button(label, onClick, {
        ...options, disabled: busy || disabled, key: options.key,
      })
      return h('div', { className: 'vc-grid' },
        card('install', '在线安装与导入', [
          h('p', null, '也可以从上游网盘下载离线包，解压后手动检查并导入。提取码：sxUZ。 ',
            h('a', { href: 'https://pan.quark.cn/s/ec6cf2b123de?pwd=sxUZ', target: '_blank', rel: 'noreferrer' }, '打开上游网盘')),
          fields([
            field('在线安装下载源', select(voice.mirror, mirror, value => store.setMirror(value), '下载镜像')),
            field('导入目录', textInput(voice.source, value => store.setSource(value), '导入目录', { placeholder: '已解压的语音包目录' })),
            field('试听文本', textInput(tts.previewText, value => store.setPreviewText(value), '试听文本', { maxLength: MAX_PREVIEW_CHARS })),
          ]),
          tts.installSupported
            ? hint('在线安装使用固定源码版本，模型按清单验证；Python 环境与缓存保存在项目内。')
            : hint('上游语音包的在线安装目前需要 Windows；本机可使用自备引擎。'),
          row([
            packButton('选择导入目录', () => { void store.chooseImport() }, !tts.pickerSupported),
            !tts.pickerSupported ? h('span', { className: 'vc-hint' }, '当前系统请手动填写导入目录。') : null,
          ]),
          tts.previewUrl ? h('audio', { controls: true, src: tts.previewUrl, 'aria-label': '试听音频' }) : null,
          voice.inspection
            ? h('div', { className: 'vc-stage' },
              h('div', { className: 'vc-stage-head' }, chip(voice.inspection.verified ? '完整性已验证' : '未提供校验', voice.inspection.verified ? 'ok' : 'warn')),
              h('p', null, `导入源：${voice.inspection.sourceDir || '未知'}；目标：${voice.inspection.targetDir || '未知'}`),
              h('p', null, `版本：${voice.inspection.version || '未知'}；大小：${formatSize(voice.inspection.sizeBytes)}；完整性：${voice.inspection.verified ? '已校验' : '未验证'}`))
            : null,
          voice.inspection && !voice.inspection.verified
            ? check('我了解此包没有完整性校验，仍要导入', voice.allowUnverified, value => store.setAllowUnverified(value))
            : null,
        ]),
        card('packs', '语音包', tts.packs.length ? tts.packs.map(pack => h('article', { key: pack.id, className: 'vc-pack' },
          h('div', { className: 'vc-pack-head' }, h('strong', null, pack.name), chip(packStatus(pack), packTone(pack))),
          h('p', null, `${pack.installed ? '已安装' : '未安装'} · ${pack.running ? '运行中' : pack.managed ? '进程运行中（等待就绪或需停止）' : '未运行'}`),
          pack.sizeBytes != null ? h('p', null, `预计大小：${formatSize(pack.sizeBytes)}`) : null,
          pack.port ? h('p', null, `服务端口：${pack.port}${pack.enginePort ? ` · 引擎端口：${pack.enginePort}（${pack.engineUp ? '运行中' : '未运行'}）` : ''}`) : null,
          pack.dir ? h('p', null, `安装目录：${pack.dir}`) : null,
          pack.about?.summary ? h('p', null, pack.about.summary) : null,
          ...(pack.about?.pros || []).map((text, index) => h('p', { key: `pro-${index}` }, `优点：${text}`)),
          ...(pack.about?.cons || []).map((text, index) => h('p', { key: `con-${index}` }, `要求：${text}`)),
          pack.about?.billing ? h('p', null, pack.about.billing) : null,
          pack.about?.disclaimer ? h('p', null, pack.about.disclaimer) : null,
          pack.cloudConfigError ? alert(`云端配置不可用：${pack.cloudConfigError}`) : null,
          pack.needsCloudConfig ? alert('云端密钥或音色尚未配置，请先填写云端配置。', 'warn') : null,
          pack.install
            ? h('div', null,
              meter(pack.install.progress ?? 0, /失败/.test(pack.install.phase || '') ? 'bad' : ''),
              h('p', null, `${pack.install.phase || ''} ${pack.install.progress ?? 0}% ${pack.install.error || ''}`))
            : null,
          pack.install?.logTail ? pre(pack.install.logTail) : null,
          pack.import
            ? h('div', null,
              meter(pack.import.progress ?? 0, /失败/.test(pack.import.phase || '') ? 'bad' : ''),
              h('p', null, `${pack.import.phase || ''} ${pack.import.progress ?? ''}% ${pack.import.error || ''}`))
            : null,
          actions([
            packButton('在线安装', () => { void store.voiceAction('/voice/packs/install', { id: pack.id, mirror: voice.mirror }) }, !tts.installSupported || pack.installed || (!!pack.install && !['完成', '失败', '已取消'].includes(pack.install.phase)) || (!!pack.import && !['完成', '失败'].includes(pack.import.phase)), { primary: true, key: 'install' }),
            packButton('取消安装', () => { void store.voiceAction('/voice/packs/install-cancel', { id: pack.id }) }, !pack.install || ['完成', '失败', '已取消'].includes(pack.install.phase), { key: 'install-cancel' }),
            packButton('清理安装残留（保留备份）', () => { void store.voiceAction('/voice/packs/clean', { id: pack.id }) }, !!pack.install && !['完成', '失败', '已取消'].includes(pack.install.phase), { key: 'clean' }),
            packButton('检查导入', () => { void store.voiceAction('/voice/packs/import-inspect', { id: pack.id, sourceDir: voice.source }) }, !voice.source, { key: 'inspect' }),
            packButton('导入', () => { void store.voiceAction('/voice/packs/import', { id: pack.id, sourceDir: voice.source, allowUnverified: voice.allowUnverified }) }, !voice.source || voice.inspection?.requestedId !== pack.id || voice.inspection?.requestedSource !== voice.source || (!voice.inspection?.verified && !voice.allowUnverified), { primary: true, key: 'import' }),
            packButton('取消导入', () => { void store.voiceAction('/voice/packs/import-cancel', { id: pack.id }) }, !pack.import || ['完成', '失败'].includes(pack.import.phase), { key: 'import-cancel' }),
            pack.importSource ? packButton('删除导入源文件夹', () => { void store.deleteImportSource(pack) }, !!pack.import && !['完成', '失败'].includes(pack.import.phase), { danger: true, key: 'delete-source' }) : null,
            pack.backupDir ? packButton('删除旧包导入备份', () => { void store.deleteImportBackup(pack) }, !!pack.import && !['完成', '失败'].includes(pack.import.phase), { danger: true, key: 'delete-backup' }) : null,
            packButton('启动', () => { void store.voiceAction('/voice/packs/start', { id: pack.id }) }, !pack.installed, { key: 'start' }),
            packButton('启动并切换合成线路', () => { void store.voiceAction('/voice/packs/activate', { id: pack.id }) }, !pack.installed, { primary: true, key: 'activate' }),
            button('停止', () => { void store.voiceAction('/voice/packs/stop', { id: pack.id }) }, { danger: true, key: 'stop', disabled: !pack.running && !pack.managed && voice.startingPack !== pack.id }),
            packButton('测试合成', () => { void store.voiceAction('/voice/packs/test', { id: pack.id }) }, !pack.running || voice.testingPacks.includes(pack.id), { key: 'test' }),
            ['voice-local', 'voice-cloud'].includes(pack.id) ? packButton('生成试听', () => { void store.previewPack(pack.id) }, !String(tts.previewText ?? '').trim(), { key: 'preview' }) : null,
            packButton('移除并保留备份', () => { void store.voiceAction('/voice/packs/archive', { id: pack.id }) }, !pack.dir, { danger: true, key: 'archive' }),
          ]),
          ...(pack.archives || []).map(name => item(`archive-${name}`, [
            h('span', null, `备份：${name}`),
            packButton('恢复语音包', () => { void store.voiceAction('/voice/packs/restore', { id: pack.id, name }) }, !!pack.dir || !!pack.running, { key: `restore-${name}` }),
          ])))) : [empty('尚未发现语音包。')]),
        card('cloud', '云端语音配置', [
          h('p', null, '在火山引擎语音控制台配置声音复刻，取得 App ID、Access Key 和音色 ID。云端合成按服务商规则计费。 ',
            h('a', { href: 'https://console.volcengine.com/speech/service/8', target: '_blank', rel: 'noreferrer' }, '打开火山引擎语音控制台')),
          tts.packs.some(pack => pack.id === 'voice-cloud' && pack.installed)
            ? h('a', { href: '/dsh-voice/api/voice/packs/sample?id=voice-cloud', download: 'voice-reference.wav' }, '下载参考音频')
            : null,
          tts.packs.some(pack => pack.id === 'voice-cloud' && pack.installed)
            ? actions([packButton('打开参考音频所在位置', () => { void store.openSample() }, false, { key: 'sample-open' })])
            : null,
          actions([
            packButton('读取云端配置', () => { void store.readCloudConfig() }, false, { key: 'read-config' }),
            packButton('读取云端用量', () => { void store.readCloudStats() }, false, { key: 'read-stats' }),
          ]),
          voice.cloudConfig
            ? h('p', null,
              voice.cloudConfig.configured ? '云端语音已配置' : '云端语音尚未配置完整',
              voice.cloudConfig.hasAccessKey ? `；密钥已保存：${voice.cloudConfig.accessKeyMasked}（留空不修改）` : '；尚未保存密钥')
            : null,
          tts.cloudError ? alert(`云端用量刷新失败：${tts.cloudError}`, 'warn') : null,
          tts.cloud
            ? h('div', { className: 'vc-stats' },
              stat('model', '模型', tts.cloud.model || '未配置', ''),
              stat('today-chars', '今日字数', tts.cloud.todayChars ?? 0, '字'),
              stat('today-calls', '今日调用', tts.cloud.todayCalls ?? 0, '次'),
              stat('month-chars', '本月字数', tts.cloud.monthChars ?? 0, '字'),
              stat('month-calls', '本月调用', tts.cloud.monthCalls ?? 0, '次'),
              stat('cost', '估算费用', tts.cloud.monthCost == null ? '—' : `¥${tts.cloud.monthCost}`, '', tts.cloud.monthCost == null ? '' : 'warn'),
              stat('remain', '剩余额度', tts.cloud.remainChars == null ? '—' : tts.cloud.remainChars, tts.cloud.remainChars == null ? '' : '字'))
            : null,
          fields([
            field('App ID', textInput(voice.credentials.appId, value => store.setCredentials({ appId: value }), 'App ID')),
            field('Access Key', h('input', { type: 'password', value: voice.credentials.accessKey, 'aria-label': 'Access Key', onChange: event => store.setCredentials({ accessKey: event.target.value }) })),
            field('音色 ID', textInput(voice.credentials.speaker, value => store.setCredentials({ speaker: value }), '音色 ID')),
          ]),
          actions([
            packButton('保存云端配置', () => { void store.voiceAction('/voice/packs/cloud-config', { id: 'voice-cloud', ...voice.credentials }) }, false, { primary: true, key: 'save-cloud' }),
            packButton('测试云端连接', () => { void store.voiceAction('/voice/packs/test', { id: 'voice-cloud' }) }, voice.testingPacks.includes('voice-cloud') || !tts.packs.some(pack => pack.id === 'voice-cloud' && pack.running), { key: 'test-cloud' }),
          ]),
        ]))
    }

    function LibraryTab({ state, store }) {
      const voice = state.voice, tts = state.tts
      const busy = voice.busy
      const library = voice.library
      const voices = library?.voices ?? []
      const trialKind = voice.trialKind
      const canSend = voice.trialTarget.trim() && (trialKind === 'text' ? voice.trialText.trim() : trialKind === 'path' ? voice.trialPath.trim() : voice.trialFile)
      return h('div', { className: 'vc-grid' },
        card('library', '语音库', [
          h('p', null, '把音频文件放入项目内语音库。检查和试发需要 QQ 桥接运行。'),
          actions([
            button('刷新语音库', () => { void store.refreshLibrary() }, { disabled: busy }),
            button('检查语音文件', () => { void store.probeLibrary() }, { disabled: busy }),
          ]),
          library
            ? h('div', null,
              h('p', null, `目录：${library.dir}；共 ${library.count} 个${library.count ? `，当前从第 ${(library.offset || 0) + 1} 个开始` : ''}`),
              actions([
                button('上一页', () => { void store.libraryPage(-100) }, { disabled: busy || !(library.offset > 0) }),
                button('下一页', () => { void store.libraryPage(100) }, { disabled: busy || (library.offset || 0) + 100 >= library.count }),
              ]),
              voices.length ? h('div', null, ...voices.map(entry => h('p', { key: entry.name, className: 'vc-hint' }, entry.name))) : empty('语音库为空。'))
            : h('p', { className: 'vc-hint' }, '尚未读取语音库。'),
          voice.libraryProbe
            ? h('div', { className: 'vc-stage' },
              h('p', null, '检查结果（最多 100 个）：'),
              ...(voice.libraryProbe.voices || []).map(entry => h('p', { key: entry.name }, `${entry.name}：${entry.ok === false ? entry.error || '不可用' : entry.detail || '通过'}`)))
            : null,
        ]),
        card('trial', '试发', [
          h('p', null, '先校验再发送；只校验也会请求语音合成，使用云端引擎可能产生费用。'),
          fields([
            field('试发目标', textInput(voice.trialTarget, value => store.setTrialField('trialTarget', value), '试发目标', { placeholder: 'group:群号 或 private:QQ号' })),
            field('试发内容类型', select(trialKind, [['file', '语音库音频'], ['text', '文本合成'], ['path', '指定本地文件']], value => store.setTrialField('kind', value), '试发内容类型')),
            trialKind === 'file'
              ? field('试发音频', select(voice.trialFile, [['', '请先刷新并选择音频'], ...voices.map(entry => [entry.name, entry.name])], value => store.setTrialField('trialFile', value), '试发音频'))
              : trialKind === 'text'
                ? field('试发合成文本', textarea(voice.trialText, value => store.setTrialField('trialText', value), '试发合成文本'))
                : field('本地音频绝对路径', textInput(voice.trialPath, value => store.setTrialField('trialPath', value), '试发本地文件路径')),
          ]),
          trialKind === 'text' ? hint('只校验也会请求语音合成；使用云端引擎可能产生费用。') : null,
          check('只校验不发送', voice.trialDryRun, value => store.setTrialField('trialDryRun', value)),
          actions([
            button('校验或试发', () => { void store.sendTrial() }, { primary: true, disabled: busy || !canSend }),
          ]),
          voice.trialResult
            ? h('p', { role: 'status' }, voice.trialResult.dryRun
              ? `校验通过（未发送）：${voice.trialResult.detail || ''}`
              : `已发送；消息 ID：${voice.trialResult.messageId ?? '未知'}；${voice.trialResult.verified ? '已回读校验' : '未回读校验'}`)
            : null,
        ]),
        tts.previewUrl ? card('preview', '试听音频', [h('audio', { controls: true, src: tts.previewUrl, 'aria-label': '试听音频' })]) : null)
    }

    function TestTab({ state, store }) {
      const asr = state.asr, tts = state.tts
      const engine = asrEngine(state)
      const worker = engine?.worker
      const logs = (worker?.logs ?? []).slice(-8)
      const raw = {
        engines: (asr.catalog?.engines ?? []).map(entry => ({ id: entry.id, ready: entry.ready, bytes: entry.model?.bytes ?? null, worker: entry.worker?.running ?? false })),
        budget: asr.status?.budget ?? null,
        cache: asr.status?.cache ?? null,
        progress: asr.prepare ? { active: asr.prepare.active, ready: asr.prepare.ready, error: asr.prepare.error } : null,
      }
      return h('div', { className: 'vc-grid' },
        card('asr-check', '识别自检', [
          hint('会真的拉起识别进程并跑一次静音推理；模型未下载时不会假装通过。'),
          asr.phase === 'ready'
            ? button('开始识别自检', () => { void store.runAsrCheck() }, { primary: true, busy: asr.checking, disabled: asr.checking })
            : sideNotice(asr, '语音识别'),
          asr.checkError ? alert(asr.checkError) : null,
          stageList(asr.check?.stages),
        ]),
        card('tts-check', '合成自检', [
          hint('检查语音服务、合成与发送配置；不会发送 QQ 消息。'),
          tts.phase === 'ready'
            ? button('开始合成自检', () => { void store.runTtsCheck() }, { primary: true, busy: tts.checking, disabled: tts.checking })
            : sideNotice(tts, '语音合成'),
          tts.checkError ? alert(tts.checkError) : null,
          stageList(tts.check?.stages),
        ]),
        card('preview', '试听', [
          hint(`输入 ${MAX_PREVIEW_CHARS} 字以内的文本，按所选线路真实合成一次；云端线路可能产生费用。`),
          tts.phase === 'ready'
            ? [
              field('试听文本', textarea(tts.previewText, value => store.setPreviewText(value), '试听文本', { maxLength: MAX_PREVIEW_CHARS })),
              fields([
                field('试听线路', select(tts.previewRoute, [['local', '本地（voice-local）'], ['cloud', '云端（voice-cloud）']], value => store.setPreviewRoute(value), '试听线路')),
              ]),
              tts.previewError ? alert(tts.previewError) : null,
              row([button('生成试听', () => { void store.preview() }, { primary: true, busy: tts.previewing, disabled: tts.previewing || !String(tts.previewText ?? '').trim() })]),
              tts.previewUrl ? h('audio', { controls: true, src: tts.previewUrl, 'aria-label': '试听音频' }) : null,
            ]
            : sideNotice(tts, '语音合成'),
        ]),
        card('worker', '识别进程', [
          kv([
            ['进程状态', worker?.running ? `运行中（pid ${worker.pid}）` : '未启动（按需拉起）'],
            ['模型已加载', worker?.ready ? '是' : '否，首次识别时加载'],
            ['排队中', `${worker?.pending ?? 0} 条`],
            ['状态目录', mono(asr.saved?.routes?.stateDir ?? '—')],
            ['缓存目录', mono(asr.saved?.routes?.cacheDir ?? '—')],
            ['审计文件', mono(asr.saved?.routes?.auditFile ?? '—')],
          ]),
          logs.length === 0
            ? null
            : logs.map((entry, index) => item(`log-${index}`, [
              mono(new Date(entry.at).toLocaleTimeString()),
              h('span', null, entry.message),
              mono(entry.level),
            ])),
        ]),
        card('raw', '原始状态', [pre(JSON.stringify(raw, null, 2))]),
        card('runtime', '语音包运行时', tts.packs.length
          ? tts.packs.map(pack => item(pack.id, [
            h('span', null, pack.name),
            h('span', null, pack.installed ? `${pack.running ? '运行中' : pack.managed ? '预热中' : '已停止'}${pack.port ? ` · 端口 ${pack.port}` : ''}${pack.enginePort ? ` · 引擎端口 ${pack.enginePort}` : ''}` : '未安装'),
            pack.dir ? hint(pack.dir) : null,
          ]))
          : [empty('尚未发现语音包。')]))
    }

    function VoiceSection({ store }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      useEffect(() => { store.ensureLoaded() }, [store])
      const tab = TABS.some(([id]) => id === state.tab) ? state.tab : 'overview'
      const engine = asrEngine(state)
      const installed = state.tts.packs.filter(pack => pack.installed)
      const running = state.tts.packs.filter(pack => pack.running || pack.managed)
      const checks = [...(state.asr.check?.stages ?? []), ...(state.tts.check?.stages ?? [])]
      const dots = [
        ['route', state.tts.saved ? (state.tts.saved.route === 'cloud' ? '云端合成' : '本地合成') : '线路未读取', state.tts.saved ? 'ok' : ''],
        ['packs', `语音包 ${installed.length} / 运行中 ${running.length}`, running.length ? 'ok' : ''],
        ['asr', engine?.ready ? '识别模型已就绪' : '识别模型未就绪', engine?.ready ? 'ok' : engine ? 'warn' : 'bad'],
        ['cloud', state.tts.cloud ? '云端用量已读取' : state.tts.cloudError ? '云端用量读取失败' : '云端未读取', state.tts.cloud ? 'ok' : state.tts.cloudError ? 'warn' : ''],
        ['check', checks.length ? (checks.every(stage => stage.ok) ? '自检通过' : '自检异常') : '未自检', checks.length ? (checks.every(stage => stage.ok) ? 'ok' : 'bad') : ''],
      ]
      return h('div', { className: 'vc-section' },
        h('style', null, CSS),
        h('header', { className: 'vc-head' },
          h('div', { className: 'vc-head-main' },
            h('h1', { className: 'vc-title' }, '语音'),
            h('p', { className: 'vc-intro' }, '语音识别、语音合成、语音包与语音库共用这一页。保存只写入对应一侧；切走再回来，未保存的草稿仍在。')),
          h('div', { className: 'vc-dots' }, ...dots.map(([key, label, tone]) => h('span', { key, className: cx('vc-dot', tone) }, label)))),
        h('div', { className: 'vc-tabs', role: 'tablist', 'aria-label': '语音设置视图' },
          ...TABS.map(([id, label]) => h('button', {
            key: id, id: `voice-tab-${id}`, type: 'button', role: 'tab',
            'aria-selected': tab === id, 'aria-controls': `voice-panel-${id}`,
            className: cx('vc-tab', tab === id && 'on'), onClick: () => store.setTab(id),
          }, label))),
        state.voice.opError
          ? row([
            alert(state.voice.opError),
            button('关闭提示', () => store.clearOperationError(state.voice.opErrorKey), { quiet: true }),
          ])
          : null,
        h('div', { id: 'voice-settings-tab' },
          tab === 'overview' ? h(OverviewTab, { state, store })
            : tab === 'asr' ? h(AsrTab, { state, store })
              : tab === 'tts' ? h(TtsTab, { state, store })
                : tab === 'packs' ? h(PacksTab, { state, store })
                  : tab === 'library' ? h(LibraryTab, { state, store })
                    : h(TestTab, { state, store })),
        state.voice.message ? h('div', { className: 'vc-toast', role: 'status' }, state.voice.message) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore()
        ctx.effect(() => () => store.dispose(), 'dsh-local-voice: settings store')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'voice',
          order: 7,
          label: () => '语音',
          inject: () => ({ store }),
        }, VoiceSection))
      },
    }
  },
})
