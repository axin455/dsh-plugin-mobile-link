# dsh-plugin-mobile-link 预览版

为 DeepSeek Harness 增加一个局域网移动网关。手机 App 扫码配对后，可以实时查看并继续电脑端会话，同时同步账号、模型目录和插件开关。

这是预览版，面向 DeepSeek Harness 0.2.1-rc.x，协议和配置可能变化。

配套手机端是 dsh-mobile：
https://github.com/axin455/dsh-mobile

## 主要功能

扫码配对。在 DSH 左下角“移动设备”生成二维码，一次性配对。

设备管理。查看已连接设备，移除设备，开关移动网关。

会话同步。历史快照、实时事件和流式输出，支持重命名和归档。

模型与账号。下发 DeepSeek 账号资料、余额和模型目录，支持切换会话模型。

凭据同步。把电脑上已经保存的 OpenAI 兼容供应商 Key 下发给手机，存入 Keystore。

插件目录。手机端可以查看并开关电脑端插件。

纯文本通道。通过模型直连通道完成对话，不建 Agent 会话，不跑工具。可以选择把每轮对话追加到 ~/.dsh/mobile-link-chats 下的 JSONL 文件。

事件投影。把 DSH 事件整理成手机能显示的主消息和思考、工具细节。

## 安装

1. 克隆仓库。

```
git clone https://github.com/axin455/dsh-plugin-mobile-link.git
```

2. 在 DSH 的 profile 里加入本地 link，路径按你的实际位置修改。

```
dsh plugin add link:/path/to/dsh-plugin-mobile-link
```

3. 重启 DSH，左下角会出现“移动设备”。

## 配置

lanHost 默认是 0.0.0.0，lanPort 默认是 3090。gatewayName 默认取电脑主机名，也可以在配置里指定。

## 协议要点

连接地址是 ws://电脑IP:3090/ws/mobile，DSH WebUI 仍然只监听本机。

配对和重连都通过 WebSocket 子协议携带凭证，token 不进入 URL。

文本帧是 UTF-8 JSON，请求用 type，推送用 kind。

主要推送包括 hello、sessions、session-snapshot、event、assistant-stream、account-profile、account-models、api-credential、models、model-selected、session-stats 和 plugin-catalog。

纯文本对话使用 chat 请求，返回 chat-start、chat-delta、chat-done、chat-error 和 chat-cancelled。

## 安全边界

配对码一次性使用，五分钟过期。token 是 256 位随机值，服务端只保存哈希。

局域网监听只接受私有网段来源。管理接口只接受回环请求。

设备 token 只发往配对时确认的 origin，不会随候选地址跨域复用。

API Key 同步是显式设计。配对成功后，电脑上的供应商 Key 会经局域网单向下发，只写入手机 Keystore。只适用于自己的电脑、自己的手机和可信局域网。

手机端插件和技能不会上传到电脑，也不会在电脑上执行。

## 兼容性

支持 DSH 0.2.1-rc.x，Session 格式 v4，Node.js 22 以上。手机端使用 dsh-mobile 预览版。

## 已知限制

只支持同一局域网直连，不内置公网穿透。远程使用需要 Tailscale、Cloudflare Tunnel 之类的方案。

预览版协议可能调整，升级时请保持手机端和插件版本接近。

依赖 DSH 的 Typert Gateway 和 Connection Peer，旧版本 DSH 不兼容。

## 开发与测试

test/smoke.mjs 是不依赖真实 DSH 的配对与 hello 冒烟测试。

test/render-profile.mjs 用于把你的 DSH profile 渲染成带本地 link 的 manifest，需要传入 profile 的 package.json 路径和插件目录。

## License

MIT
