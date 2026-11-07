import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { runInstallCommand } from './install-runner.mjs'

export const VOICE_SOURCE_LOCK = Object.freeze({
  'voice-local': Object.freeze({ url: 'https://github.com/Mieksido/surfvoicelocal.git', commit: 'cb6efde3a37c417462f080d1e82136a6cc29a4ac' }),
  'voice-cloud': Object.freeze({ url: 'https://github.com/Mieksido/surfvoicecloud.git', commit: '363e667469f7df5be0218656609702adafb21110' }),
})

/** Fetch a specific commit into a newly created project-local staging directory. */
export async function stagePinnedSource({ root, destination, sourceUrl, commit, signal, onOutput = () => {} }) {
  if (!/^[a-f\d]{40}$/.test(String(commit))) throw new Error('语音源码提交版本无效')
  const project = realpathSync(resolve(root)), target = resolve(destination)
  const parent = realpathSync(dirname(target)), rel = relative(project, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('语音源码目录必须在项目内')
  try { mkdirSync(target, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('语音源码临时目录已存在，原数据未覆盖')
    throw error
  }
  const run = args => runInstallCommand({ root: project, cwd: target, command: 'git', args, signal, onOutput })
  await run(['init', '-q'])
  await run(['fetch', '--depth=1', '--no-tags', sourceUrl, commit])
  await run(['-c', 'advice.detachedHead=false', 'checkout', '--detach', 'FETCH_HEAD'])
  let actual = ''
  await runInstallCommand({ root: project, cwd: target, command: 'git', args: ['rev-parse', 'HEAD'], signal, onOutput: text => { actual += text } })
  if (actual.trim() !== commit) throw new Error('下载的语音源码提交与锁定版本不匹配')
  return { directory: target, commit }
}
