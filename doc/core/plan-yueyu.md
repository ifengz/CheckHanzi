# 粤语发音（yueyu）实现计划与风险分析

分支：`yueyu`（基于 e536df8 = origin/deploy）。本文是过程记录，不进发布物。

## 0. 需求拆解

| # | 需求 | 本文对应 |
|---|---|---|
| R1 | 识别出的中英文下面，加一行粤语，**对齐到每个字** | 数据层 + 前端 M1/M2 |
| R2 | 能**连句**发粤语读音 | 后端音频 M3 |
| R3 | **汉字组词**里也能粤语发音 | M1（文字）+ M3（音频） |
| R4 | 未定义：英文 token 要不要"粤语" | 见 §5 Q2 |

## 1. 现状事实（全部本轮实测，带出处）

- 识别链路：`char-dict.html:976-996 cloudRecognize` → `POST /api/asr`；只保留原始字符串（`{text, provider}`）。`handleVoiceResult:1941` → `showSentenceMode:2046` → `showCombinedSentenceMode:1907`，混合句 token 由 `renderMixedSentenceTokens:1699-1744` 渲染（`.mixed-char-button` / `.mixed-latin-button` / `.mixed-space`）。
- 详情区：`renderDetail` 在 `1096-1100` 用 `data.p`（数组时按声调过滤取 `pys[0]`）写 `#detailPinyin`；`renderWords:1207-1218` 取 `words.slice(0,3)`，**词卡本身是朗读按钮**（`1214`），`.word-card .mini-spk` 已 `display:none`（`:168`）。
- 音频：`speak:555` / `prefetchTTS:1443` → `GET /api/tts?text=&lang=&v=2`；三层缓存 = 页面内存 `ttsCache`（key `ttsKey:554` = `lang|v2|text`）、SW `chazi-tts-v2`（`sw.js:22`，`ignoreSearch:false` → query 参与 key）、服务器磁盘（`server-voice.py:519-523`，key = `sha256(TTS_VERSION, lang, voice, LUFS, TP, text)`）。
- **lang 在 5 处被硬收敛成二值**：`char-dict.html:554, 556, 977, 1444, 1568`（`lang === "en" ? "en" : "zh"`）。`voice_audio.py:17-20 TTS_VOICES` 只有 `zh`/`en`，`parse_language` 直接抛错。
- TTS 供应商 = edge-tts（免费无 key），异步合成 + ffmpeg loudnorm，12s 超时，300 字上限（`server-voice.py:502-545`）。
- **edge-tts 无字/词级时间戳**（本机实测 4 个音色，含现网 `zh-CN-XiaoxiaoNeural`）：流里只有 `audio` 和 **1 个 `SentenceBoundary`**，`WordBoundary` 数 = 0。→ 想"从整句音频里切出每个字"这条路，元数据不支持。
- zh-HK 可用音色：`zh-HK-HiuGaaiNeural`（女）、`zh-HK-HiuMaanNeural`（女）、`zh-HK-WanLungNeural`（男）。本机对 `"我们一起去公园玩。"`、`"银行很重要。"`、`"我想 eat apple 果。"` 合成都成功（14–18KB mp3）。**音频内容是不是地道粤语，机器判不了，必须人耳验。**
- 粤拼数据（离线可得、许可干净）：
  - `lshk-org/jyutping-table`（CC BY 4.0，官方《電腦用漢字粵語拼音表》）：26,186 字 / 34,659 读法，**23.5% 的字有多读**；单读子集共 20,042 字（§5 锚字论证用它）。
  - 覆盖率实测（官方表 ∪ Unihan 兜底）：页面字头 3,494 → 官方表 93.4%，加 Unihan 兜底 **99.8%**，仍无粤拼只剩 **1 个汉字**（𫛭，扩展B区），另 5 个"无数据"其实是页面 DICT 里的字母键 `P A T B Q`（`'B'` 甚至带注音 `bī`，`'A'`/`'P'` 用字母本身当 p —— 英文字母查字入口，本次粤拼不覆盖，UI 需自行排除字母键）；组词实际用到 3,248 字，兜底后 **100%**。
  - 所以**"没数据"不是瓶颈**，瓶颈是 ①1,465 个字头在官方表里有多读、必须靠词境消歧，②225 个字头只能拿到 Unihan 的**单一读音**、没有多读候选，正是 §3-2/§3-3 错读风险最高的那批。
  - Unihan 17.0.0 `kCantonese`：**zip sha256 与 `source-lock.json` 里已 pin 的完全一致**，许可已随仓（`sources/UNICODE-LICENSE.txt`）。29,936 条，覆盖 `CHARACTER_DATA` 的 20,924 字 = **99.4%**；在官方表"单读"子集上**与官方表 100% 一致（1,798/1,798）**，同一套 jyutping 拼写、无需转写。**但每字只给 1 个读法**（多读条目 = 0）。
  - `CanCLID/ToJyutping`（BSD-2，本地 pip 装 3.2.0 跑通）：词境 G2P，`银行 → ngan4 hong4`、`行走 → hang4 zau2`（同一字两种读法都对）；输出**长度恒等于输入字符数**，非汉字返回 `(char, None)` → 天然满足 R1 的逐位对齐。
- **逐字取音 vs 词境取音的差距 = 12.9%**：从页面 8,736 个组词随机抽 1,500，逐字查 Unihan 与 ToJyutping 词境结果对比，一致 1,307 / 不一致 193。不一致样本：`离婚 lei4→ci1`、`坏事 waai6→pui1`、`蹲下 cyun4→deon1`、`萝卜 baak6→buk1`、`别扭 bit6→bit3`。
- 本应用页面数据规模：3,494 字头、8,736 个组词槽（去重 7,364）、**533 个字头是普通话多音**（现有代码已要处理声调）；**70.8%（6,185/8,736）的组词含至少一个粤语多读字**。
- 词表（`rime-cantonese` CC BY 4.0 + ODbL 双许可提示，`jyut6ping3.words.dict.yaml`）：88,853 条 / 87,740 唯一词。对本应用 7,364 个去重组词：
  - **原样匹配只 31.6%（2,326）**，因为 rime 词形以繁体为主；
  - 用 Unihan `kSimplifiedVariant`（6,929 条映射）做繁→简归一后 **76.0%（5,595）**，归一还引入 268 个"同形多读"需二次消歧；
  - 剩下 24% 未命中是粤语词库本就不收的普通话词（枫树、王府、秃鹫、唐代、欺瞒…）。
- 资产体积：全量 88k 条 `词+逐字粤拼` = 2,500KB 原始 / **828KB gzip**；取前 20k 条 = 462KB / **139KB gzip**。iPad 页面 + SW 要按这个量级选切法。
- 发布约束：CI = `check-client.mjs`（**按函数名切片源码**：`:24-27` 要 `showCombinedSentenceMode(` 与 `className = "mixed-char-button"`，`:930-931` 切 `renderWords`，`:946-948` 调 `renderWords({w:['花朵']})` 后断言 `[['花','花朵']]`）+ `check-dictionary.mjs` + `check-english.py` + `tests/check_voice_backend.py`；`doc/test/layout-regression-playwright.mjs:27-31` 要求 id `detailBody,detailChar,strokes,radSection,words` 存在。
- 部署：push `deploy` 触发 GitHub Actions，前端 rsync 到宝塔站点，后端单独 tar+ssh（`deploy-voice.sh`）。`server-voice.py` 注释写明服务器 swap 已满、内存吃紧。

## 2. 方案

### 2.1 数据层：把 G2P 从运行时搬到构建期

新增 `models/dictionary/generate_cantonese.py`，产出 `models/dictionary/cantonese-data.js`：

- `yc`：字 → 粤拼候选数组（主源官方表；缺失用 Unihan 兜底；都没有 → 不输出该键，前端显示"无粤拼数据"）。
- `yw`：词 → 逐字粤拼（构建期用 ToJyutping 对**全部页面组词 + 高频粤语词**离线跑一遍，冻结成静态表）。表源用 rime 词库时必须先做 **繁→简归一**（Unihan `kSimplifiedVariant`），否则对本应用的简体组词只有 31.6% 命中，归一后 76.0%；表大小按 §1 体积数字选切法（先只装"页面用到的词 + 高频 2 万"≈139KB gzip，别一上来塞全量 828KB）。
- 生成脚本沿用现仓纪律：`source-lock.json` 记 sha256、许可原文进 `sources/`（先例：`ARPHICPL.TXT`、`LICENSE.lucide.txt`）、`check-dictionary.mjs` 加完整性与许可断言。
- 不用 CantoDict 系（CC BY-NC-SA 且有存废争议）；rime-cantonese（CC BY 4.0）只作交叉校验源，不直接进产物。

理由：识别句是任意文本，运行时消歧只有两条路——(a) 前端用 `yw` 做**贪心最长匹配**，剩下单字走 `yc`；(b) 后端加 `/api/yue` 跑 Python G2P。选 (a)：零新服务、零网络往返、可被 SW 缓存、失败可降级到单字读；(b) 只在 (a) 实测准确率不达标时才上（服务器内存现状不支持再常驻一个大词库进程）。

### 2.2 后端：只加一个 lang 值，不动版本号

- `voice_audio.py`：`TTS_VOICES` 加 `"yue": "zh-HK-<音色>"`，`parse_language` 文案改 `zh/en/yue`。
- **不改 `TTS_VERSION`**：服务端 key 已含 lang+voice，SW key 含完整 query，新增 lang 不会撞已有音频；一旦 bump，服务器磁盘缓存 + 全部孩子 iPad 的 `chazi-tts-v2` 一起作废，要重合成整套字典读音（微软接口配额 + 首周延迟风险）。
- 粤语逐字音频**不用** `prewarm_tts.py` 当模板：它的 key 是 `md5(字)`，线上 handler 用 `sha256(version\0lang\0voice\0LUFS\0TP\0text)`，两者已分叉，预热出来的文件 `/api/tts` 永远不会命中（这是既有问题，另案）。

### 2.3 前端：三值 lang + 逐位对齐 + 诚实缺失

- 先把 5 处 `lang === "en" ? "en" : "zh"` 改成显式三值（`554, 556, 977, 1444, 1568`），并加 CI 断言"同 text 不同 lang 必须产生不同 ttsKey / 不同服务端 cache key"。**这一步不做，传 `"yue"` 会静默播出普通话**——有声、无报错、内容错，是最坏失败模式。
- R1：`renderMixedSentenceTokens:1710` 每个 `.mixed-char-button` 下加 `.mixed-yue-line`（粤拼+声调），与 token 同索引；非汉字位（`.mixed-latin-button:1726`、`.mixed-space:1739`）显示占位 `–`，不假装有粤读。
- R3：`renderWords` 的词卡加粤拼小字；`renderDetail` 在 `#detailPinyin` 下加 `#detailYue`。词卡现在整体是"听普通话"按钮，要拆"普/粤"两个入口 → 同时改 `check-client.mjs:930-931/946-948` 的锚点和断言，**先改测试再改页面**，否则发布 gate 直接红。
- 播放：`speak(text, btn, lang)` 已带 lang 位（`1100` 处 `speak(current, this)` 没传，默认 zh）；粤语按钮显式传 `"yue"`，复用 `ttsRequestSeq`/`cancelSpeech`/`prefetchTTSList:1468` 与失败文案。

### 2.4 音频形态（受 §1 事实约束）

- 整句：1 次 `/api/tts?lang=yue`，与现有普通话整句同构 → R2 直接成立。
- 组词：整词 1 次请求 → R3 的"发音"成立，且 TTS 自己做词境消歧，读法与 `yw` 表一致。
- **逐字音频只能二选一**：
  - (i) "点字听词"：播该字所在**词**的音频，UI 明写"听词"。改动最小，读法正确。
  - ~~(ii) 真·逐字音：离线生成**音节音库**~~ —— 本轮实测否决：锚字覆盖率 70.5%、锚字多生僻、`ngan4` 无锚字（见 §5）。改为 **(iii) 单字详情页的粤语按钮播"该字第一个组词"的整词音频**，按钮标出词名；对齐由粤拼文字承担，音频不承担逐字。
  - 明确**不做**：切整句音频按字分配时间戳（元数据不支持）；单字裸读（12.9% 与词境不一致，会读错多音字）。

### 2.5 里程碑

- **M0 纯验证，不上线（半天）**：20 句 × 3 个 zh-HK 音色盲听打分；锚字音库覆盖率统计；抽 200 条"逐字 vs 词境"不一致项人工判该显示哪个；确认 `SentenceBoundary` 是否唯一元数据（扩到 10 句）。**M0 不通过则音频路整体作废，只交粤拼文字。**
- **M1 文字**：`cantonese-data.js` + 生成脚本 + 许可/校验入 CI；字头与组词显示粤拼（无音频）。
- **M2 句内逐位**：识别句贪心最长匹配 + 逐字粤排行 + 非汉字占位 + 4 尺寸布局回归。
- **M3 音频**：整句 + 整词 `lang=yue`，三值 lang 打通，缓存/取消/失败复用现网。
- **M4 可选**：逐字音（锚字音库）或"粤语等价句"，取决于 M0 与 §5 Q1。

## 3. 对抗辩证：风险与反证方法

| # | 风险 | 已有证据 | 反证/检验 | 定性 |
|---|---|---|---|---|
| 1 | zh-HK 音色其实不地道/读简体普通话词跑调 | 只证明能出字节，没证明听感 | M0 母语者盲听 20 句 | **致命待定**，不过则音频全废 |
| 2 | 单字裸读选错多音字，粤拼标签与音频互相打脸 | 抽样 12.9% 不一致（离婚 ci1/lei4、坏事 pui1/waai6） | 同批词 TTS(字) vs TTS(词) 对拍 + 盲听 | 高，已定"不裸读单字" |
| 3 | ToJyutping 输出含**变调**，可能不等于字典/学校教法定 | `别扭 bit3`（官方 bit6）、`玫瑰 gwai3` | 抽 200 条逐条判"字典音 vs 实际读音"，先定展示口径 | 高，需用户定口径 |
| 4 | ASR 出的是普通话用词，逐字粤读 = "粤读普通话"，不是地道粤语 | 现有 postprocess 面向普通话（`server-voice.py:99`） | UI 文案只承诺"这个字的粤语读法"；不写"粤语说法" | 中，靠文案收敛 |
| 5 | 英文 token 无粤读 | `renderMixedSentenceTokens:1726` 有 latin 分支 | 粤行显示 `–`，不给"英文的粤语发音" | 中，需 §5 Q2 |
| 6 | 缓存污染 → 全体孩子听到错音且无报错 | `ttsKey:554` 与 5 处 lang 收敛 | 加 CI 断言：同 text 不同 lang 的 key 必不同 | **必须做**，成本 1 行断言 |
| 7 | bump `TTS_VERSION` 作废全部现网音频 | `voice_audio.py:15`，SW `chazi-tts-v2` | 只加 lang 不改版本；发布后核对 `X-TTS-Version:2` 且 zh 音频字节不变 | 中，可规避 |
| 8 | 照抄 `prewarm_tts.py` 预热粤语，以为预热好了实则每次现场合成 | 它的 key = `md5(字)`，线上 = `sha256(contract)` | 用真实 key 对拍一次再决定 | 中，另案修复 |
| 9 | 数据许可污染（CantoDict CC BY-NC-SA 传染 + 存废争议） | 现仓逐源 pin sha256 + 许可原文 | 只用 CC BY 4.0 / BSD-2 / CC0 / Unicode；CI 断言许可清单 | 中，已有先例可循 |
| 9b | rime-cantonese 仓同时带 `LICENSE-CC-BY` 与 `LICENSE-ODbL`（双许可，ODbL 有库级传染） | 两个许可文件都在 tarball 根目录 | 构建期确认取哪一份、只取 CC BY 4.0 路径，并把选择写进 `sources.md` | 中，须先厘清再入库 |
| 14 | 词表按繁体入库 → 简体组词命中率从 76% 掉到 31.6%，看起来"词库不行"实则是归一没做 | §1 两个百分比同批数据测得 | 生成脚本必须输出"归一前/后命中率"两行到 CI 日志 | 中，可测可防 |
| 10 | 覆盖缺口：页面字头 6.6%（231 字）无官方粤拼，Unihan 缺 126 字含粤语常用"罉" | §1 覆盖率数字 | 缺失显式文案（照 README 第 20 行笔顺缺失原则），CI 报"无数据字数" | 中，不可消灭只能诚实 |
| 11 | 详情区已排满，加一行挤爆横屏/折叠高度 | `.detail-learning` grid（`:96-110`）、`fitDetailChar:1104+` 用 360/280 档 | 跑 `doc/test/layout-regression-playwright.mjs` 4 尺寸量坐标，不允许裁切 | 中，可测 |
| 12 | 改 `renderWords`/`showCombinedSentenceMode` 撞 CI 锚点，发布 gate 红 | `check-client.mjs:24-27,930-931,946-948` 函数名切片 + 沙箱全局白名单 | 先补锚点与 `vm` 沙箱 stub，再动页面 | 中，顺序问题 |
| 13 | 冷启动延迟：粤语整句要 1 次微软合成（12s 超时上限） | `server-voice.py:517` | 复用 `prefetchTTSList:1468` 预取 + 等待态（`:556` 已有）+ 失败显式（`:581`） | 中，已有机制 |
| 4b | （相邻需求，非本次）孩子直接讲粤语，现 ASR 只认 zh/en | `parse_language` 仅 zh/en；SenseVoice 本身支持 yue | 若要覆盖，是另一个 spike | 低，暂不做 |

## 4. 反向自检（对我自己这套结论）

- "12.9%" 是 1,500 条随机抽样，seed=7，不是全量；写成"约 1/8"更稳妥，且分母剔除了 0 条无输出项（实际 noout=0，所以分母干净）。
- "无 WordBoundary" 只对 edge-tts 7.2.8 + 这 4 个音色 + 1 句成立；M0 要扩到 10 句再定论，不能拿它当永久事实。
- 官方表 vs Unihan 的 100% 一致，只来自 1,798 个"官方表单读"字，**不证明 Unihan 在多变读字上正确**；恰恰是那 23.5% 多读字 Unihan 只给了一个值。
- ToJyutping 的 `ci1/pui1` 我判为"变调或词库口径"，但我没有第二源交叉验证 —— 所以 §3-3 列为待人工判，不写成结论。
- 76.0% 的词表命中率是"本应用自己造的 7,364 个词"上的数，**不是**真实识别句上的命中率；孩子说的句子能不能切出词，要等 M2 用真识别语料重测，这个数字现在不能当承诺。

## 5. 口径决定（2026-10-06 已定 2 条，剩 2 条）

- **已定 · 显示口径 = 实际读音（含变调）**，不是字典标注音。含义与代价：
  - 主源只能用带变调逻辑的 G2P（本机实测 ToJyutping 3.2.0 会输出 `离婚 ci1 fan1`、`玫瑰 mui4 gwai3` 这类变调形），官方表 `lshk/jyutping-table` 降级为**校验源**，不再是显示源；
  - 新风险 §3-3 升级为"显示口径已选变调，但**没有第二源证明变调正确**"，且 edge-tts 自己的读法不一定跟随同一套变调 → 粤拼标签与音频可能对不上。M0 必须专门测这一条（同一句比对"标签音"与"听到的音"）；
  - 若某词变调判错，页面会教错 → 需要 `customize` 白名单能力（ToJyutping 有 `customize(entries)` API，可逐词钉死读法）作为人工兜底。
- **已定 · 英文 token 给粤语译词**（R4 定为"要"）。新增链路：英文词 → 粤词 → 粤拼 → 音频。本轮实测的两条"此路不通"：
  - `rime-cantonese` 词库**没有英文释义字段**（格式只有 `词\t粤拼\t权重`，已查 words/chars/phrase 三个 yaml）；
  - `ToJyutping` **没有 普→粤 词汇转换**（源码 grep 只有 JyutpingConverter / g2p / ipa / customize，没有 cmn→yue 替换表）。
  - 现仓可用的只有 `data/english/ecdict.sqlite3`（英→**普通话**释义），直接用会把普通话词形（例如"我们/什么"）当粤语词。所以必须另找**粤英词典**（候选 `aaronhktan/jyut-dict`，MIT，需实测是否含英文→粤词字段；CantoDict 有英文字段但许可 NC-SA，不用），或退一步做**人工小学词表**（孩子会说的英文词量小，可逐条审）。这条决定使工作量显著增加，排在 M3 之后。
- **未定 · 音色**：等 M0 盲听结果（§6）。
- **未定 · 逐字独立音频**：本轮实测倾向**不做音节音库**——官方表 2,266 个音节里只有 **1,483 个**存在"唯一读法锚字"，页面字头实际用到的 1,838 个音节中锚字覆盖 **70.5%**，且锚字多为生僻字（`hong4` 的锚字是 斻栙蚢跭魧、`hang4` 是 哘姮珩裄鵆），TTS 读生僻字本身不可靠；最关键的 `ngan4`（银）**一个锚字都没有**。建议改为：单字详情页的粤语按钮播"该字的第一个组词"整词音频，按钮上写明听的是哪个词。

## 6. M0 盲听结果（2026-10-06，用户逐条打分）

覆盖：13 句 × 3 音色 = 39 槽位，实际打了 33 条（A2/D1/D2 各只有 1 个音色）。

**三音色一致失败 → 是通道问题，换音色解决不了：**

| 句 | 内容 | 判定 | 含义 |
|---|---|---|---|
| C1 | 这个银行很重要。 | 三音色全部 读法错 / 不能用 | 行 没按词境读 hong4 |
| C4 | 这个很重。 | 三音色全部 **不是粤语** / 读法错 / 不能用 | 具体哪几个字跑调未知，要 v2 探针 |
| A1 | 我哋今日去公园玩。 | 三音色备注都是「园字读音不对」（总评仍记"对"） | 园 在 公园 里读错 |
| B2/B3 | 这是一本很好看的书。/ 我觉得这个事情很重要。 | 三音色读法全部「不确定」，B3 三音色「勉强」 | 普通话用词句子不可信 |

**交叉证据（对齐了 §5 预警的"标签 vs 音频打架"）：** C2「我慢慢行走」三音色都对、D1 裸读「行」判对 → TTS 把 行 固定读成 hang4；而 ToJyutping 给「银行 = ngan4 hong4」（本机实测）。也就是**文字层正确、音频层错误且不可由文字层修正**。C3「重新」三音色对、C4「很重」三音色错 → 同一个 重 只在部分词里跑偏。

**音色横比：** `WanLung`(男) 能用 9 / 勉强 1；`HiuMaan`(女) 6 / 2；`HiuGaai`(女) 6 / 3。A1/A3 上 HiuGaai 都被降级为勉强。**若继续用 edge-tts，只能选 WanLung。**

**结论（可执行）：** ① 粤拼**文字**层维持原计划（M1/M2 不受影响，文字读法经母语者判定为对的那批已覆盖 C2/C3 等）；② 粤语音频**不能**按原计划直接上线 —— 现通道在多音字上有母语者一致确认的错读，且我们没有任何手段从客户端纠正它（edge-tts 不吃 SSML/音素，见 §7 待查）；③ 音频层要等"可强制指定读音"的方案调研结果再定，或降级为"整句参考音 + 页面明写不保证逐字读法"。

## 7. 音频通道选型调研结果（2026-10-07，后台 agent 91 次取源，逐条带 URL）

### 7.1 能"逐字强制读音"的两条已证实路

- **Azure AI Speech（官方、要 key）**：zh-HK 在官方"有 SAPI 音素集"的 locale 列表里，`<phoneme alphabet="sapi" ph="nei 5 hou 2">你好</phoneme>` 就是粤拼式（初声/韵/声调三表）；官方明确警告**写 `sapi` 不要写 `jyutping`**，合法 alphabet 只有 `ipa/sapi/ups/x-sampa`，音素不认识直接 HTTP 400。zh-HK 还支持 custom lexicon(PLS) 整词替换（lexicon 要有公开 URL）。旁证：language-support 表脚注3"不支持 Phonemes"挂在部分 zh-CN 方言音色上，HiuGaai/HiuMaan/WanLung 三行都没挂。额度：F0 免费 **0.5M 字符/月**、实时 20 请求/60 秒；S0 零售 **$15/1M 字符**（pricing 网页是 JS 占位 `$-`，价取官方 retail API）。来源：`speech-ssml-phonetic-sets`、`speech-synthesis-markup-pronunciation`、`speech-services-quotas-and-limits`、`prices.azure.com/api/retail/prices`。**未验证：没有 key，没做真实合成回听。**
- **自托管 `typangaa/canto-tts`（Apache-2.0）**：ONNX Runtime CPU、48kHz，checkpoint **只吃 phoneme token、自己不做 G2P**，`core/cantophon.jyutping_to_string()` 可直接喂粤拼 → 读法由我们保证；权重 `canto-tts-nano` 合计 **764MB ONNX**（441+230+89），单音色，有浏览器 ONNX 导出脚本和 int8 量化脚本。**自评声调准确率只有 84.22%（CER 11.82%）**，训练数据私有不公开。来源：`github.com/typangaa/canto-tts`、`huggingface.co/typangaa/canto-tts-nano`、PyPI `canto-tts`。

### 7.2 排除项（都已取源，别再走）

- **讯飞 xfyun**：有粤语音色（AIUI `x2_xiaoyue`），但在线 WebAPI **没有任何音素/注音入参**（文档 0 命中，`vcn` 只选发音人）；逐字注音只在"超拟人合成"里（`着[=zhuo2]手`），而其发音人表 **0 个粤语**、声调定义是普通话 1–5 调。长文本的 `pybuf`"音素链接"是**输出**不是输入。→ 同 vendor 复用只省鉴权，不解决读音。
- **sherpa-onnx 官方预训练 TTS** 4 页文档搜 cantonese/yue/粤 **0 命中**；**Piper VOICES.md** 只有 `zh_CN-huayan`；**MFA** 词典模型只有 mandarin；**OpenSLR** 无粤语 TTS 语料 → 我们现有的 WASM 浏览器 TTS 路线没有官方粤语模型。
- **`csukuangfj/vits-cantonese-hf-xiaomaiiwn`**：ONNX 114MB + 可改 `lexicon.txt`（汉字→IPA+调型），技术上最贴现有 WASM 路线，但**无 model card、无声明许可**（上游同）→ 只能当评估件，要用得先向作者要授权。
- **Forvo**：许可页禁止重复/系统性抽取，商用须另行授权 → 不能用来建音库。
- **`lilytats`、`Cantonese-TTS-Dataset`**：GitHub repo search 0 命中、PyPI 404 → 我上一轮提到的这两个名字**不存在**，撤回。
- CosyVoice（Apache-2.0）：粤语确实有（v1/v2 语言标签 `<|yue|>`、v3 指令"请用广东话表达。"），但发音控制官方只写**中文拼音 + 英文 CMU**，未覆盖粤拼 → 能"像粤语"，不能"逐字定读法"。

### 7.3 意外收获：真入音库（可以替掉我否决的"锚字"方案）

- **Common Voice Scripted Speech 27.0 – Cantonese (yue)，CC0-1.0，5.99GB MP3** → 许可干净的整站粤语音频源，可商用可批量。
- **`AlienKevin/wordshk_cantonese_speech`，CC BY 4.0，115k 行 parquet**（WordsHK 粤语朗读）→ 词级音频，正对 R3"组词发音"。
- Wikimedia Commons「Audio files in Cantonese」79 个文件，已见**音节级**录音（`File:Yue-aa4aa1zai2.ogg`、`File:Yue-diu2.ogg`），许可逐文件不同（示例页 CC BY-SA 1.0）→ 可用但需逐文件核可。
- Lingua Libre 粤语（Q9186）词级录音在 Commons 存在，但 `pronunciation-yue` 子类 0 文件、素材混在 `pronunciation-other`(7410)，逐页许可未验证。

### 7.4 文本层顺带解决的一条

- **`typangaa/canto-hk-g2p`（Apache-2.0）**：`user_dict={"行":"hong4"}` 可逐字/逐词锁读法且优先级最高，可出 IPA；数据源只用 rime-cantonese(CC-BY-4.0)+Unihan(Unicode v3)+CMUdict(BSD)，且**明确排除** ODbL maps、CC-Canto(CC-BY-SA)、words.hk、CantoDict → 许可纪律比我们现方案更干净，适合替 ToJyutping 当显示源（也正好承接 §5"实际读音含变调"需要人工钉死的口子）。

### 7.5 对上一轮盲听结论的反证（必须认）

- 控制层事实成立：edge-tts 官方 README 原文"Support for custom SSML was removed…only permits a single `<voice>` + single `<prosody>`" → 我们**无法**在它上面注入音素，这条不受异议。
- 但**没有找到任何公开缺陷报告**说 zh-HK 把「银行/公园」读错（edge-tts issues、GitHub 全域、中英文检索均 0）→ §6 的判定目前**只有我们自己的耳朵**。
- 且有相反评价：第三方《粤语长音频TTS生产手册》(2026-09-05 两轮盲测) 把 **Edge zh-HK 定为默认产线**（男声 WanLung 直接用），并写"MiMo 预置男声不如 Edge WanLung 地道" → 分歧点是**整句韵律 vs 单字多音读音**，指标不同，不是谁在撒谎。
- 所以 §6 的"三音色一致失败"要先做一次**最小对照复测**才能定性（见 §9 下一步）。


## 8. 附：M0 盲听包位置与用法

位置 `doc/test/yue-blind/`（`/doc/test/` 已在 .gitignore，不进发布物）：`make_blind_pack.py`（生成器，幂等）→ `clips/*.mp3` 52 条 + `index.html` + `data.json`。

```sh
python3 doc/test/yue-blind/make_blind_pack.py          # 已跑，52/52 成功，848KB
python3 .github/scripts/serve-preview.py 8765          # 起本地服务（仓库根）
open http://127.0.0.1:8765/doc/test/yue-blind/index.html
```

盲听设计（已用 ego lite 实机验证）：13 条文本 × 3 个匿名粤语音色（每条随机换序，标签只有"试听1/2/3"）+ 1 条"对照·普通话"（现网 Xiaoxiao，不打分）。每条打 4 项：是不是粤语 / 读法对不对 / 自然度 1-5 / 能不能给孩子用 + 备注。打完点「导出我的打分」，把文本框内容贴回来；「揭晓音色对应」只在导出一行带真名，避免边听边看名字。

13 条覆盖 5 类，对应 5 个待证问题：A1-A3 地道粤语句（音色到底是不是粤语）、B1-B3 普通话用词句（现网 ASR 出的就是这种文本，粤读会不会怪）、C1-C4 多音字词境（银行/行走、重新/很重）、D1-D2 单字裸读（现网单字按钮的做法，看它会挑哪个音）、E1 中英混合（R4 会遇到的形态）。

已验证与未验证：脚本、页面、52 个音频路径、打分入库(localStorage)、进度计数、导出格式、揭晓后重新渲染仍保留真名 —— 全部实测通过；**截图未成功**（ego 的 `Page.captureScreenshot` 超时），排版外观要你自己开页面确认；音频**未做响度归一**（本机无 ffmpeg），正式链路会统一到 -20 LUFS，所以音量差不作为评分项。

## 9. 下一步（带判据，不靠感觉推进）

1. **最小对照复测（已建好并验过，等你 3 分钟）**：`http://127.0.0.1:8765/doc/test/yue-pairs/index.html`，包在 `doc/test/yue-pairs/`。全部只用 WanLung 一个音色，13 项：P1-P6 每行给两个词境，只答"那个字在两段的音**一样/不一样/听不出**"，并把听到的音写成粤拼；S1-S7 把「这个很重」拆成 这/个/很/重/这个/很重/这个很重，指出**哪一段开始不像粤语**。判据：若 P1/P2 都答"一样"且写出的音是 hang4 → §6 的"不辨词境"定性成立，Edge 通道出局；若答"不一样"或写出的就是 hong4 → 说明是上一轮的听感误判，Edge 可留用（并只需为「园」这一类补白名单）。
2. **文本层不排队**：改用/并入 `canto-hk-g2p`（Apache-2.0，`user_dict` 锁读法、源清单许可更干净），M1/M2 可以照原计划做，与音频选型无关。
3. **音频层三选一**（等第 1 步结论再定，别先建）：
   - A Azure `alphabet="sapi"` 音素逐字钉读：需 key + 新增密钥管理；F0 0.5M 字符/月，超出 $15/1M。规模算式（现网真实调用量本机测不到，主机/端口在 Actions secrets 里，只能从宝塔后台或给只读入口才能定量）：`月字符 = 识别句数×平均12 + 组词点击数×平均3`，F0 上限对应约 **4.2 万次整句/月** 或 **16.7 万次整词/月**；按这个量级，小用户量下免费档大概率够用，但要防 20 请求/60 秒的实时限流。
   - B 自托管 canto-tts（Apache-2.0，只吃音素）：无 per-call 费用、读音由我们保证；代价是 764MB ONNX 上到一个 swap 已满的服务器、CPU 延迟未测、**模型自评声调准确率 84.22%**（这条对我们"教对"的目标是硬伤，必须先小规模听测）。
   - C 真人音库（Common Voice 27 yue **CC0** + WordsHK 朗读 **CC BY 4.0**）：读法可由人工逐条核，最贴"教学正确性"；代价是要建入库/检索管线，且逐字独立音仍是拼接感。
4. **为什么现网普通话没炸**：同一缺陷（点单字=裸读默认音）在普通话通道结构上一直存在（`char-dict.html:1100` 走 `speak(current)`，不带词境），只是没人逐字核对；粤语把它的暴露面放大了（§1：1,465 个字头多读）。所以修法要一次覆盖两条通道的"裸读单字"口径，不能只给粤语打补丁。

## 10. v2 复测记录的问题与 v3 工具（2026-10-07）

**v2（最小对照）只答了 3/13，且有一处自相矛盾**：P1「银行 vs 行走」勾了**一样**，但同一条记录里写的听音是 ①`heng` ②`hang`（两个不同的音）；P2 只勾没写音；P4/P5/P6 和 S1–S7（定位「这个很重」的拆字题）**全部空着**。所以 v2 能立住的结论只有两条，其余不能推：

- **行 不随词境变**：P1 和 P2 都答"一样" → Edge 在 行 上不给 hong4。
- **重 会随词境变**：P3「很重 vs 重新」答"不一样" → 同一个音色在 重 上是会变调的。
- 合起来：这条通道不是"整体瞎"，而是**逐字不一致** —— 有些字会按词境变、有些永远读默认音。所以既不能判它全废，也不能按"几个词没错"外推安全；**风险面 = §1 的 1,465 个多读字头**，只能逐字或按高频清单核。
- 另记：你写的 `heng` 不在官方表「行」的读法集合里（官方给 haang2/haang4/hang2/hang4/hang6/hong2/hong4）→ 听感与粤拼记法需要对齐，v3 改成"给标尺字二选一"，不再让你凭记忆写音。

**v3 同音判别包（已建好、已用 ego lite 实测）**：`doc/test/yue-abx/`，地址 `http://127.0.0.1:8765/doc/test/yue-abx/index.html`。6 题、20 段音频，全部 WanLung 一个音色。问法改成**"目标词里那个字，更像下面哪个参考字"**，参考字取官方表里**只有一个读法**的字：航=hong4、苑=jyun2、元=jyun4、丛=cung4。Q1 银行/Q2 行业（考 行）、Q3 公园/Q4 果园（考 园）、Q5 很重（考 重，两个选项都是 cung4，正解 cung5 → 选"都不像"就写下你听到的调）、Q6 把「这个很重」拆成 这/很/很重/这个/这个很重 逐段标"像不像粤语"并指出**哪一段最先不像**。导出加了硬闸门：漏答就导不出来并列出漏了哪几题（v2 的 S1–S7 全空就是没闸门造成的）。
实测记录：13→6 题渲染、20 个中文名 mp3 全部 HTTP 200 且浏览器解码成功（1.4–1.7s）、漏答闸门返回"漏答：Q1..Q6"且输出为空、补满后 6/6 且导出 6 行、我的测试数据已清空（`localStorage.yue-abx-v3` 已删）。
修掉的页面 bug：完成度判定 `done()` 读的是 localStorage 里的对象（没有 `total` 字段），导致 Q6 永远算未答完 —— 真机跑第一遍才暴露，纯看代码不会发现。

## 11. v3 结果：M0 的两条判定被推翻（2026-10-07）

v3 你 6/6 答完，我把每个选择拿去对词库（`rime-cantonese` 已做繁→简归一）：

| 题 | 你选 | 标尺读法 | 词库答案 | 结论 |
|---|---|---|---|---|
| Q1 银行 | 航 | hong4 | `銀行 = ngan4 hong4` | **Edge 读对** |
| Q2 行业 | 航 | hong4 | `行業 = hong4 jip6` | **Edge 读对** |
| Q3 公园 | 苑 | jyun2 | `公園 = gung1 jyun2` | **Edge 读对** |
| Q4 果园 | 元 | jyun4 | `果園 = gwo2 jyun4` | **Edge 读对**（园 本来就是两读） |
| Q5 很重 | 都不是，听到 `cung3` | 两个选项都是 cung4 | `重量 = cung5 loeng6` | **疑似真错读**（应 cung5，听到 cung3） |
| Q6 分段 | 最先不像 = 这 | — | 这 是普通话词形 | **词汇层问题**，不是引擎错读 |

**为什么会翻案**（写清机制，避免下次再犯）：M0 是自由判断，你听的是"整句像不像粤语"，我把它记成了"某个字读错"；v3 改成 ABX + 官方表唯一读法当标尺，才把**字音对错**和**词形地道**分开。同一个人同一批音频，两种问法给出相反答案 → 说明 M0 的数据不能用于选型，§6 里"三音色一致失败"那两条作废。

**剩下两个真问题，性质不同**：① 重 在 很重 里的声调（若 cung3 属实=引擎错读，需要错读率量化）；② 这/们/很 这类普通话词形（引擎没错，是我们把普通话句子直接喂给它 → 属 §5 已定的"粤读普通话词"口径，解法在**输入文本**那一层，换供应商也救不了）。

## 12. v4 错读率工具（已建好，评分逻辑已验证）

`doc/test/yue-error-rate/`，地址 `http://127.0.0.1:8765/doc/test/yue-error-rate/index.html`；生成器 `make_error_rate.py` 会自动：取 app 组词 → 找只含 1 个多读字的词 → 用官方表"唯一读法"的常用锚字做标尺 → 用 rime(字典音) 和 ToJyutping(实际音) 两把钥匙当答案 → 合成 → 前端选完**自动对答案算错读率**（说不清不计分母），漏答导不出来。

本轮规模：入选 12 题 / 32 段音频；漏斗剔除 122（≥2 个多读字）+60（锚字不够）+28（同字最多 2 题）+9（词库答案对不上字数）+1（字典正解无锚字）。实测：12 题渲染、36 个 audio、48 个 radio、中文名 mp3 全部解码成功、埋 1 个人为错选 → 输出 `错读率 = 1/12 = 8.3%`，评分算术确认无误；测试数据已清空。

**局限（不能当成全量结论）**：这 12 题是"字典正解恰好有常用锚字"的可测子集，偏简单；错读率只能代表这个子集。

## 13. 收敛后的决策规则（不再每轮翻案）

1. 唯一判据 = v4 的**错读率**（由你耳朵产出、由词库自动判分）。你只需定一个阈值：**错读率 ≤ 多少可以用 Edge 免费通道**（建议 5%，即每 20 次点击最多 1 次读错，且错的都是低频词）。
2. 超阈值 → 才启用 §7 的强制读音路（Azure `alphabet="sapi"`，要 key，F0 0.5M 字符/月）或自托管 canto-tts（Apache-2.0，自评声调 84.22%）。
3. 无论哪条路，**输入文本层都要做 普→粤 词形**（这→呢、们→哋、很→好…），因为 Q6 证明这类"不像粤语"跟引擎无关。这条与音频选型解耦，可以单独排期。

## 14. v4 结果：错读率测不准，改按"故障类别"决策（2026-10-07）

你答完 12/12：**错读 2 题**。但这条数不能当阈值判据 —— 算式先摆出来：

- 点估计 `2/12 = 16.7%`；**95% 置信区间（Wilson）= 4.7%–44.8%，宽 40.1pp**。
- 想把区间压到 ±5pp 要 n≈80；要能区分"≤5% 可用"和"≥15% 不可用"，按 `n = (z√p₀q₀ + z√p₁q₁)²/(p₁−p₀)²` 算 **n ≈ 190 题**，按每题 25 秒 = **约 80 分钟耳朵**。→ 所以我上一轮提的"用错读率定阈值"**不可执行**，撤回阈值判据（不是撤回判据的方向，是它的量纲）。

两类故障各自成立，且修法不同：

| 类 | 样本 | 性质 | 文本层能不能修 |
|---|---|---|---|
| A 声调走歪 | T9 绒 应 jung2 → 你听 jung4；v3 Q5 重 应 cung5 → 你听 cung3 | 引擎把调放错 | **不能**，输入汉字已对 |
| B 掺普通话音 | T8 风 应 fung1 → 你写 "feng 第一声"（`feng` 不是合法粤语音节） | 引擎吐出普通话音节 | **不能**，且对"教读音"是致命的 |

B 类要防一个替代解释：你写的 `feng` 也可能只是把 `fung` 记粗了。这条只能再用一次**二选一**判别定死：给"粤拼 fung1 的锚字"与"东风里的风"两个音，让你选像哪个（下一轮 10 题就干这件事，不算新率，只判 B 类是偶发还是常发）。

**改后的决策规则（可执行）**：
1. 不再用错读率当阈值；改用"故障存在性"：**只要 A/B 任一类被复现 ≥1 次，Edge 免费通道就不许当'教读音'的音频源**（现已各 1 次）。
2. 音频源必须能**强制读音**：Azure `sapi` 音素 或 自托管 canto-tts（两者都直接把粤拼喂进去，A/B 类由构造消除）。
3. 词汇层（这/们/很）与选型无关，独立排期（§13.3）。

## 15. 轮数边界（你问"还要补几轮"时用这个）

- **必要耳朵轮 = 0**：不需要为算准率补测；n≈190 不值。
- **可选耳朵轮 = 1（10 题，约 3 分钟）**：只判 B 类（掺普通话音）是偶发还是常发，并顺手验 `feng/fung` 这个替代解释。
- **必要工程轮 = 1（我做，不占你耳朵以外的资源）**：下载 canto-tts nano（Apache-2.0，**764MB ONNX**）在本机 CPU 推理，把**同样这 12 题**用强制粤拼重合成一遍，做成 Edge 音 vs canto-tts 音的 A/B 盲听页 —— 你只需再听一次同一批字。
- Azure 那条我现在**测不了**：没有 key。要测就得你开（注册要信用卡；F0 免费 0.5M 字符/月，超出 $15/1M）。

## 16. ① canto-tts spike 结果（2026-10-07，本机跑通）

可行性：**成立**。`canto-tts` 0.1.0（PyPI，Apache-2.0）+ `typangaa/canto-tts-nano`（22 文件 / **764MB**）在本机 CPU 推理：

- 强制读音可用：`cantophon.jyutping_to_string("si1 jung2")` → `<o-s> <r-i> <t1> <o-j> <r-ung> <t2>`，直接给音素 token，模型不做 G2P → 读法由我们说了算。
- 性能：后端加载 **3.9s**；12 条词合成 0.9–1.9s/条，**平均 1.2s**（thread_count=4）；原始输出 48kHz 立体声 WAV。
- **踩到的坑（上服务器必炸，先记）**：HF snapshot 目录是软链，`onnxruntime` 校验 external data 时报 `External data path escapes model directory`，必须 `cp -RL` 把权重实体化成平目录才能加载。
- 环境要求：PyPI 上 0.1.0–0.1.4 全部 `Requires-Python >=3.10`，本机系统 python 是 3.9.6 → 得用 3.12 venv（我用 `uv venv /tmp/canto-venv --python 3.12`）。

**规模账（这条修正我先前"服务器内存吃紧所以自建不可行"的判断）**：合成是**一次性离线**动作，不是常驻服务。8,736 个组词 × 平均 1.2s ≈ **2.9 小时 CPU**，产出 mp3（24kHz 单声道 48kbps）实测平均 **18KB/条** → 全量约 **157MB** 静态文件；线上仍走现有 `/api/tts` 磁盘缓存那套读文件路径，不需要 Python 进程常驻。真正的新增成本是：仓库/站点多 157MB 资产 + 一次性合成作业，而不是内存。

同题 A/B 工具已就绪：`doc/test/yue-ab-pair/`，地址 `http://127.0.0.1:8765/doc/test/yue-ab-pair/index.html`。同一批 12 题、同一批标尺字，每题为 Edge 与 canto 各设一次选择，通道顺序按题随机、标签只写"甲/乙"；两通道音频都过 `loudnorm=I=-20:TP=-2:LRA=7` 到 24kHz 单声道 48k MP3，避免用音量偏袒某一方（注意：生产 `voice_audio.py` 是**双遍** loudnorm，这里对两通道用同一单遍处理只求公平，与线上不完全等价）。
实测：56 个音频文件、页面 12 题 / 72 个 audio / 96 个 radio、中文名与两通道文件全部 HTTP 200 且浏览器解码成功（canto 2.6s、Edge 1.6s 同题可比）；评分算式用埋点验证 —— 人为让 Edge 在 T8/T9 选错 → 输出 `Edge 错读 2/12 = 16.7%`、`canto 0/12 = 0.0%`、配对差异 2 条，与预期完全一致。**这组数字是我造的假数据，只证明算式对，不代表 canto 更好**；真实结论要你的耳朵。

## 17. A/B 实测结果：两条音频路都判死，只剩 Azure 未验（2026-10-07）

你的 A/B（12 题×两通道，同一批标尺字）：**Edge 错读 3/12 = 25%**（T8 风 应 fung1→你听 fung3；T9 绒 应 jung2→jung4；T12 重 应 zung6→cung4，全是声调/音节滑移）；**canto 11/12 选「都不是」**。

canto 那 11 个「都不是」不能读成"canto 读音不准"，只能读成"canto 音频不可懂"——客观测量支持后者：2 个音节的词，合成结果 **1.6–8.1 秒**（Edge 同题 1.5–1.6 秒），三档温度（0.9 / 0.2 / 0.01+top_k=1）各跑 4 次共 24 次**没有一档稳定**，响度还在 -21～-34 dB 之间漂。`OnnxBackend.synthesize` 文档要求调用方自己转音素，我用的就是它的官方入口（`cantophon.jyutping_to_string`，与 `to_phoneme("銀行")` 输出逐字符相同），所以不是姿势问题。另一个侧面证据：官方高层 API `CantoTTS.synthesize` 自带 `best_of_n=4, max_attempts=3, asr_backend="whisper"` —— **作者自己就得靠多次采样 + ASR 复检**才敢用。→ canto-tts nano 出局。

顺带把上一轮的规模账作废：既然输出不稳，"离线批量合成 8,736 词 / 2.9 小时 / 157MB"这个前提不成立。

第三条我原以为可行的路也已证伪：**WordsHK 朗读库不是词级音库**。实测下载 shard0（455MB，15.7s）后读 schema：只有 `audio(struct<bytes,path>)` + `text(string)` 两列，114,988 条；`text` 抽样全是**释义句子**（例：「離開人世；係「死亡」比較正式嘅委婉語」），**没有词头列、没有粤拼列**，`audio.path` 还拿释义当文件名 → 无法按词连接我们的组词。Common Voice 27 yue（CC0）同属句级，未再验。

**剩下的唯一未排除项 = Azure `alphabet="sapi"` 音素**（文档级证据已在 §7.1，但我没有 key，未做过一次真实合成）。它的代价：注册要信用卡、F0 免费 0.5M 字符/月、20 请求/60 秒限流、音素写错返回 400。

**因此当前唯一能上线的最小方案**：M1/M2 只做**粤拼文字层**（canto-hk-g2p + `user_dict` 锁读法，逐字对齐到识别句），粤语音频这次**不做**，页面在粤语区直接写明"暂无粤语读音"，不给按钮。要加音频，先由你开一个 Azure key，我用同一批 12 题走真音素合成做实测（不花你耳朵以外的成本），错读率达标再接进组词和整句。

## 18. 锚字改写与白名单（2026-10-07，用户耳朵产出）

- 锚字可行性 `doc/test/yue-anchor-fix/`：A1 东风→东蜂 **比原音准**；A2 丝绒→丝冗 **还是不准**；A3 严重→严仲 **说不清**；A5 万岁→万漫（控制项）用户未答；A4 很重（cung5）**无常用锚字**，只作对照。→ 结论：锚字法不是开关，是**逐字白名单**，且"单字读对 ≠ 替换进词里还准"。
- 白名单 `doc/test/yue-anchor-whitelist/`（26 个单字 / 11 个读音，官方表唯一读法 + 在 app 字头内）：用户答完 **可用 25/26**，唯一 `说不清` 的是 `jung2` 的「冗」（该音仍有「拥」可用）；`cung5`、`hang4` 在候选池里就**没有常用锚字**。各音可用锚字：fung1 锋蜂疯烽丰 / zung6 颂诵讼仲 / sat1 虱膝瑟室 / haa6 厦 / bat1 笔 / gaa1 嘉 / sai3 势 / cau4 酬稠囚 / maan6 漫曼 / hong4 航杭 / jung2 拥。
- 第二关 `doc/test/yue-anchor-gate2/`（10 题：3 个已知错读 + 7 个控制组，问"替换后 更准/一样/更差/说不清"）：工具已建好并实测（10 项、84 个音频文件、页面 JS `node --check` 通过、浏览器解码正常、漏答闸门与导出生效）；**控制组专测"替换会不会误伤本来就读对的字"**。

## 19. 关于"接我们现在识别用的那家（讯飞）行不行"

- 分工要先分清：**识别**走讯飞（`server-voice.py` 主路 xfyun → SenseVoice → whisper 兜底），**朗读**走 edge-tts，两者不是同一个服务。
- 讯飞**确实有粤语合成**：AIUI 发音人表里 小月 = `x2_xiaoyue`（粤语，女），在线合成语种含粤语 → 账号可复用，接口能接。
- 但接上并不能治我们的病：讯飞在线合成入参里**没有任何逐字注音/音素**（API 文档 grep 0 命中，只有 `vcn` 选发音人）；有注音语法（`着[=zhuo2]手`）的是"超拟人合成"，其发音人表 **0 个粤语**；长文本合成的 `pybuf`"音素链接"是**输出**不是输入。→ 我们测出的错读（风 fung3 / 绒 jung4 / 重 cung4）在讯飞上**无法强制指定**，只能赌它的粤语 G2P 恰好比 Edge 准。
- 两点未验证，要用得先确认：① 现售控制台里粤语发音人对你这个应用是否开放（列表需登录，我没进去）；② 错读率是否低于 Edge 的 25%（要 key 才能测；服务器上那三个环境变量本机没有，主机与端口都在 GitHub Actions secrets 里）。

## 20. 第二关结果：锚字替换可用，但只能逐词验（2026-10-07）

用户答完 10 题（3 需修 + 7 控制）：

| 组 | 结果 | 含义 |
|---|---|---|
| 东风→东锋 (fung1) | **更准** | 替换生效 |
| 严重→严颂 (zung6) | **更准** | 替换生效 |
| 丝绒→丝拥 (jung2) | **更差** | 锚字在词境里反而更差，替换不生效 |
| 控制组 7 题（万岁/下垂/不久/专家/世界/丝绸/丢失） | **全部「一样」** | 替换**不会误伤**本来就读对的字 |

**算式（给决策用的规模账）**：需修组命中率 = 2/3，且失败项不可预测 → 补丁必须**逐词听测**才能入表，单题约 15 秒（3 段音频）。
- 全量 8,736 个组词 → 8736×15s ≈ **36.4 小时**耳朵，不现实，放弃全量。
- 第一批 100 个高频组词 → **约 25 分钟**，可分 3–4 次做完；每词命中即入表，未入表的词**只给粤拼、不给播放按钮**（诚实降级，符合 `feedback-affordance-must-match-reality`）。
- **整句粤语语音暂缓**：句内同时替换多个风险字会互相改变词境，目前没有一条验证过；单点替换有效不等于句子级有效。

**收敛后的口径（一条）**：M1/M2 文字层上线（粤拼逐字对齐 + 组词粤拼）；音频层 = Edge + **已验证词补丁表**，首批 100 词，按批扩。放弃项与原因：Azure 强制音素（要 key、未实测一次，但它是唯一"读法 100% 由我们给定"的根解，留作后备）、讯飞（无逐字注音入口，见 §19）、canto-tts（输出长度失控、不可懂）、WordsHK（无词列接不上）、全量锚字补丁（36 小时耳朵）。

## 21. M1 文字层已实现（2026-10-07，未提交）

改动：`models/dictionary/generate_cantonese.py`（新增，构建期生成器）→ `models/dictionary/cantonese-data.js`（3,490 字 / 7,274 词 / 90 词入 `unverified`，310KB、gzip 94KB）；`char-dict.html` 加 `<script src>`、`#detailYue`、词卡 `.wyue`、混合句 `.mixed-token`+`.yue` 与 `yueAlign/yueLabel`；`fitDetailChar()` 的固定高度已把 `#detailYue` 计进去；`source-lock.json` 增 `jyutping_table`（CC BY 4.0 + sha256）；`sources.md`/`README.md` 补来源与许可；`check-client.mjs` 加词卡粤拼断言 + 新增混合句逐字对齐测试（含"拉丁 token 不给粤拼"），`check-dictionary.mjs` 加离线表完整性（每字读法必须落在官方候选集内、同词不得既已核又未核、未核比例 <2%）。

验证（全部实测）：`check-client` / `check-dictionary` 连跑两轮 exit=0，`git diff --check` 干净；真浏览器 iPad 横屏 1194×834：字头页 花=`faa1`（拼音 huā 下方，hero 无溢出，字形 259px）；混合句 我喜欢花朵apple → ngo5/hei2/fun1/faa1/do2 逐字在下、行内 5 token + 1 拉丁、`scrollWidth-clientWidth=0`；手机 844×390：字形 280px、hero 溢出 0、token 行底 351 < 视口 390。**关键正面证据**：混合句"银行很严重"渲染成 银:ngan4 行:**hong4** 很:han2 严:jim4 重:**zung6** —— 音频通道错读的那两个多音字，文字层在词境里给的是对的。多读无词时显示 `haang4 多读` 并把 7 个候选放进 title；`刘备` 在 `unverified` 里，所以走单字回退并标"多读"，不假装确定。

未完成：粤语音频（按 §13/§20 的结论，需要能强制读音的源）；英文 token 的粤语译词（§5 已定要做，但 rime/ToJyutping 都没有英文字段，需另找粤英词典）。改动尚未 commit。

## 22. 音频线结论：本轮关闭（2026-10-07，用户拍"不租"）

ModelScope 上那个 `speech_tts/speech_sambert-hifigan_tts_jiajia_Cantonese_16k`（Apache-2.0，卡片见浏览器抓取）**硬条件不合格**：卡片原文「使用方式：直接输入文本进行推理」，无音素/粤拼入参；且「目前仅支持 Linux，暂不支持 Windows 及 Mac」；训练语料来源与许可未声明（只写单发音人约 11.8 小时）→ 按 `sources.md` 纪律只能当评估件。

候选全表（两列硬筛：①能出粤语 ②能逐字强制读音）：国产商业四家（火山/腾讯/阿里百炼/讯飞）全挂第②列——`<phoneme>` 只吃普通话拼音 `py` 或英文 `cmu`，火山还对方言音色关闭 SSML；PaddleSpeech 粤语语料 CC BY-NC-ND **不可商用**；canto-tts（=MOSS-TTS-Nano 粤语微调）实测输出 1.6–8.1s/2 音节不可懂；CosyVoice3/Qwen3-TTS 无逐字粤语注音。唯一双条件达标的是 **MOSS-TTS 旗舰（Apache-2.0，yue + Pinyin/IPA 控制）**，需要 GPU → 用户明确**不租 GPU**，此路关闭。MiniMax 有 `language_boost="Chinese,Yue"` + `pronunciation_dict.tone`，但对粤语是否生效未验证（文档登录墙），未采纳。

因此本轮交付 = **M1 粤拼文字层**（已完成、未 commit）。粤语音频不做，页面上不出现粤语播放按钮，`README.md` 已写明"这次没有上"及实测依据（每 12 词错 3）。将来若要重启音频，只剩两个开口，都要他先给资源：Azure `alphabet="sapi"` 音素（要 key，未实测一次）或 GPU 跑 MOSS-TTS 旗舰（已明确不租）。

顺带存证（非本轮范围）：魔搭上有 `manyeyes/whisper-small-cantonese-onnx-*` 粤语**识别** ONNX 模型，若日后做"孩子直接讲粤语"的入口可用，不必等厂商。

## 23. canto-tts 的第二次判死（带分布数据，2026-10-07）

我上一轮只用单次采样就说它"不可懂"，证据不足。这次按官方 `duration_filter` 的等价做法重测：同一词最多采 5 次，挑时长最接近"音素数校准期望"的那一次（`doc/test/yue-ab-pair2/gate_clips.py`，12 词 × 5 = 60 次推理）。

结果：门控后**只有 1/12 落在官方带宽 [0.5,1.8]×期望**；选中时长 0.16–3.04s；同词两次差距最大的是 `不乏`（0.16s vs 3.76s，**23 倍**）、`下垂`（1.76s vs 7.6s）。必须同时写清一条自我反驳：期望时长本身对 2 音节偏紧（0.72–0.79s），而 **Edge 同词实际是 1.5–1.6s，也在带外** —— 所以"带外"不等于"不可懂"，不能拿它当判决。真正的判决是：**同一份音素输入的输出长度分布本身就这么宽**，门控只能挑"最不离谱"的一次，不能保证内容完整（0.16s 那次基本就是截断）。平均 4.0s/词（5 次采样 + 挑选）。

因此不再让你听这一版（听了也难定论，白白花你耳朵）：canto-tts 作为免费离线音源**出局**，出局理由是分布不可控，不是我上次那句证据不足的"不可懂"。若将来有人要救它，正解是官方另一档 `quality="best_of_n"`（用粤语 whisper 按 CER 复检内容），代价是再下 ~500MB ASR 权重且每词耗时翻倍——属于另立项目，不排在本轮。

## 24. 音频路线已选：Azure 强制音素（2026-10-07 用户拍板"念对"）

用户选择注册 Azure 免费账户走 `<phoneme alphabet="sapi">` 路线，替代逐词听测的止血方案。区域按官方区域表选支持神经合成的 `eastasia`/`southeastasia`（来源：learn.microsoft.com/zh-cn/azure/ai-services/speech-service/regions，已抓取）。资源类型必须保持 **F0**：超额行为是拒绝请求（配额硬限），不是自动扣费；升级付费订阅需手动开通。规模账：已核词表合计 29,550 字符，F0 免费额度 0.5M 字符/月。

密钥处理约定（等 key 到手后执行）：只进服务器环境变量与宝塔站点配置，沿用现有 `XFYUN_APP_ID/XFYUN_API_KEY/XFYUN_API_SECRET` 的同款做法；不进 git、不进 `char-dict.html`、不回显在 CI 日志。下一步实测清单：① 粤语 `zh-HK-*` 音色在 F0 下能否出音；② `sapi` 粤拼注入是否真改变"风/绒/重"的读法（用我们已验的 25 个锚字当标尺）；③ 音素写错时的 400 行为与错误文案；④ 20 请求/60 秒限流对现网并发的影响。

## 25. Azure 实测：注入生效，但 HiuGaai 的 1 声调型不对（2026-10-07）

F0 客观测量（20ms 帧 + 自相关取基频，斜率=对 voiced 帧的线性拟合；只看方向，不看绝对值）：

| 音色 | 1 声 fung1 | 3 声 fung3 | 2 声 jung2 | 4 声 jung4 | 6 声 zung6 | 4 声 cung4 |
|---|---|---|---|---|---|---|
| HiuGaai | 285.7Hz **-1.67 降** | 225.4Hz -2.72 降 | 207.8 +5.06 升 | 187.1 -3.41 降 | 197.5 -3.2 降 | 175.8 -4.49 降 |
| **HiuMaan** | 313.7Hz **+1.9 升** | 254.0Hz -2.26 降 | 219.2 +4.22 升 | 195.1 -2.76 降 | 219.2 -2.06 降 | 190.5 -4.42 降 |
| WanLung | 151.7Hz -2.26 降 | 112.7Hz -3.17 降 | 105.3 +1.01 升 | 90.9 -3.95 降 | 90.9 -3.65 降 | 81.6 -5.68 降 |

三条硬结论：① **注入确实生效**——`风` 喂 `fung 1` 与喂 `fung 3` 的基频中位差 60Hz，且与锚字 `锋(fung1)`/`讽(fung3)` 的曲线逐项相同；不喂时 `风` 的曲线与 `fung 3` 完全一致（225.4/-2.72），说明**默认就读成下降调**，这解释了上一轮 Edge 上"风 听成 fung3"。② **HiuGaai 与 WanLung 把第 1 声念成降调**（斜率 -1.67 / -2.26），1 声与 3 声同向 → 你在这两个音色上分不清 1/3 是**音色的锅，不是耳朵的锅**；只有 **HiuMaan 的 1 声不是降调**（+1.9）。③ 4 声与 6 声在三个音色里**都是降调**，只差音高（如 HiuMaan 190.5 vs 219.2）→ 这一对是结构性弱点，与音色无关，`很重/严重` 这类词以后要单独盯。

你上一轮 T9「不符」也有解释：正解标尺是「冗」，而它正是 26 个锚字里你唯一标"说不清"的那个 → 已从标尺池剔除（`ANCHOR_DENY={"冗"}`，jung2 改用「拥」）。听测包已按 **HiuMaan** 重出（`clips/hiumaan/`，14 行含 2 控制组，页面与导出已实测；导出里 12/12 是我埋的假数据只验算式）。判据不变：控制组两条都要选到错的音，正组 ≥11/12 才算 Azure 达标。

## 26. 同音色判别通过（2026-10-07）

上一版"选标尺"的仪器是坏的：目标词是 Azure HiuMaan、标尺是 Edge，跨说话人音高不可比 → 控制组反复不符是我的设计错误，不是耳朵。改成同音色"一样/不一样"6 行（`doc/test/yue-azure-same/`）：**注意力闸 3/3 通过**（同输入念两遍、跨字同音都判"一样"），**关键题 3/3 通过**（fung1↔fung3、jung2↔jung4、zung6↔cung4 都判"不一样"）。按 §25 前写的判据（闸门全过 + 关键 ≥2/3）→ **Azure 的 sapi 音素注入声调可用**，含已知弱点 4/6 声对在内这次都被听出来了。

## 27. 后端粤语通道已实现（2026-10-07，未部署）

`voice_audio.py`：`TTS_VOICES` 加 `yue → zh-HK-HiuMaanNeural`；`parse_language` 放开 yue；`tts_cache_key` 新增 `readings` 参数，**只在 lang=yue 时参与哈希**，所以 zh/en 的缓存键与线上旧公式逐字节相同（不作废现网音频）；新增 `jyutping_to_sapi`（`ngan4 → ngan 4`，不转换会被 Azure 回无正文 400）与 `azure_ssml`（逐字包 `<phoneme>`，非汉字原样转义保留，读法必须匹配 `^[a-z]+[0-9]$` 且数量必须等于汉字数，否则 `VoiceAudioError`）。
`server-voice.py`：新增 `azure_tts_generate`（urllib，12 秒超时，读 `AZURE_SPEECH_KEY/AZURE_SPEECH_REGION`，缺配置直接报错而不是静默回退）；`/api/tts` 在 `lang=yue` 时要求 `readings` 并走 Azure，zh/en 仍走 edge-tts；loudnorm 与磁盘缓存路径共用。

端到端实测（Flask test_client，8 项）：① 粤语 200 / 13,484B / `X-TTS-Version: 2`；② 同句换读法 → 音频不同且各自落盘（2 个缓存文件）；③缺 readings 400；④数量不符 400 并写明"粤拼数量 1 与汉字数 2 不一致"；⑤格式不合法 400；⑥普通话 200 且**缓存文件名等于线上旧公式**；⑦英文 200；⑧文本里夹带 `<phoneme>` 被转义、无法注入标签。
仓库三道门全绿：`check-client` 0、`check-dictionary` 0、`tests/check_voice_backend.py` 16 tests OK，`git diff --check` 干净。

待做：前端放开 5 处 `lang === "en" ? "en" : "zh"` 的二值收敛（`char-dict.html:554/556/977/1444/1568`）并加粤语播放按钮 + 随请求带上 `readings`；生产需要 `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` 两个环境变量（我没有服务器入口）；F0 是 20 请求/分钟，若要预生成 7,274 个已核词，一次性作业约 6 小时。

## 28. 前端粤语播放已接通（2026-10-07，本地端到端实测）

`char-dict.html`：新增 `ttsLang`（三值，不再把 yue 收敛成 zh）、`yueReadings`、`yueSentenceText`、`yueSentenceButtonEl`；`ttsKey` 与 `prefetchTTS` 在 yue 时带上 `readings`；三处入口——字头页 `.yue-spk`、组词卡 `.wyue-spk`（stopPropagation，不抢原"听普通话"点击）、整句按钮（纯中文句挂在 `#voiceEcho`，中英混合句挂在 token 行下方，只念中文部分并保留标点）。识别侧的 3 处二值收敛（`cloudRecognize`、`submitRecording`、`lookupLanguage`）**没动**——本次不做粤语识别。
标签与音频一致性：显示的粤拼与发给 Azure 的 `readings` 同源同序，多读字两边都用同一个 `t` 值，不会各说一套。

真浏览器端到端（本地起 `server-voice.py` + `serve-preview.py --api-origin` 指到本地，密钥只从 `~/.config/chazi/azure_speech_key` 读）：
- 字头「花」→ `GET /api/tts?text=花&lang=yue&v=2&readings=faa1`
- 组词「花朵」→ `...text=花朵&lang=yue&readings=faa1 do2`
- 纯中文整句「我喜欢花朵」→ 按钮可用并发出带 readings 的请求
- 中英混合「我喜欢flowers花朵」→ token 5 个、粤拼 `ngo5 hei2 fun1 faa1 do2`，整句按钮只念中文部分；第二次点击命中页面缓存不再发请求（预期）
- 普通话/英文请求仍为 `lang=zh|en`，URL 形状未变

CI 新增断言（`check-client.mjs`）：`ttsLang('yue')==='yue'`、未知值仍回 zh、粤语缓存键必须含 readings、同文本不同读法键必须不同、粤语键 ≠ 普通话键、组词卡必须有 `speak(word, yuePlay, "yue")`。
三道门连跑两轮全绿：`check-client` 0、`check-dictionary` 0、`tests/check_voice_backend.py` 16 tests OK；`git diff --check` 干净。README 的粤语小节已改成"文字+音频都可用"并写明两个环境变量与不静默回退的约定。

上线还差：服务器要加 `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`（我没有服务器入口）；F0 为 20 请求/分钟、0.5M 字符/月；改动仍未 commit、未部署。

## 29. 发音改成"读法条"，§28 的 `.yue-spk`/`.wyue-spk` 已作废（2026-10-07）

前提修正：终端用户是 7 岁小孩。据此砍掉本会话上一版方案里的"三个按钮"——一年级的字表里没有"粤"，文字标签本身是识字门槛；三个一模一样的 🔊 又互相分不出来。

收敛成的模型：**发音跟着词义走**。一次查询归一成一个 anchor（汉字 / 粤拼 / 英文词），三行读法从上到下固定顺序 普 → 粤 → 英，**每行文字自己就是按钮**，行尾一个 🔊 表示"点这里能听"；没数据的行整行不渲染（不用 disabled、不用 title——iPad 没有 hover，"看得见点不动"对小孩是挫败源）。英文行按 §30 的实测暂缓。
布局：拼音留在大字上方（纯显示、无 🔊），读法条放**大字下方**（用户拍板）。

实现：新增共用组件 `readoutRow(lang, text, labelHtml, labelClass, ariaText)`；`#detailYue` 移到大字之后并改成容器；字头与组词卡都改用它；`yueLabel` 的「多读」文字+title 改成 `?` 角标；`yueSentenceButtonEl` 无数据时返回 `null`，两个调用点判空。删除 `.yue-spk/.wyue-spk` 样式与 `[disabled]` 规则。
没动：大字点按=普通话、词卡点按=普通话+记历史、左候选卡圆 🔊=普通话、识别侧三处二值收敛。

真浏览器实测（本地 dev-proxy 8767 + 本地后端 8788）：
- 几何：拼音 top 262 → 大字 337 → 读法条 682；条高 49px、宽 266px 满 hero；组词卡内 179×44，卡高 104→114，`scrollHeight-clientHeight=0` 无溢出。
- 触摸下限：组词卡行先是 34px（低于 44px），抬到 44px 后复测通过。
- 点击路由：字头行→`speak("花","yue")`→`lang=yue&readings=faa1` 200；词卡行→`speak("花朵","yue")`→`readings=faa1 do2` 200，且 `histList` 长度不变（stopPropagation 生效，没连带触发卡片动作）；大字→`lang=zh` 200。
- 无数据分支：`yueReadings` 置空后组词卡 0 行、整句按钮返回 `null`；字头原本仍会渲染（判据是 `row.jp`），已补成同一判据 `yueRow.jp && yueReadings(current)`，两条路径判据一致。
- 混合句详情：胶囊边框把 72px 窄卡撑出 26px 横向滚动条（隔离验证：去掉边框后 26→2），已给 `#mixedDetailHost` 内的行改成无边框居中，复测 `learnOverflowX=0`。

CI：`check-client.mjs` 删掉 `speak(word, yuePlay,"yue")` 源码断言，改成跑真 `readoutRow` + `renderWords`——断言卡内有 `data-lang="yue"` 的行、行内 `class="wyue">fa1 do2<`、点击会 `stopPropagation` 且 `speak` 收到 `("花朵", row, "yue")`、无数据时不渲染死行。三道门全绿（check-client 0、check-dictionary 0、voice backend 16 tests OK）。

## 30. 英文行实测后暂缓：反查能命中但选不出正确的词（2026-10-07）

服务器已带 ECDICT（MIT，`data/english/ecdict.sqlite3`，770,611 行），扫全表 1.3 秒，不需要接新的三方服务。
拿 `char-dict.html` 里 `DICT` 的组词表（3,494 字 / 7,364 个两字以上词）做整词精确反查：
- 命中：5,406 / 7,364 = **73.4%**；其中 **4,519 个（84%）有多个英文候选**。
- 现库只剩 6 列（`id/normalized/word/phonetic/translation/pos/exchange`），`.github/scripts/build-english-dictionary.py:74` 明确丢掉了其余列，**没有词频**，多解时无法排序。
- 两种判据实测选词质量都不可接受：宽松判据给出 警察→Roz、秘密→screcy、朋友→pal、白天→journee；收紧成"该英文词的第一条中文释义正好等于本词 + 单个小写词"后覆盖率降到 47.4%，仍然给出 警察→bobby、高兴→delight、仔细→无。
- 结论：教错词比不教更糟，英文行不做，直到补回词频列（源 CSV 已在 `manifest.json` 里 pin 死 hash，重建成本是分钟级）并对一批结果做人工抽检。

一并砍掉：英文→粤语（要经"英→中释义串→挑词→粤拼"两次推导，且句子级粤拼覆盖率实测只有 25–38%）、单字→英文（多义比词更严重）、SW 全量音频离线（1.08 万个 MP3 ≈ 110MB）。
配额账：3,494 字 + 7,364 词 ≈ 1.08 万次一次性合成，F0 档 20 次/分钟 ≈ 9 小时，字符量约 2 万 / 免费档 50 万。可行解是**服务器端一次性预热写进现有 TTS 缓存目录**（不需要 GPU），客户端零改动、iPad 零存储、之后点按零网络。


## 31. 全网现成方案调研 + 三家粤语引擎盲测裁决（2026-10-12）

**调研口径**：agent-reach 四路（GitHub 搜索、Jina 读文档、HF/npm 取包、厂商官网），候选一律拿回本地用我们自己的表跑命中率，不采信文档自述。

**内容层没有可接入的成品**：Pleco 官方拒绝公开 API，商店只卖装进自家 App 的加载项（真人词音 $4.99、粤拼音色 $9.99、《现代汉语规范词典》$29.99，版权归外研社/商务/OUP）；Arch Chinese 条款明文禁止程序化访问；洪恩/宝宝巴士/悟空无授权入口；标贝/数据堂卖训练数据集不是可播放字库。→ **组词/释义/笔顺这层不能被替换，自建路线成立**。
可白捡的只有开源字段：`theajack/cnchar`（MIT、3,104★、2026-08-02 仍维护）的**结构**列对我们 3,493 个字头覆盖 **3,453 = 98.9%**（左右 1,909 / 上下 849 / 半包围 298 / 独体 251 / 上中下 50 / 左中右 77 / 全包围 14 / 品字 5），这列我们现在没有。它的部首与现表交集 2,450 字、一致 89.7%，不一致几乎全是同一部首两种写法（人/亻、刀/刂、火/灬）→ **只取 struct，radical 不覆盖现表**。它的"释义"是假方案：`cnchar-explain` 包内 0 个汉字、运行时抓 `unpkg.com/cnchar-data@latest/explanation/`，内容是《汉语大词典》式词条（山→山呼/山讳，中位 1,130 字节），不是儿童可读的单字义项。KanjiVG 只覆盖 2,264/3,500 且 们汉图语说读车马鸟鱼风全缺（BY-SA）；字源图库一个无 LICENSE、一个 CC BY-NC-SA；OpenCC `HKPhrases.txt` 89 行全是人名异形 → 普→粤词汇表确实无开放源（与 §改写层已定"句子层不做"一致）。
**普通话逐音节录音库**（备用底本，未接）：我们全表只需 **1,160 个带调音节**（一声 301/二声 230/三声 274/四声 324/轻声 31）。三套现成库命中率：`cnchar-data/voice` **99.3%**（MIT，17MB）、`hugolpz/audio-cmn` 97.2%（README 自述 BY-SA、**仓库无 LICENSE 文件**）、`davinfifield` 96.7%（**Unlicense 公有领域**，34MB）。三家同一音节 md5 互不相同 = 三段独立录音。未做：是否真人、声调是否达标（按 §"声调不由我的 F0 数字裁决"，要耳朵判）。

**Google Cloud TTS 真调用实测**（key 已配、项目 566311513284；本机直连 `texttospeech.googleapis.com` = 000 超时，必须走 Clash 7897）：
- 粤语 `yue-HK-Standard-A` 与普通话 `cmn-CN-Wavenet-A` 的 `<phoneme>` **真生效**：噪声基线（同请求连发两次）Δ0.0000 / 0.0017，`ngan4` vs `ngan2` **Δ0.8322**、`wo3` vs `wo1` **Δ0.8451**。裸字与标对调 Δ0.0000 → 两家默认都已读对，和 §"我"那条结论一致。
- 两处实测坑：① API 侧 `customPronunciations{PHONETIC_ENCODING_PINYIN}` **静默无效**（wo4/wo2/裸字 三者 Δ≤0.0017）→ 只能用 SSML 内联；② **非法粤拼不报错**：`hyn3` 与合法 `hyun3` 返回逐字节相同音频 + HTTP 200 → Azure 那道 400 闸门在 Google 不存在，合法性必须我们自己在送合成前判（我们已有 1,861 音节表，Azure 那次实测线上 0 命中）。
- `yue-HK` 无 Neural2/Studio（直接 400 `Voice does not exist`），只有 Standard-A~D 与 30 个 Chirp3-HD。配额 1,000 请求/分钟（Azure F0 是 20）→ 10,764 条预热从 **9.0 小时** 变单线程 1.8 小时、**并发 8 路约 13 分钟**。计费含 SSML 标签：全量 0.753M（整词单标签）～1.051M（逐字多标签）；免费档 Standard/WaveNet 4M 字符/月、Chirp3-HD 1M/月，超出 $4/1M 与 $30/1M，且要绑账单。

**三家引擎盲测（`doc/test/yue-engine-abx/`，21 题 = 关键 5 + 控制 2 × 甲Azure/乙Google Standard/丙Google Chirp3，42 段同响度归一，判据先写死：关键 5/5 且 控制 2/2）**
他耳朵判分结果：**甲 5/5 + 2/2 PASS、乙 5/5 + 2/2 PASS、丙 4/5 + 2/2 没通过**（丙2 笔 bat1 vs bat3 判"一样"）。控制组三家全对 → 问法成立，分数可用。
- 结论一：**Chirp3-HD 出局**。它音质最贵（$30/1M）但有一道声调没照标签执行，正是教错的风险面。
- 结论二：**Azure 与 Google Standard 在"照不照粤拼读"这项并列**，本轮测的是忠实度不是好听度 → 换不换 Google 不能由这张表决定。剩下的差项是运维账：Google 吞吐 50 倍、同 14 条体积 104KB 对 Azure 168KB（全量约 68MB 对 110MB）、同输入逐字节稳定；Azure 胜在已有 400 闸门、已接进生产、无需再绑一张账单。
- 反向自检：丙只有 1 题失手，样本量下不能断言它系统性差；但**判据是事前写死的 5/5**，我不事后放宽。甲/乙同为 5/5 也不能证明它们"更好听"——那是另一个问题。
- 待拍：要不要再出一轮**好听度三选一**（同一条 银行/公园/重量，甲乙两条，选更像粤语母语者的那条），用它来决定预热走哪家；不做就维持 Azure + 9 小时预热。

## 32. 发音调试台 dev-pron-debug（2026-10-12，本地工具，不进发布物）

`dev-pron-debug.py` + `dev-pron-debug.html`：输入字/词 → 按我们自己的表预填逐字读法（可改）→ 同一条分别喂现网 Azure 与 Google 两种音色，
每行显示 HTTP 码 / 字节 / 耗时 / 缓存 HIT-MISS / 音色名，并列出送出去的 SSML。音频走 `voice_audio` 里**生产同一套** SSML 构造与响度归一，
所以这里听到的等于线上会听到的。只绑 127.0.0.1，密钥只读 `~/.config/chazi/` 下文件、绝不下发给页面。

跑法：`https_proxy=http://127.0.0.1:7897 uv run --with imageio-ffmpeg --python 3.12 python dev-pron-debug.py 8799`
（本机直连 `texttospeech.googleapis.com` 是 000 超时，必须带代理；`voice_audio` 找 ffmpeg 靠 imageio-ffmpeg，系统 Python 没装会报 "FFmpeg 不可用"）。

**这台工具当场测出来的三件事**：
1. 响应头不能放汉字：`BaseHTTPRequestHandler` 按 latin-1 编头，把含汉字的 SSML 塞进 `X-SSML` 会让连接在半截断掉，浏览器只报 "Failed to fetch"，
   而 curl 看着像 200 —— 已改成 `urllib.parse.quote` 后前端解码。
2. 读法不合法时两家行为不同，且这条只能实测：`劝/银 = hyn3` 让 **Azure 回 400**（无响应体），**Google 一律 200 且静默按默认读法发** ——
   缓存里 `gstd-…hyn3…` 与 `gstd-…ngan4…` 两份 MP3 **md5 逐字节相同**（Chirp3 同样）。→ 换 Google 的前提是把合法性判断搬到自己这边，
   工具已内置这道闸门原型：拿 `cantonese-data.js` 现算出**本仓音节表 1,863 个音节**，不在表里的读法在行内标红字，但不拦合成（保留对照）。
3. 按钮语义踩过一次：`三家并排合成` 原先每次都重查表，把用户刚改的读法覆盖掉 → 改成只在输入文字变化时重查，"重新按表填读法"才强制回填。

**门禁**：`check-client` / `check-dictionary` 均 exit=0；后端 `tests/check_voice_backend.py` **16 passed / 1 failed**，
失败的是 `test_real_edge_tts_is_normalized_with_peak_headroom`，与本次改动无关 —— 单跑 `edge_tts.Communicate('我','zh-CN-XiaoxiaoNeural')` 也复现
`WSServerHandshakeError 403 … speech.platform.bing.com`，即**本机这条匿名 websocket 通道当下被微软拒**（HK 服务器出口是否同样要单独验；线上普通话/英文命中磁盘缓存时不受影响）。
