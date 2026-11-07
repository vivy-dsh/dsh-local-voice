import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Child-only environment: downloads, temporary files and language caches stay in the project. */
export function installerEnvironment(root, parent = process.env) {
  const project = realpathSync(resolve(root))
  const state = join(project, '.installer-environment')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  if (!inside(project, realpathSync(state))) throw new Error('Installer environment resolves outside project')
  const home = join(state, 'home'), temp = join(state, 'temp'), cache = join(state, 'cache')
  for (const dir of [home, temp, cache]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!inside(project, realpathSync(dir))) throw new Error('Installer directory resolves outside project')
  }
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (parent[key]) env[key] = parent[key]
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CACHE_HOME: cache, PIP_CACHE_DIR: join(cache, 'pip'), PYTHONUSERBASE: join(home, 'python-user'),
    HF_HOME: join(cache, 'huggingface'), TORCH_HOME: join(cache, 'torch'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' })
  return env
}

/** Run an owned process and terminate only its process tree when cancelled. */
export function runInstallCommand({ root, cwd, command, args = [], signal, onOutput = () => {}, env = {} }) {
  const project = realpathSync(resolve(root)), workdir = realpathSync(resolve(cwd))
  if (!inside(project, workdir)) throw new Error('Installer working directory resolves outside project')
  if (signal?.aborted) return Promise.reject(new Error('Install cancelled'))
  const childEnv = { ...installerEnvironment(project), ...env }
  return new Promise((resolvePromise, reject) => {
    let cancelled = false, settled = false
    const child = spawn(command, args, { cwd: workdir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      error ? reject(error) : resolvePromise(value)
    }
    const cancel = () => {
      cancelled = true
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { try { child.kill() } catch {} })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      }
    }
    child.stdout.on('data', data => onOutput(String(data)))
    child.stderr.on('data', data => onOutput(String(data)))
    child.on('error', error => finish(cancelled ? new Error('Install cancelled') : error))
    child.on('close', (code, bySignal) => finish(cancelled ? new Error('Install cancelled') : code === 0 ? null : new Error(`Install command failed (${code ?? bySignal})`), { code }))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
