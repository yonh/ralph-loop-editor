#!/bin/bash

# 默认执行1轮
MAX_ROUNDS=1

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--rounds)
            MAX_ROUNDS="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  -n, --rounds <数量>  指定执行轮次 (默认: 1)"
            echo "  -h, --help           显示此帮助信息"
            echo ""
            echo "示例:"
            echo "  $0              # 执行1轮后退出"
            echo "  $0 -n 5         # 执行5轮后退出"
            echo "  $0 --rounds 10  # 执行10轮后退出"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            echo "使用 -h 或 --help 查看帮助"
            exit 1
            ;;
    esac
done

# 验证参数
if ! [[ "$MAX_ROUNDS" =~ ^[0-9]+$ ]] || [ "$MAX_ROUNDS" -lt 1 ]; then
    echo "错误: 轮次必须是正整数"
    exit 1
fi

echo "========================================"
echo "Ralph Loop 执行器"
echo "计划执行轮次: $MAX_ROUNDS"
echo "========================================"
echo ""

# 计数器
CURRENT_ROUND=0

# 循环执行指定轮次
while [ "$CURRENT_ROUND" -lt "$MAX_ROUNDS" ]; do
    CURRENT_ROUND=$((CURRENT_ROUND + 1))

    echo "========================================"
    echo "第 $CURRENT_ROUND/$MAX_ROUNDS 轮迭代: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================================"

    claude --dangerously-skip-permissions "/ralph-loop:ralph-loop \"创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作,每一个小迭代完毕需要提交代码，持续迭代持续总结经验\" --max-iterations 20"

    EXIT_CODE=$?
    echo "========================================"
    echo "第 $CURRENT_ROUND 轮结束，退出码: $EXIT_CODE"

    # 如果不是最后一轮，等待后继续
    if [ "$CURRENT_ROUND" -lt "$MAX_ROUNDS" ]; then
        echo "等待 3 秒后开始下一轮..."
        echo "========================================"
        sleep 3
        echo ""
    else
        echo "所有轮次执行完毕！"
        echo "========================================"
    fi
done

echo ""
echo "========================================"
echo "执行总结"
echo "总执行轮次: $CURRENT_ROUND"
echo "完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
