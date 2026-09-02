#!/usr/bin/env bash
# 拉取最近的语音识别日志（手动触发，用于分析错例）
journalctl -u chazi-voice --since "3 days ago" --no-pager 2>/dev/null | grep "[asr]" | tail -60
