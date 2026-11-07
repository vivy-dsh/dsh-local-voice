# dsh-local-voice

`dsh-local-voice` 负责 DSH 中的语音合成、语音包管理、音频检查与发送编排。它从 SurfCore
v0.8.6 的 `src/voice-tts.js`、`src/voice-packs.js`、`voice-pack-import.js`、
`voice-diagnostics.js`、`voice-pack-secrets.js`、`src/voice-core.js`、`send-voice-lib.js`
以及 QQ 桥接中的触发规则、限流和发送审计移植而来，并改为自己持有配置和状态。

## 范围

包含：

- 本地 / 云端 TTS：线路、音色、超时、字数上限、缓存版本、试听。
- 语音包：离线导入、在线安装、启停、切换、归档恢复、云端配置与用量。
- 音频库：分页列出、ffprobe 时长/大小检查、ffmpeg 音量与响度处理。
- 触发规则：`owner` / `anyone` / `list`，群聊 10 分钟主人窗口，一条主人消息最多触发一条语音。
- 限流：每分钟 / 每小时，`check` 不占额度，只有 `commit` 才记账。
- 文件名敏感审计、发送审计日志。
- prepare / commit / abort 发送编排，供 SurfCore 桥接和操作者面板使用。
- 发送收口：commit 与语音库发送必须经 orchestrator 的 `voice` Effect host；未挂载时 fail-closed 拒绝，不直发（见下）。

不包含：

- 人格 / 角色 / 桌宠不迁移，也不在新代码中引用。
- QQ/B 站网络收发、SnowLuma 协议、`captureSendGuard` 实时会话状态仍归 SurfCore 传输层。
- 插件只处理“能不能发、发什么、怎么处理音频”，真正投递由传输层完成。

配置与运行入口：**DSH 设置 → 语音**。本插件的客户端只注册一个 `settings.section`，
统一管理 ASR/TTS 开关与参数、语音包安装与导入、语音库、云端配置与用量、诊断、自检与试听；
左侧栏不再有语音面板。`/voice/rules` 接口本身仍由本插件注册，供设置页与 SurfCore 使用。

## 状态布局

默认根目录来自 `DSH_HOME`，可通过环境变量覆盖：

```text
DSH_HOME/voice/
├── config.json                 # voice / voicePacks
├── packs/                      # 已安装语音包（语音包内的 config.toml、runtime/ 等）
├── sources/                    # voice-local / voice-cloud 清单来源
├── audio/                      # 语音库，最多 4 层子目录
├── tmp/                        # ffmpeg 临时处理文件，发送结束或取消时清理
├── cache/                      # 合成音频缓存
├── archives/                   # 语音包归档
├── downloads/                  # 在线安装下载与校验缓存
├── install-staging/            # 在线安装临时目录
├── installer-backups/          # 清理安装残留时移入的备份
├── data/
│   ├── send-ledger.json        # 跨进程共享的限流时间戳，插件是唯一写入方
│   └── audit.jsonl             # 发送审计
└── runtime.json                # 插件启动时发布的本机 IPC 地址和令牌（0600）
```

| 变量 | 默认值 |
| --- | --- |
| `DSH_VOICE_STATE_DIR` | `$DSH_HOME/voice` |
| `SURFCORE_CONFIG_FILE` | `$DSH_HOME/surfcore/config.json`（只读，用于读取 QQ 配置） |
| `SURFCORE_CONSOLE_TOKEN_FILE` | `$DSH_HOME/surfcore/state/console-token`（只读，桥接认证） |

`DSH_HOME` 必须是绝对路径；状态目录不可写时启动失败。语音包目录在运行时固定为
`$DSH_VOICE_STATE_DIR/packs`，旧配置中的 `voicePacks.dir` 不会直接使用。

## 配置

`config.json` 的主要字段：

- `voice.enabled`、`voice.tts.enabled`：总开关与 AI 合成开关，默认关闭。
- `voice.tts.route`（`local` / `cloud`）、`voice.tts.character`、`voice.tts.voice`、
  `voice.tts.endpoints`、`voice.tts.timeoutMs`、`voice.tts.maxChars`、
  `voice.tts.cacheVersion`。
- `voice.trigger.who`、`voice.trigger.members`、`voice.trigger.groups`。
- `voice.maxPerMinute`、`voice.maxPerHour`（0 表示不限）。
- `voice.maxSeconds`、`voice.maxBytes`、`voice.defaultVolume`、`voice.normalize`、
  `voice.loudness`、`voice.autoReadback`。
- `voice.ffmpegPath`、`voice.ffprobePath`：显式路径优先；未配置时 ffprobe 先找 ffmpeg
  同目录，再走原有 PATH 查找。
- `voice.audit`：是否写发送审计，默认开启。
- `voice.cloud.pricePerKChar`、`voice.cloud.monthlyQuota`。
- `voicePacks.manifests`：语音包清单来源；远程 URL 保持原样。

写入使用同目录临时文件 + rename，并保留文件中的其他段。云端凭据写在对应语音包的
`config.toml` 的 `[engine]` 段；保存前校验密钥、音色目录和 JSON，密钥留空不覆盖原值。

## prepare / commit / abort

```text
POST /prepare-send
{
  channel: "agent" | "operator",
  key: "group:123" | "private:456",
  text?: string,                    // 合成后发送
  file?: string,                    // 语音库相对路径（agent 必须使用此形式）
  filePath?: string,                // operator 可用的绝对路径
  audio?: string,                   // file 的别名
  ownerId?, triggerContext?: { lastSpeaker, ownerAt, lastSentAt },
  volume?, normalize?, loudness?, knownTokens?, dryRun?
}
→ { token, path, temp, detail, ... }
```

prepare 依次执行：扫描敏感文件名 → 解析语音库/本地文件 → ffprobe 检查大小和时长 →
ffmpeg 音量/响度处理（必要时生成临时文件）→ 触发规则 → 限流 `check`。
检查失败会清理临时文件并直接报错，不占额度。

- `POST /commit-send { token, messageId?, verified?, duration?, detail? }`：确认发送完成并记账、写审计。发送必须经 Superagent Effect host：需要实际发送时由 Effect 调用 `deliver`；SurfCore 已自行发送时只写入 `external` 回执，不再要求 deliverer。回执中的 `messageId`/`verified`/`duration` 会并入返回。同一 token 重复 commit 返回首次结果，不会再次发送。`dryRun` 只清理临时文件，不记账、不写审计、不触碰 Effect，也不需要 host。
- `POST /abort-send { token }`：查询 Effect 状态；在途或已处于 `sent`/`unknown`/`failed` 时返回 `ok:false, aborted:false`，不删除凭据；仅 `pending` 时取消 Effect，再删除凭据并清理临时文件，不占额度。未挂载 host 时直接删除待发凭据，不抛错。
- token 有效期 5 分钟，一次性使用。投递结果未知时 Effect 保留 `unknown` 且不自动重投（`retryUnknown: false`）；重试前应先向桥接核对，避免重复发送。
- **fail-closed：** 没有挂载 Effect host 时发送一律拒绝（错误码 `VOICE_EFFECT_HOST_REQUIRED`），并丢弃待发凭据与临时文件，绝不直发 —— 直发没有 Effect 记录、不可追溯，所以宁可失败也不静默旁路。插件在 orchestrator 注入后若仍拿不到 voice host，会用 `ctx.logger` 记一条 warn 说明原因；`dryRun` 校验不受影响。桥接就绪检查带超时，超时报 `voice.bridge-timeout`。

AI 通道只能使用语音库内的相对文件名；库外绝对路径只允许操作者显式选择，并沿用同一套大小、
时长、审计与限流规则。

## HTTP 面板 API

前缀 `/dsh-voice/api`，只接受本机 Host、同源写请求，并经过 DSH `connection` 会话校验。

```text
GET  /voice/packs /voice/packs/cloud-config /voice/packs/cloud-stats
GET  /voice/packs/sample /voice/rules /voice/library?offset=N
POST /voice/rules /voice/preview /voice/self-check
POST /voice/library/probe /voice/library/send
POST /voice/packs/choose-import /sample-open /import-inspect /install /install-cancel
POST /voice/packs/import /import-cancel /import-delete-source /import-delete-backup
POST /voice/packs/enable /cloud-config /test /start /activate /clean /archive /restore /stop
```

写接口要求 `content-type: application/json`，请求体上限 512 KiB。合成和语音包测试使用
有界流读取，响应超过 20 MiB 会停止；合成、测试和健康检查拒绝 HTTP 重定向。

## 组件内部 API

前缀 `/dsh-voice/internal`，仅回环地址，且要求请求头 `x-component-token` 与
`$DSH_HOME/voice/runtime.json` 中的令牌一致：

```text
GET  /health /rules /packs /library/list /budget/status
POST /synthesize
POST /prepare-send /commit-send /abort-send
POST /library/list /library/resolve /library/probe
POST /policy/trigger /audit/check /budget/status
POST /packs/activate /packs/stop-owned
```

SurfCore 适配层通过该接口读取语音规则、编排发送，并把 `captureSendGuard`、SnowLuma
record 段和回读校验留在传输层。

## 音频工具

- ffprobe 缺失时，时长校验按上游行为警告并跳过；配置了音量、响度或显式路径时，
  self-check 会把缺失的 ffmpeg/ffprobe 显示为失败阶段。
- 相对 `ffmpegPath` 以 SurfCore 源码目录为基准（沿用原桥接行为）；建议填写项目内绝对路径。
- 合成、语音包测试和健康检查的响应有大小上限；试听文本超过配置字数上限时明确报错，
  不截断。

## 迁移

`npm run setup:components` 在服务停止时执行一次性迁移：

- 旧 `socialV2.voice`、触发名单、限流、音量、线路和语音包清单写入 `voice/config.json`。
- 旧语音包、音频库和在线安装来源复制到 `voice/`，虚拟环境与 `config.toml` 中的旧路径
  会改为新目录；原始包和备份不变。
- 复制前逐文件创建备份并校验 sha256；目标已存在时拒绝覆盖；完成后写迁移标记。
- 再次执行不会重复迁移。

## 测试

```sh
node --test tests/voice-*.test.mjs tests/component-ipc.test.mjs
```

测试使用隔离状态目录、本地 HTTP 替身和模拟引擎，不连接真实 QQ/B 站，也不代表 Windows
语音引擎已完成实机验证。

## 来源与许可

本仓库原为 `dsh-superagent-template` 工作区中的一个模块，现拆出来独立建仓维护。

- **上游**：
  - [SurfCore](https://github.com/Mieksido/surfcore) v0.8.6 —— `src/voice-tts.js`、`src/voice-packs.js`、
    `voice-pack-import.js`、`voice-diagnostics.js`、`voice-pack-secrets.js`、`src/voice-core.js`、
    `send-voice-lib.js` 的语音语义
  - QQ 桥接中的触发规则、限流与发送审计
- **原作者**：Derpyu520 and qq-bridge / QSH contributors
- **上游许可**：MIT（版权声明保留在 [LICENSE](LICENSE)）
