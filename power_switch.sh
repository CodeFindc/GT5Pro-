#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 模式切换总执行器
# 文件: power_switch.sh
# 作用: 接收调度切换指令 (如 balance, powersave, performance, fast)，
#       分发并执行具体的 CPU 频率、调速器、核心绑定与内核调优函数
# 调用来源:
#   1. 第三方调度前端 (如 Scene、嘟嘟桌面) 通过 /data/powercfg.sh 传入参数调用
#   2. 用户通过命令行手动执行: sh power_switch.sh <mode_name>
# 支持的入参 ($1):
#   - powersave / standby  : 省电/待机模式 (内部索引 mode=0)
#   - balance              : 日常均衡模式 (内部索引 mode=1)
#   - performance          : 游戏性能模式 (内部索引 mode=2)
#   - init / fast / pedestal : 极速/底座/开机模式 (内部索引 mode=3)
# ==============================================================================

# 获取当前脚本所在绝对目录
MODDIR=${0%/*}

# 导入核心底层工具函数库 (提供 echo_val, lock_val, parse_config, set_speed, set_cpu)
source $MODDIR/vtools/util.sh

# 导入当前 SoC 专属参数配置文件 (安装时由 customize.sh 注入 soc_model 变量)
source $MODDIR/configs/$soc_model.sh # 配置文件选择

# 定义 Linux 内核 cpufreq 策略节点的全局统一路径
policys_path=/sys/devices/system/cpu/cpufreq

# 读取当前生效的模式名称，用于判断是否重复切换
mode=`cat $MODDIR/mode`

# ------------------------------------------------------------------------------
# 模式分发逻辑
# ------------------------------------------------------------------------------
case "$1" in
# 若切换的目标模式与当前已生效模式相同，则直接退出，避免重复下发参数造成开销
$mode)
    exit 0
    ;;

# 1. 均衡模式: 日常使用首选，兼顾续航与流畅体验
"balance")
    mode=1
    set_speed       # 下发均衡模式下的 CPU 频率上下限与调速器基础参数
    set_cpu         # 绑定进程组 CPU 核心亲和性 (cpuset)
    balance_func    # 执行 SM8650 专用的均衡模式 uclamp、walt 升频速率等进阶调优
    ;;

# 0. 省电 / 待机模式: 压低频率与算力上限，延长电池续航
"powersave" | "standby")
    mode=0
    set_speed       # 下发省电模式下的降频限制
    set_cpu         # 限制后台与普通任务在小核运行
    powersave_func  # 激进限制 uclamp 上限，增大 target_load_shift
    ;;

# 2. 性能模式: 游戏与高负载场景，提高最低频与算力底线
"performance")
    mode=2
    set_speed       # 下发高频段与响应更激进的调速器参数
    set_cpu         # 开放更多中大核心算力
    performance_func # 提升 uclamp.min，解除大核升频限制 (up_rate_limit_us=0)
    ;;

# 3. 极速 / 底座 / 初始化模式: 全核算力全开，最大响应速度
"init" | "fast" | "pedestal")
    mode=3
    set_speed       # 解锁全部频率上限
    set_cpu         # 开放全核访问
    fast_func       # 极致响应调优，提供顶格帧率稳定性
    ;;
esac

# ------------------------------------------------------------------------------
# 状态持久化记录
# ------------------------------------------------------------------------------
# 将本次切换成功的模式名称覆写保存到 mode 文件中，作为状态缓存
echo $1 > $MODDIR/mode
