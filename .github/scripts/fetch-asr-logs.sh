#!/usr/bin/env bash
# 拉取最近的语音识别日志（手动触发，用于分析错例）
# 注意：grep 必须用 -F 固定字符串，"[asr]" 在正则里是字符类会误匹配
journalctl -u chazi-voice --since "7 days ago" --no-pager 2>/dev/null | grep -F "[asr]" | grep -v "就绪" | tail -80
