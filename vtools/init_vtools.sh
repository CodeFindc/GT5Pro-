#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 外部交互环境初始化脚本
# 文件: vtools/init_vtools.sh
# 作用: 为 Scene、嘟嘟桌面、搞机助手等 Android 调度控制器部署通用交互标准接口:
#       1. 生成 /data/powercfg.json (声明调度名称、作者、特性与控制入口)
#       2. 生成 /data/powercfg.sh (外部切换调度模式时执行的桥接脚本)
# 参数:
#   $1 - module.prop 的绝对物理路径
# ==============================================================================

# 计算模块根目录路径 (vtools 的上一级目录)
MODDIR=$(realpath ${0%/*}/../)

# 获取当前 vtools 目录的绝对路径
BASEDIR="$(dirname $(readlink -f "$0"))"

# ------------------------------------------------------------------------------
# 1. 生成并导出 /data/powercfg.json 元数据文件
# ------------------------------------------------------------------------------
# 调用 gen_json.sh，根据 module.prop 拼装好标准 JSON 字符串 ($json)
source $BASEDIR/gen_json.sh $1

# 写入至系统公共数据分区 /data/powercfg.json，供 Scene 读取识别
echo "$json" >/data/powercfg.json

# ------------------------------------------------------------------------------
# 2. 部署并动态配置 /data/powercfg.sh 入口脚本
# ------------------------------------------------------------------------------
# 复制模板脚本 powercfg.sh 至 /data/ 目录下
cp -af $BASEDIR/powercfg.sh /data/powercfg.sh

# 在 /data/powercfg.sh 的第 3 行动态插入执行实际切换主脚本的后台命令:
# 即调用: sh <MODDIR>/power_switch.sh $1 &
sed -i "3i\sh $MODDIR/power_switch.sh \$1 &" /data/powercfg.sh

# 赋予可执行权限 (rwxr-xr-x)
chmod 755 /data/powercfg.sh
