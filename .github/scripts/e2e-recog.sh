#!/usr/bin/env bash
# 识别 E2E（在 GitHub runner 上跑）：
#   edge-tts 合成真实中文语音（短/长/同音/数字/小音量）→ ffmpeg 转 16k WAV
#   → scp 到服务器 → 服务器本地 POST /api/asr → 回传结果 → 逐条对比 PASS/FAIL
set -eu

SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i ~/.ssh/e2e_key -p ${SSH_PORT:-22}"
SCP="scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i ~/.ssh/e2e_key -P ${SSH_PORT:-22}"

printf '%s\n' "$SSH_KEY" > ~/.ssh/e2e_key
chmod 600 ~/.ssh/e2e_key

cd /tmp && mkdir -p e2e-recog && cd e2e-recog
python3 -m venv venv
./venv/bin/pip -q install edge-tts >/dev/null

gen() {  # gen <name> <text>
  ./venv/bin/edge-tts --voice zh-CN-XiaoxiaoNeural --text "$2" --write-media "$1.mp3"
  ffmpeg -y -loglevel error -i "$1.mp3" -ar 16000 -ac 1 -sample_fmt s16 "$1.wav"
  echo "  生成 $1.wav: $2"
}

echo "== 1) 合成测试语音 =="
gen t01_danzi      "天"
gen t02_deyi       "吃饭的饭"
gen t03_chang      "天空飘过一朵白云"
gen t04_chang2     "我今天在学校学到了很多新字"
gen t05_sige       "四个苹果"
gen t06_shige      "十个手指"
gen t07_mama       "妈妈"
gen t08_shiqing    "事情"
gen t09_zenme      "我想查这个字怎么写"
gen t10_shifou     "是不是"
# 小音量版（模拟孩子小声说话）：降到 15%
ffmpeg -y -loglevel error -i t03_chang.wav -af volume=0.15 t11_quiet.wav
echo "  生成 t11_quiet.wav: 天空飘过一朵白云（音量15%）"

echo "== 2) 上传服务器 =="
$SSH "$SSH_USER@$SSH_HOST" "mkdir -p /tmp/chazi-e2e"
$SCP t*.wav "$SSH_USER@$SSH_HOST:/tmp/chazi-e2e/"

echo "== 3) 服务器本地逐条识别 =="
$SSH "$SSH_USER@$SSH_HOST" 'for f in /tmp/chazi-e2e/t*.wav; do
  resp=$(curl -s --max-time 30 -X POST -H "Content-Type: audio/wav" --data-binary @"$f" http://127.0.0.1:5001/api/asr || echo "{\"error\":\"curl失败\"}")
  echo "$(basename $f .wav)|$resp"
done' > results.txt
cat results.txt

echo "== 4) 对比 =="
python3 - <<'PY'
expected = {
  "t01_danzi": "天", "t02_deyi": "吃饭的饭", "t03_chang": "天空飘过一朵白云",
  "t04_chang2": "我今天在学校学到了很多新字", "t05_sige": "四个苹果",
  "t06_shige": "十个手指", "t07_mama": "妈妈", "t08_shiqing": "事情",
  "t09_zenme": "我想查这个字怎么写", "t10_shifou": "是不是",
  "t11_quiet": "天空飘过一朵白云",
}
import json
ok = fail = 0
for line in open("results.txt"):
    line = line.strip()
    if "|" not in line: continue
    name, _, raw = line.partition("|")
    try: d = json.loads(raw)
    except Exception: d = {"text": "", "provider": "解析失败"}
    got = d.get("text", "")
    exp = expected.get(name, "?")
    passed = got == exp
    ok += passed; fail += not passed
    mark = "✅" if passed else "❌"
    print(f"{mark} {name:14s} 期望「{exp}」 实际「{got}」 引擎={d.get('provider','?')}")
print(f"\n结果：{ok} 通过 / {fail} 失败 / 共 {ok+fail}")
PY

echo "== 5) 引擎耗时日志 =="
$SSH "$SSH_USER@$SSH_HOST" "journalctl -u chazi-voice --since '3 minutes ago' --no-pager | grep -F '[asr]' | grep -v 就绪 | tail -15" || true
