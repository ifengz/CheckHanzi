# 查字宝 — 儿童离线语音查字（iPad 网页版）

给 7-8 岁孩子用的查字工具：**按住说话 → 离线语音识别出字 → 选字 → 看笔顺、组词、偏旁部首，点喇叭离线朗读**。
全部在浏览器本地运行，语音识别和朗读不依赖任何云端服务，**离线也能用**（首次需联网下载模型）。

## 目录结构

```
查字词/
├── char-dict.html              # 主页面（单文件，内置 3494 字字典 + 拼音 + 偏旁数据）
├── dev-server.py               # 本地开发服务器（必须用它启动，见下文）
└── models/
    ├── asr/                    # 语音识别引擎（sherpa-onnx WASM，约 95MB）
    │   ├── sherpa-onnx-wasm-main-vad-asr.js      # Emscripten glue
    │   ├── sherpa-onnx-wasm-main-vad-asr.wasm    # 引擎本体 (12.9MB)
    │   ├── sherpa-onnx-asr.js                    # JS API（OfflineRecognizer）
    │   ├── paraformer.onnx                       # 中文识别模型 (78MB)
    │   └── tokens.txt
    └── tts/                    # 语音朗读引擎（sherpa-onnx WASM worker，约 135MB）
        ├── sherpa-onnx-wasm-main-tts.js          # Emscripten glue
        ├── sherpa-onnx-wasm-main-tts.wasm        # 引擎本体 (13.5MB)
        ├── sherpa-onnx-tts.js                    # JS API（createOfflineTts）
        ├── sherpa-onnx-tts.worker.js             # 自定义 worker（模型经 postMessage 注入）
        ├── model.onnx                            # 中文朗读模型 fanchen-C 16kHz (116MB)
        ├── tokens.txt
        └── lexicon.txt
    └── strokes/                # 笔顺数据（本地，完全离线，约 9MB）
        ├── stroke_data.json                     # 3480 字笔画 + 中线（描边动画用）
        └── hanzi-writer.min.js                  # 笔顺字形渲染（自研动画的静态字形来源）
```

首次访问总下载量约 **235MB**（识别 95MB + 朗读 135MB），之后浏览器会缓存。识别模型在打开页面时加载，朗读模型在第一次点喇叭时才加载（懒加载）。

## 本地开发

语音识别引擎依赖 WASM 多线程，**必须**用带 COOP/COEP 响应头的服务器打开，否则会一直卡在"正在准备离线语音…"。

```bash
cd 查字词/
python3 dev-server.py          # 启动开发服务器（默认 http://127.0.0.1:8000）
```

然后用浏览器打开 **http://127.0.0.1:8000/char-dict.html**（必须用 `127.0.0.1`，麦克风权限需要安全上下文）。

> ⚠️ 不要用 `file://` 直接双击打开，也不要无脑用 `python3 -m http.server`（缺 COOP/COEP 头都加载不了语音识别）。

## 部署到你的服务器（宝塔面板 / Nginx + SSL）

> 目标：Mac 只负责开发；正式使用由服务器提供服务，iPad 通过 `https://你的域名` 访问，
> 首次下载模型后浏览器缓存，之后完全离线可用（识别 + 朗读 + 笔顺全部本地）。

### 1. 上传文件（只传这 4 样）

```
char-dict.html
models/asr/          # 识别引擎（90MB）
models/tts/          # 朗读引擎（130MB）
models/strokes/      # 笔顺数据（9MB）
```

**不要上传**：`dev-server.py`、`dev-server.crt/key`、`char-dict.template.html`、`models/tts-backup-aishell3/`（旧模型备份）。

上传方式任选：
- **宝塔文件管理器**：进入站点目录 → 上传 char-dict.html → 再传 models 文件夹（可分几次传）
- **scp 命令行**：`scp -r char-dict.html models root@你的服务器:/www/wwwroot/你的站点目录/`

### 2. 宝塔：配置跨域隔离头（关键，缺了语音起不来）

宝塔面板 → 网站 → 找到你的站点 → **配置文件**，在 `server { ... }` 块内（`location` 之外）加上三行：

```nginx
    # ---- 关键：跨域隔离（语音识别必需） ----
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy require-corp;
    add_header Cross-Origin-Resource-Policy cross-origin;
```

再加一段 WASM MIME 和缓存规则（放在同一个 `server` 块里）：

```nginx
    # ---- WASM 需要正确的 MIME 类型 ----
    location ~* \.wasm$ {
        types { application/wasm wasm; }
    }

    # ---- 大模型文件缓存（首次之后走本地缓存） ----
    location ~* \.(onnx|wasm|txt|js|json)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
```

保存后**重载 Nginx**（宝塔：软件商店 → Nginx → 重载，或 `nginx -s reload`）。

> ⚠️ 如果 add_header 没生效：宝塔 Nginx 有些版本会丢弃 location 里继承的 add_header，所以把
> COOP/COEP 三行放在 `server` 块顶层（而非 location 内）最稳妥。

### 3. 验证（Mac 上先测）

浏览器打开 `https://你的域名/char-dict.html`，应看到：
- 加载页显示「正在准备离线语音…」，进度条走完进入首页
- 页面**没有**"语音功能未就绪"黄色横幅（有 → 跨域隔离头没生效，回第 2 步）
- 按住黄色 🎙️ 说话，松开出现候选字 → 识别 OK

### 4. iPad 使用

- iPad Safari 打开 `https://你的域名/char-dict.html`（HTTPS 满足麦克风权限）
- 点 **分享 → 添加到主屏幕**，图标就像 App 一样用
- 首次加载 235MB 模型约需几分钟（看网络），之后秒开；**断网也能用**（缓存已存在）

### 备选：手写 Nginx 配置（非宝塔）

```nginx
server {
    listen 443 ssl http2;
    server_name 你的域名.com;

    root /var/www/chazi;
    index char-dict.html;

    # ---- 关键：跨域隔离（语音识别必需） ----
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy require-corp;
    add_header Cross-Origin-Resource-Policy cross-origin;

    # ---- WASM 需要正确的 MIME 类型 ----
    location ~* \.wasm$ {
        types { application/wasm wasm; }
    }

    # ---- 大模型文件缓存（首屏之后走缓存） ----
    location ~* \.(onnx|wasm|txt|js|json)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
}
```

### 验证

打开 `https://你的域名.com/char-dict.html`，应该看到：
- 加载页显示「正在准备离线语音…」，进度条走完进入首页
- 页面提示「语音功能未就绪」的黄色横幅 → 说明跨域隔离头没生效（检查第 2 步）
- 按住黄色大按钮说话，松开后出现候选字

## 使用说明（给孩子）

| 操作 | 效果 |
|---|---|
| 按住黄色 🎙️ 按钮说话，松开 | 语音识别出你读的字 |
| 点候选字卡片 | 进入详情：笔顺 + 偏旁部首 + 组词 |
| 点详情页大喇叭 | 离线朗读这个字 |
| 点每个组词卡片 | 离线朗读这个词语 |
| 顶部输入框输入拼音（如 da） | 按拼音查字 |
| 「查过的字」 | 历史记录 |

**详情页的部首卡片**会教孩子新华字典的查法：数全字笔画 → 在「部首检字表」找部首 → 按剩余笔画找字。

## 技术说明

- **语音识别**：sherpa-onnx (k2-fsa) WASM 离线识别，paraformer-small 中文模型。按住说话 → 麦克风采集 → 重采样 16kHz → 本地解码。无网络也能用，不把孩子的语音传到任何服务器。
- **语音朗读**：sherpa-onnx fanchen-C VITS 模型，运行在 **Web Worker** 中（与识别引擎隔离，避免两个 Emscripten 模块冲突），187 个音色，默认用 0 号。16kHz 采样率（原 aishell3 为 8kHz，已弃用）。
- **模型加载方式**：官方 .data 打包文件有 280MB，本方案用 Emscripten 的 `getPreloadedPackage` 钩子跳过 .data，改用 `FS.writeFile` 直接把模型文件写进虚拟文件系统，省掉 140MB。
- **笔顺动画**：本地 `stroke_data.json`（3480 字笔画+中线数据），点击笔画格播放逐笔描边动画（自研 SVG stroke-dashoffset 实现，不依赖任何 CDN，完全离线）。
- **数据**：内置 3494 个常用字（拼音+组词）+ 404 个拼音索引 + 偏旁部首数据（3477 字覆盖，含部首笔画、全字笔画，来自新华字典衍生词库）。

## 已知限制

- iPad 上语音识别需要 HTTPS（部署后域名已满足）；若在本地 `file://` 或 http 打开，麦克风不可用，但输入框查字仍可用。
- 首次加载 235MB 模型需要几分钟（取决于网络），进度条会显示进度；之后浏览器缓存，秒开。
- 朗读音色是标准女声（16kHz，fanchen-C），清晰自然，比旧版 aishell3（8kHz）音质提升 2 倍；如需更好可升级 huayan-medium（22.05kHz，需 espeak）或接 edge-tts 在线高音质。
- 引擎只支持一个长按录音最多 12 秒；识别单个字或短词效果最好。

## 更新模型（可选）

模型来自 sherpa-onnx 官方 GitHub Releases（Apache-2.0）：

```bash
# 识别模型
curl -L -o /tmp/asr.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2
# 解压后把 model.int8.onnx 改名为 paraformer.onnx，tokens.txt 放进 models/asr/

# 朗读模型
curl -L -o /tmp/tts.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-fanchen-C.tar.bz2
# 解压后把 model.onnx / tokens.txt / lexicon.txt 放进 models/tts/
```
