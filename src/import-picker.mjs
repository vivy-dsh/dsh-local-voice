import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'

/** Select an existing offline package directory; temporary data remains project-local. */
export async function chooseImportDirectory({ stateDir, platform = process.platform, execFileImpl = execFile, signal }) {
  if (platform !== 'win32') throw new Error('当前系统请手动填写导入目录')
  signal?.throwIfAborted()
  const tempRoot = join(stateDir, 'tmp')
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(tempRoot, 'voice-picker-'))
  const output = join(temp, 'selected.txt')
  const quoted = `'${output.replaceAll("'", "''")}'`
  const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择解压后的语音包目录'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.File]::WriteAllText(${quoted}, $d.SelectedPath, (New-Object System.Text.UTF8Encoding -ArgumentList $false)) }`
  try {
    signal?.throwIfAborted()
    await new Promise((resolve, reject) => {
      let callbackDone = false, closed = false, outcome
      const finish = () => {
        if (callbackDone && closed) outcome ? reject(outcome) : resolve()
      }
      const child = execFileImpl('powershell.exe', ['-STA', '-NoProfile', '-Command', script], { windowsHide: true, timeout: 180000, signal }, error => {
        outcome = error
        callbackDone = true
        finish()
      })
      if (child?.once) child.once('close', () => { closed = true; finish() })
      else { closed = true; finish() }
    })
    signal?.throwIfAborted()
    let selected
    try { selected = (await readFile(output, 'utf8')).replace(/^\uFEFF/, '').trim() } catch (error) { if (error.code !== 'ENOENT') throw error; selected = '' }
    if (!selected) return { ok: true, cancelled: true }
    if (!win32.isAbsolute(selected) || selected.includes('\0')) throw new Error('选择的目录路径无效')
    return { ok: true, path: selected }
  } finally {
    try { await rm(temp, { recursive: true, force: true }) }
    catch (cause) {
      const error = new Error(`无法清理语音目录选择框临时文件：${String(cause?.message ?? cause)}`, { cause })
      error.code = 'VOICE_PICKER_CLEANUP_FAILED'
      throw error
    }
  }
}

/** Own picker processes and wait for their temporary files to be removed on shutdown. */
export function createImportPicker(options) {
  const controller = new AbortController(), active = new Set()
  let closing = false, disposal
  return {
    choose() {
      if (closing) return Promise.reject(new Error('语音插件已关闭'))
      const operation = chooseImportDirectory({ ...options, signal: controller.signal })
      active.add(operation)
      operation.then(() => active.delete(operation), () => active.delete(operation))
      return operation
    },
    dispose() {
      if (!disposal) {
        closing = true
        controller.abort(new Error('语音插件已关闭'))
        disposal = Promise.allSettled([...active]).then(results => {
          const failures = results.filter(result => result.status === 'rejected' && result.reason?.code === 'VOICE_PICKER_CLEANUP_FAILED')
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), failures.map(result => result.reason.message).join('；'))
        })
      }
      return disposal
    },
  }
}
