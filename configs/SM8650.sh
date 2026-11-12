#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 高通第三代骁龙 8 (SM8650) 专属参数矩阵配置
# 架构说明 (Qualcomm Snapdragon 8 Gen 3, 1+5+2 核心拓扑):
#   - Policy 0: 2x Cortex-A520 能效小核 (CPU 0-1)
#   - Policy 2: 3x Cortex-A720 高能效中核 Cluster 1 (CPU 2-4)
#   - Policy 5: 2x Cortex-A720 性能中核 Cluster 2 (CPU 5-6)
#   - Policy 7: 1x Cortex-X4   超大核/旗舰核心 (CPU 7)
#
# 数组索引与模式映射:
#   索引 0: powersave (省电模式)
#   索引 1: balance   (均衡模式)
#   索引 2: perf      (性能模式)
#   索引 3: fast      (极速模式)
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. 核心簇策略与分组定义
# ------------------------------------------------------------------------------
# 对应 /sys/devices/system/cpu/cpufreq/ 下的 policy 目录编号
policy_num=(0 2 5 7)

# 簇遍历索引计数器 (0 -> policy0, 1 -> policy2, 2 -> policy5, 3 -> policy7)
counters=(0 1 2 3) 

# Android cgroup cpuset 进程分组定义 (对应 /dev/cpuset/ 下的分组目录)
cpu_groups=(background system-background foreground top-app)

# ------------------------------------------------------------------------------
# 2. CPU 调速器配置 (Governor)
# 全簇采用高通针对 EAS 优化的 WALT (Window Assisted Load Tracking) 调速器
# ------------------------------------------------------------------------------
cpu_govers=(
    "freq=(walt walt walt walt)" # policy0: 小核簇
    "freq=(walt walt walt walt)" # policy2: 中核簇1
    "freq=(walt walt walt walt)" # policy5: 中核簇2
    "freq=(walt walt walt walt)" # policy7: 超大核簇
)

# ------------------------------------------------------------------------------
# 3. 各簇最小运行频率限制 (scaling_min_freq, 单位: kHz)
# 模式分布: 0:省电 | 1:均衡 | 2:性能 | 3:极速
# ------------------------------------------------------------------------------
min_freqs=(
    "freq=(460800 672000 787200 787200)"   # policy0 (小核)
    "freq=(499200 729600 1190400 1075200)" # policy2 (中核1)
    "freq=(499200 614400 960000 960000)"   # policy5 (中核2)
    "freq=(480000 787200 1248000 1248000)" # policy7 (超大核)
)

# ------------------------------------------------------------------------------
# 4. 各簇最高运行频率限制 (scaling_max_freq, 单位: kHz)
# 模式分布: 0:省电 | 1:均衡 | 2:性能 | 3:极速
# ------------------------------------------------------------------------------
max_freqs=(
    "freq=(1459200 1574400 1804800 2265600)" # policy0: 限制小核满频，省电压至 1.45GHz
    "freq=(1708800 2323200 2630400 3148800)" # policy2: 限制中核满频，极速释放至 3.15GHz
    "freq=(1401600 2131200 2438400 2956800)" # policy5: 限制中核满频，极速释放至 2.96GHz
    "freq=(1708800 2380800 2803200 3302400)" # policy7: 限制超大核满频，极速满载至 3.30GHz
)

# ------------------------------------------------------------------------------
# 5. 高速跳转目标频率 (hispeed_freq, 单位: kHz)
# 当核心负载突破阈值时，调度器瞬时跃迁的目标基础频点
# ------------------------------------------------------------------------------
hispeed_freqs=(
    "freq=(0 1344000 1344000 1344000)" # policy0: 省电设为 0 表示不启用单次跃迁，平滑爬升
    "freq=(0 1075200 1612800 1708800)" # policy2
    "freq=(0 1075200 1612800 1708800)" # policy5
    "freq=(0 1248000 1593600 1939200)" # policy7
)

# ------------------------------------------------------------------------------
# 6. 高速跳转负载门限 (hispeed_load, 百分比 0-100)
# 当瞬间计算负载超过此百分比时，立即跳跃至 hispeed_freq
# ------------------------------------------------------------------------------
hispeed_loads=(
    "freq=(90 75 75 80)" # policy0: 省电设 90% 防误唤醒；均衡设 75% 响应日常滑动
    "freq=(90 75 75 80)" # policy2
    "freq=(90 75 75 80)" # policy5
    "freq=(90 75 75 80)" # policy7
)

# ------------------------------------------------------------------------------
# 7. 目标负载曲线 (target_loads, 百分比 0-100)
# 调速器根据当前负载计算目标频点时所依据的稳定负荷基准线
# ------------------------------------------------------------------------------
target_loads=(
    "freq=(80 65 80 80)" # policy0: 均衡设 65% 使小核更积极承载轻度负载
    "freq=(80 75 80 80)" # policy2
    "freq=(80 75 80 80)" # policy5
    "freq=(80 65 80 80)" # policy7
)

# ------------------------------------------------------------------------------
# 8. cgroup cpuset 核心分配规则 (各进程组的核心亲和性拓扑)
# 模式分布: 0:省电 | 1:均衡 | 2:性能 | 3:极速
# ------------------------------------------------------------------------------
cpu_sets=(
    "group=('0-1' '0-1' '0-1' '0-1')"                 # 用户后台进程: 限制在 0-1 小核，彻底杜绝偷跑耗电
    "group=('0-1,5-6' '0-1,5-6' '0-1,5-6' '0-1,5-6')" # 系统后台进程: 允许使用小核与部分中核，保证系统基础服务流畅
    "group=('2-6' '2-6' '2-6' '2-6')"                 # 前台应用进程: 独享 2-6 中核，兼顾帧率稳定与能效比
    "group=('0-7' '0-7' '0-7' '0-7')"                 # 顶层交互进程 (top-app): 开放 0-7 全核心调度
)

# ==============================================================================
# 9. 四大调度模式专属内核微调函数
# 涉及节点说明:
#   target_load_shift : WALT 目标负载偏移量 (越大则升频越保守，越省电)
#   cpu.uclamp.max    : EAS 利用率夹紧上限 (0-100%，压低可直接限制最大算力调用)
#   cpu.uclamp.min    : EAS 利用率夹紧下限 (0-100%，提升可保障关键任务的基础性能底线)
#   boost             : WALT 频率/利用率动态增益百分比 (负值抑制升频，正值积极拉频)
#   up_rate_limit_us  : 升频延迟滤波时间 (微秒，数值越大防误触频繁提频)
#   down_rate_limit_us: 降频保持延迟时间 (微秒，数值越大高频停留越久，防游戏掉帧)
# ==============================================================================

# ------------------------------------------------------------------------------
# powersave_func: 省电 / 待机模式深度微调
# 特性: 激进压低 uclamp 上限，大幅增加升频延迟，强制降频延迟为 0 (迅速回落)
# ------------------------------------------------------------------------------
powersave_func() {
    # 增加负载偏移量至 5，抑制 WALT 轻易升频
    echo "5" > /sys/devices/system/cpu/cpu0/cpufreq/walt/target_load_shift
    echo "5" > /sys/devices/system/cpu/cpu2/cpufreq/walt/target_load_shift
    echo "5" > /sys/devices/system/cpu/cpu5/cpufreq/walt/target_load_shift
    echo "5" > /sys/devices/system/cpu/cpu7/cpufreq/walt/target_load_shift

    # 压制算力夹紧上限: top-app 限制为 65%，前台 60%，后台 50%
    echo "65" > /dev/cpuctl/top-app/cpu.uclamp.max
    echo "60" > /dev/cpuctl/foreground/cpu.uclamp.max
    echo "50" > /dev/cpuctl/background/cpu.uclamp.max
    echo "50" > /dev/cpuctl/system-background/cpu.uclamp.max

    # 移除性能底线保障
    echo "0" > /dev/cpuctl/top-app/cpu.uclamp.min
    echo "0" > /dev/cpuctl/foreground/cpu.uclamp.min

    # 关闭全簇 boost 提频
    echo "0" > /sys/devices/system/cpu/cpu0/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/boost

    # 增大升频滤波时间 (4-5ms)，防止瞬间微小负载触发大核拉高频
    echo "5000" > /sys/devices/system/cpu/cpu0/cpufreq/walt/up_rate_limit_us
    echo "4000" > /sys/devices/system/cpu/cpu2/cpufreq/walt/up_rate_limit_us
    echo "5000" > /sys/devices/system/cpu/cpu5/cpufreq/walt/up_rate_limit_us
    echo "4000" > /sys/devices/system/cpu/cpu7/cpufreq/walt/up_rate_limit_us

    # 降频无延迟 (0us)，负载一旦回落立即迅速降频省电
    echo "0" > /sys/devices/system/cpu/cpu0/cpufreq/walt/down_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/down_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/down_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/down_rate_limit_us
}

# ------------------------------------------------------------------------------
# balance_func: 日常均衡模式深度微调
# 特性: 解锁 top-app 100% 满血算力，施加轻微负 boost 削减冗余发热，保持 500us 降频缓冲防微卡顿
# ------------------------------------------------------------------------------
balance_func() {
    # 负载偏移量设为 2，兼顾响应与功耗
    echo "2" > /sys/devices/system/cpu/cpu0/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu2/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu5/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu7/cpufreq/walt/target_load_shift

    # 释放 top-app 算力至 100%，保证当前焦点应用绝对流畅
    echo "100" > /dev/cpuctl/top-app/cpu.uclamp.max
    echo "80" > /dev/cpuctl/foreground/cpu.uclamp.max
    echo "50" > /dev/cpuctl/background/cpu.uclamp.max
    echo "50" > /dev/cpuctl/system-background/cpu.uclamp.max

    # 给予 20% 基础算力保障，避免 UI 渲染线程掉帧
    echo "20" > /dev/cpuctl/top-app/cpu.uclamp.min
    echo "20" > /dev/cpuctl/foreground/cpu.uclamp.min

    # 施加适度负 boost，抑制轻中负载下的虚高拉频
    echo "-20" > /sys/devices/system/cpu/cpu0/cpufreq/walt/boost
    echo "-10" > /sys/devices/system/cpu/cpu2/cpufreq/walt/boost
    echo "-25" > /sys/devices/system/cpu/cpu5/cpufreq/walt/boost
    echo "-20" > /sys/devices/system/cpu/cpu7/cpufreq/walt/boost

    # 升频延迟收敛至 1000us (1ms)，提供快速触控响应
    echo "1000" > /sys/devices/system/cpu/cpu0/cpufreq/walt/up_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu2/cpufreq/walt/up_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu5/cpufreq/walt/up_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu7/cpufreq/walt/up_rate_limit_us

    # 中大核心给予 500us 降频缓冲，减少连续动画切换时的帧率抖动
    echo "0" > /sys/devices/system/cpu/cpu0/cpufreq/walt/down_rate_limit_us
    echo "500" > /sys/devices/system/cpu/cpu2/cpufreq/walt/down_rate_limit_us
    echo "500" > /sys/devices/system/cpu/cpu5/cpufreq/walt/down_rate_limit_us
    echo "500" > /sys/devices/system/cpu/cpu7/cpufreq/walt/down_rate_limit_us
}

# ------------------------------------------------------------------------------
# performance_func: 游戏性能模式深度微调
# 特性: 提升 uclamp.min 保障至 30%，中大核升频延迟归零 (瞬间起频)，1000us 降频锁频
# ------------------------------------------------------------------------------
performance_func() {
    echo "2" > /sys/devices/system/cpu/cpu0/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu2/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu5/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu7/cpufreq/walt/target_load_shift

    echo "100" > /dev/cpuctl/top-app/cpu.uclamp.max
    echo "80" > /dev/cpuctl/foreground/cpu.uclamp.max
    echo "50" > /dev/cpuctl/background/cpu.uclamp.max
    echo "50" > /dev/cpuctl/system-background/cpu.uclamp.max

    # 提高最小性能底线至 30%，确保团战和复杂渲染不丢帧
    echo "30" > /dev/cpuctl/top-app/cpu.uclamp.min
    echo "30" > /dev/cpuctl/foreground/cpu.uclamp.min

    # 解除中大核心负 boost
    echo "-20" > /sys/devices/system/cpu/cpu0/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/boost

    # 中大核心升频延迟直接置 0，零延迟瞬时拉满频率
    echo "2000" > /sys/devices/system/cpu/cpu0/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/up_rate_limit_us

    # 降频保持延时延长至 1000us (1ms)，维持高频稳定输出
    echo "0" > /sys/devices/system/cpu/cpu0/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu2/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu5/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu7/cpufreq/walt/down_rate_limit_us
}

# ------------------------------------------------------------------------------
# fast_func: 极速 / 极限压榨模式深度微调
# 特性: uclamp.min 保底大幅拉高至 50%，全核升频无等待，降频延长至 1ms
# ------------------------------------------------------------------------------
fast_func() {
    echo "2" > /sys/devices/system/cpu/cpu0/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu2/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu5/cpufreq/walt/target_load_shift
    echo "2" > /sys/devices/system/cpu/cpu7/cpufreq/walt/target_load_shift

    # top-app 与 foreground 均给予 100% 满额算力
    echo "100" > /dev/cpuctl/top-app/cpu.uclamp.max
    echo "100" > /dev/cpuctl/foreground/cpu.uclamp.max
    echo "50" > /dev/cpuctl/background/cpu.uclamp.max
    echo "50" > /dev/cpuctl/system-background/cpu.uclamp.max

    # 暴力保底: 强制所有前台核心无论负载高低，基础利用率不得低于 50%
    echo "50" > /dev/cpuctl/top-app/cpu.uclamp.min
    echo "50" > /dev/cpuctl/foreground/cpu.uclamp.min

    # 全簇 boost 归零，不设负向惩罚
    echo "0" > /sys/devices/system/cpu/cpu0/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/boost
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/boost

    # 中大核无延迟拉满频率
    echo "2000" > /sys/devices/system/cpu/cpu0/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu2/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu5/cpufreq/walt/up_rate_limit_us
    echo "0" > /sys/devices/system/cpu/cpu7/cpufreq/walt/up_rate_limit_us

    # 全核心降频延迟锁在 1000us，死守高频状态
    echo "1000" > /sys/devices/system/cpu/cpu0/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu2/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu5/cpufreq/walt/down_rate_limit_us
    echo "1000" > /sys/devices/system/cpu/cpu7/cpufreq/walt/down_rate_limit_us
}
