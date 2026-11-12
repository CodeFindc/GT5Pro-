#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 核心工具函数库
# 文件: vtools/util.sh
# 作用: 提供底层 sysfs/cpuset 节点读写、权限锁定以及 CPU 频率/调速器策略的批量配置接口
#
# 依赖上下文 (由调用方 power_switch.sh 以及对应的 configs/*.sh 提供):
#   $mode         : 调度模式编号 (0: powersave, 1: balance, 2: performance, 3: fast)
#   $policys_path : CPU cpufreq 根目录 (如 /sys/devices/system/cpu/cpufreq)
#   $policy_num   : 对应各簇的 policy 编号数组 (如 0 2 5 7)
#   $counters     : 策略计数器索引数组 (如 0 1 2 3)
#   $cpu_groups   : Android cgroup cpuset 组别列表 (background, foreground 等)
#   $min_freqs    : 各 policy 最小频率配置数组 (内含各模式 freq 声明)
#   $max_freqs    : 各 policy 最大频率配置数组
#   $cpu_govers   : 各 policy 调速器配置数组
#   $hispeed_freqs: 各 policy 高速跳转频率配置数组
#   $target_loads : 各 policy 目标负载梯度配置数组
#   $hispeed_loads: 各 policy 高速跳转负载门限数组
#   $cpu_sets     : 各 cpuset 核心分配规则数组
# ==============================================================================

# ------------------------------------------------------------------------------
# 函数: echo_val
# 作用: 向指定节点写入配置值，并保持读写权限 (chmod 666)
# 参数:
#   $1 - 待写入的配置数值或字符串
#   $2 - 目标 sysfs/dev 节点路径
# 场景:
#   适用于允许系统级或外部工具后续自由调整的节点 (如 scaling_min_freq, scaling_governor)
# ------------------------------------------------------------------------------
echo_val() {
    chmod 666 $2
    echo "$1" > $2
}

# ------------------------------------------------------------------------------
# 函数: lock_val
# 作用: 写入配置后将节点权限锁死为只读 (chmod 444)
# 参数:
#   $1 - 待写入的配置数值或字符串
#   $2 - 目标 sysfs/dev 节点路径
# 场景:
#   防止 Android 系统后台服务 (如 thermal-engine 温控服务、perfd/perfHAL 性能服务)
#   在运行期间恶意篡改或覆盖模块设置的调优参数 (防反弹机制)
# ------------------------------------------------------------------------------
lock_val() {
    chmod 666 $2
    echo "$1" > $2
    chmod 444 $2
}

# ------------------------------------------------------------------------------
# 函数: parse_config
# 作用: 动态解析传入的配置语句数组，并根据当前模式 $mode 路由写入目标节点
# 参数:
#   $@ - 一组包含变量赋值的字符串 (例如 "freq=(460800 672000 787200 787200)")
# 逻辑:
#   1. 通过 eval $tmp 动态还原局部数组 freq
#   2. 若目标为 min/max 频率，通过 echo_val 写入当前模式 freq[$mode]
#   3. 若目标为 scaling_governor，更新全局变量 cpu_gover 并通过 echo_val 下发
#   4. 若为调速器专属算法参数 (hispeed_freq/target_loads 等)，通过 lock_val 写入并锁定只读
# ------------------------------------------------------------------------------
parse_config() {    
    for tmp in "$@"
    do
        eval $tmp
        if [[ $path = scaling_min_freq || $path = scaling_max_freq ]]; then
            echo_val "${freq[$mode]}" $policys_path/policy${policy_num[$counter]}/$path
        elif [[ $path = scaling_governor ]]; then
            cpu_gover=${freq[$mode]}
            echo_val $cpu_gover $policys_path/policy${policy_num[$counter]}/$path
        else
            lock_val "${freq[$mode]}" $policys_path/policy${policy_num[$counter]}/$path
        fi
    done
}

# ------------------------------------------------------------------------------
# 函数: set_speed
# 作用: 遍历所有 CPU 核心簇 (Cluster/Policy)，下发频率范围与调速器算法参数
# 流程:
#   遍历 $counters (如 0, 1, 2, 3，对应 LITTLE / MID / BIG / PRIME 等簇):
#     - scaling_min_freq: 限制最低工作频率
#     - scaling_max_freq: 限制最高工作频率
#     - scaling_governor: 切换调速器 (如 walt / schedutil)
#     - $cpu_gover/hispeed_freq: 升频首选跃迁频率
#     - $cpu_gover/target_loads: 频率调节的目标负载曲线
#     - $cpu_gover/hispeed_load: 触发跃迁至 hispeed_freq 的负载阈值
# ------------------------------------------------------------------------------
set_speed() {
    for counter in ${counters[@]}
    do
        path=scaling_min_freq
        parse_config "${min_freqs[$counter]}"
        
        path=scaling_max_freq
        parse_config "${max_freqs[$counter]}"
        
        path=scaling_governor
        parse_config "${cpu_govers[$counter]}"
        
        path=$cpu_gover/hispeed_freq
        parse_config "${hispeed_freqs[$counter]}"
        
        path=$cpu_gover/target_loads
        parse_config "${target_loads[$counter]}"
        
        path=$cpu_gover/hispeed_load
        parse_config "${hispeed_loads[$counter]}"
    done
}

# ------------------------------------------------------------------------------
# 函数: set_cpu
# 作用: 配置 Android 进程分组的 CPU 核心亲和性绑定 (cpuset 拓扑)
# 流程:
#   遍历 $cpu_sets 配置数组:
#     1. 通过 eval $tmp 动态还原 group 数组 (各模式分配的核心编号如 '0-1', '2-6', '0-7')
#     2. 提取当前模式 group[$mode]，绑定至 /dev/cpuset/${cpu_groups[$counter]}/cpus
#     3. 通过 lock_val 锁定权限 (444)，防止 Android 系统重置进程组的核心绑定
# ------------------------------------------------------------------------------
set_cpu() {
    counter=0
    for tmp in "${cpu_sets[@]}"
    do
        eval $tmp
        lock_val "${group[$mode]}" /dev/cpuset/${cpu_groups[$counter]}/cpus
        ((counter++))
    done
}
