#!/system/bin/sh
# ==============================================================================
# 风吟调度 (Fengyin Governor) - 调度元数据 JSON 构造器
# 文件: vtools/gen_json.sh
# 作用: 解析 module.prop 中的模块版本与编码信息，按照 Android 经典调度扩展规范
#       (Scene / 嘟嘟桌面 powercfg 协议) 构造出包含模块属性的 JSON 字符串变量
# 参数:
#   $1 - module.prop 的物理绝对路径 ($propPath)
# 输出:
#   环境变量 $json (供调用方直接写入文件)
# ==============================================================================

# 接收传入的 module.prop 文件路径
propPath=$1

# 提取当前模块的可读版本号 (如 v8.1)
version=$(cat $propPath | grep "version=" | cut -d "=" -f2)

# 提取模块版本代号整数 (如 81)
versionCode=$(cat $propPath | grep "versionCode=" | cut -d "=" -f2)

# ------------------------------------------------------------------------------
# 构造 Scene 规范的 powercfg.json 结构
# 字段说明:
#   name        : 调度在前端中显示的名称
#   author      : 开发者/作者署名
#   version     : 版本描述
#   versionCode : 版本数字代号
#   features    : 特性开关
#     strict    : 是否支持严格模式 (false)
#     pedestal  : 是否包含底座模式支持 (false)
#   module      : 模块唯一标识符 (fengyin)
#   state       : 当前模式状态缓存文件路径 ($MODDIR/mode)
#   entry       : 切换模式执行的入口可执行脚本路径 (/data/powercfg.sh)
# ------------------------------------------------------------------------------
json=$(
	cat <<EOF
{
    "name": "风吟调度",
    "author": "爱吃香菜",
    "version": "$version",
    "versionCode": ${versionCode},
    "features": {
        "strict": false,
        "pedestal": false
    },
    "module": "fengyin",
    "state": "$MODDIR/mode",
    "entry": "/data/powercfg.sh",
    "projectUrl": ""
}
EOF
)
