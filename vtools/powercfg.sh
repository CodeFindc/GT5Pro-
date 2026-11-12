#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 外部交互入口模板脚本
# 文件: vtools/powercfg.sh
# 作用: 供 init_vtools.sh 复制为 /data/powercfg.sh 的原始模板。
# 说明:
#   初始化时，init_vtools.sh 会动态在第 3 行插入:
#   sh $MODDIR/power_switch.sh $1 &
#   这样外部调度管理器 (如 Scene) 调用 /data/powercfg.sh <mode> 时即可触发真实切换。
# ==============================================================================

# 可选调优: 将执行切换任务的进程绑定到能效小核 (如 CPU1)，避免调度切换瞬间抢占大核
# taskset -p 2 $(pgrep -f power_switch.sh) # CPU1
