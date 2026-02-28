#!/bin/bash

# 死循环执行 ralph-loop
while true; do
    echo "========================================"
    echo "开始新一轮迭代: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================"

    claude --dangerously-skip-permissions "/ralph-loop:ralph-loop \"创建一个优秀的编辑团队来实践工作，阅读 任务目标.md 实现工作,每一个小迭代完毕需要提交代码，持续迭代持续总结经验\" --max-iterations 15"

    EXIT_CODE=$?
    echo "========================================"
    echo "迭代结束，退出码: $EXIT_CODE"
    echo "等待 3 秒后开始下一轮..."
    echo "========================================"

    sleep 3
done
