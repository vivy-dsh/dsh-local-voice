// 语音发送共享库 —— 薄转发层（唯一实现在 voice-core.mjs）。
//
// 桥接与测试都从这里取音频解析、探测与音量处理，保证只有一份实现。
export {
  AUDIO_EXTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SECONDS,
  isAudioFile,
  formatBytes,
  formatDuration,
  listAudioFiles,
  resolveAudioSource,
  safeJoinLibrary,
  probeAudio,
  inspectAudio,
  describeAudio,
  parseTargetKey,
  sanitizeUploadName,
  uniqueLibraryPath,
  VOLUME_MIN,
  VOLUME_MAX,
  LOUDNESS_TARGETS,
  resolveAudioProcessing,
  resolveFfmpeg,
  processAudioVolume,
  cleanupTemp,
} from './voice-core.mjs'
