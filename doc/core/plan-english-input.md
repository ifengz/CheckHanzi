# 英文课本取词 · 第一版

用户已确认：孩子看课本时不会读；实现拍课本或选照片、点选英文词、发音、短中文解释和一句中英例句，同时保留手动输入与现有语音。

基线：`d3210d9c2dec0ce2bddc1f5991f041f91397b089`，分支 `yingwenshuru`。
开始时只有未跟踪 `.DS_Store`，保留。

## 范围

- `char-dict.html`：增加英文取词入口，接入现有英文查询控制器。
- `lucide-icons.js`：补充拍照、相册和取消按钮使用的内建图标。
- `english-lookup.js` / `english-lookup.css`：输入与结果展示，原有查询/历史/语音取消规则保留。
- `english-input.js`：选图、图片缩放、本机 OCR、点词、取消和错误提示。
- `data/english-learning.json`：随前端发布的项目编写儿童常用词解释和例句，放在私有 `data/english/` 排除目录之外，缺失明确提示。
- `models/ocr/`：固定版本 Tesseract.js 7.0.0、必要 LSTM WASM、英语模型和完整许可，只按需加载。
- `.github/scripts/check-client.mjs` 和 `.github/scripts/check-english-input.mjs`：调整被新需求替代的纯语音断言，验证输入和取词边界。
- `server-voice.py` / `tests/check_voice_backend.py`：Edge 英文 TTS 失败时，在已配置 Azure 的环境中做最小兜底并验证 SSML 转义。
- `doc/english.md` / `README.md`：更新使用方法与覆盖边界。
- `doc/test/english-input/`：开发 E2E 图片、截图、测量与实际 API/音频证据。

不改：中文查询、ASR、TTS API 合同、数据库；只在发布检查中加入英文输入校验，按用户后续授权整体提交、推送并部署。英文 TTS 只增加已授权的 Azure 兜底，不更换默认 Edge 路径。

## 行为

1. 主页增加一个可点按的「拍照查英文」入口。
2. 英文区提供「拍课本」「选照片」和手动输入，所有入口复用 `/api/english` 与 `/api/tts`。
3. 照片仅在浏览器内识别；只提交孩子点选的词。按需加载英语 OCR。
4. 显示照片缩略图与可点选词；识别错误允许重拍、手动改字，不自动猜词。
5. 图片过大、格式错误、OCR 超时、没有英文等情况明确提示；可取消，旧任务不覆盖新任务。
6. 常用词提供简短中文解释和项目编写的中英例句；其他词保留原词典释义，显示例句尚未收录。
7. 单词与例句都复用现有英文声音；Edge 失败且 Azure 配置存在时，英文改走 Azure 兜底。语音查询、历史返回和中文查字仍可用。

## 验证

- TDD：先证明新入口和图片词提取测试在基线上失败，再实现。
- `node .github/scripts/check-client.mjs`
- `node .github/scripts/check-english-input.mjs`
- `python3 .github/scripts/check-english.py`
- `node .github/scripts/check-dictionary.mjs`
- `python3 tests/check_voice_backend.py`
- `git diff --check`
- Ego Lite 从本地固定入口，用真实图片执行识别、点词、真实词典查询、单词/例句真实音频播放、重拍/空图/坏文件、历史回显和中文查字。
- 1180×820 / 820×1180、deviceScaleFactor 2；100% / 150% 文本缩放；1024×768、1194×834、844×390 不劣化。
- 量文本与图标间隙、所有词卡宽高、横向溢出，保存 JSON 与截图。
- requesting-code-review 审查从本次基线开始的 staged、unstaged、untracked 累计变化。

实体 iPad Safari 的相机菜单、原始课本照片识别质量和儿童单手使用仍需实机验证，不能由 Chromium 仿真代替。

## 发布补充范围

用户授权本仓表情替换为 SVG 图标，并整体提交部署。页面及可编辑设计稿统一图标，文档与服务日志使用文字；保留第三方数据、许可证和历史测试原始证据。发布前跑开发 E2E、独立评审，发布后核对提交号和线上回显。
