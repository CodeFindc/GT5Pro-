/**
 * ==============================================================================
 * 风吟调度 (Fengyin Governor) - WebUI 核心控制逻辑
 * 文件: webroot/app.js
 * 核心机制:
 *   1. 原生桥接 KernelSU / APatch / MMRL (window.ksu.exec & window.ksu.toast)
 *   2. 支持离线独立运行，并在普通浏览器环境下提供无缝 Mock 交互预览
 *   3. 模式切换、状态持久化读取、SM8650 CPU 四大簇频率监控与电池能效展示
 * ==============================================================================
 */

(function () {
    "use strict";

    // 默认模块物理绝对路径 (KernelSU 标准模块目录)
    const MODDIR = "/data/adb/modules/fengyin";

    // SM8650 各核心簇频率极值规格 (用于进度条百分比换算)
    const CLUSTER_SPECS = {
        p0: { maxFreq: 2265600, minFreq: 460800 },  // 小核簇 (Cortex-A520)
        p2: { maxFreq: 3148800, minFreq: 499200 },  // 中核簇1 (Cortex-A720)
        p5: { maxFreq: 2956800, minFreq: 499200 },  // 中核簇2 (Cortex-A720)
        p7: { maxFreq: 3302400, minFreq: 480000 }   // 超大核 (Cortex-X4)
    };

    // 模式映射字典
    const MODE_NAMES = {
        "powersave": "省电 / 待机",
        "standby": "省电 / 待机",
        "balance": "日常均衡",
        "performance": "游戏性能",
        "fast": "极速释放",
        "init": "极速释放",
        "pedestal": "极速释放"
    };

    // 全局状态管理
    const state = {
        isKsu: false,
        activeMode: "balance",
        monitorActive: true,
        monitorTimer: null,
        mockFrequencies: {
            p0: 1200000,
            p2: 1800000,
            p5: 1900000,
            p7: 2200000
        },
        battery: {
            level: 85,
            temp: 34.2
        }
    };

    // DOM 元素缓存
    const dom = {
        envDot: document.querySelector(".env-dot"),
        envText: document.getElementById("env-text"),
        socBadge: document.getElementById("soc-badge"),
        currentModeText: document.getElementById("current-mode-text"),
        batteryLevel: document.getElementById("battery-level"),
        batteryTemp: document.getElementById("battery-temp"),
        btnToggleMonitor: document.getElementById("btn-toggle-monitor"),
        monitorIcon: document.getElementById("monitor-icon"),
        liveIndicator: document.getElementById("live-indicator"),
        btnReinit: document.getElementById("btn-reinit"),
        btnLockcheck: document.getElementById("btn-lockcheck"),
        toastContainer: document.getElementById("toast-container"),
        freqP0: document.getElementById("freq-p0"),
        freqP2: document.getElementById("freq-p2"),
        freqP5: document.getElementById("freq-p5"),
        freqP7: document.getElementById("freq-p7"),
        progressP0: document.getElementById("progress-p0"),
        progressP2: document.getElementById("progress-p2"),
        progressP5: document.getElementById("progress-p5"),
        progressP7: document.getElementById("progress-p7"),
        modeCards: {
            powersave: document.getElementById("card-powersave"),
            balance: document.getElementById("card-balance"),
            performance: document.getElementById("card-performance"),
            fast: document.getElementById("card-fast")
        }
    };

    /* --------------------------------------------------------------------------
     * 1. 底层 Shell 执行与 KernelSU 桥接封装
     * -------------------------------------------------------------------------- */

    /**
     * 检测并执行 Root 指令
     * @param {string} cmd 待执行的 Shell 命令
     * @returns {Promise<{errno: number, stdout: string, stderr: string}>}
     */
    async function execRoot(cmd) {
        if (state.isKsu && window.ksu && typeof window.ksu.exec === "function") {
            try {
                const res = window.ksu.exec(cmd);
                if (res instanceof Promise) {
                    return await res;
                } else if (typeof res === "string") {
                    return { errno: 0, stdout: res, stderr: "" };
                } else if (res && typeof res === "object") {
                    return res;
                }
            } catch (err) {
                console.error("[KernelSU exec error]:", err);
                return { errno: -1, stdout: "", stderr: String(err) };
            }
        }

        // 浏览器调试环境降级：返回 Mock 结果
        return mockExec(cmd);
    }

    /**
     * 模拟执行器 (用于桌面/移动端普通浏览器无 KernelSU 环境调试)
     */
    function mockExec(cmd) {
        console.log("[Mock Shell Exec]:", cmd);
        if (cmd.includes("power_switch.sh")) {
            const match = cmd.match(/power_switch\.sh\s+(\w+)/);
            if (match && match[1]) {
                state.activeMode = match[1];
            }
            return Promise.resolve({ errno: 0, stdout: "mode switched", stderr: "" });
        }
        if (cmd.includes("/mode")) {
            return Promise.resolve({ errno: 0, stdout: state.activeMode, stderr: "" });
        }
        if (cmd.includes("scaling_cur_freq") || cmd.includes("cpuinfo_cur_freq")) {
            // 生成贴近当前模式的随机频点
            const factor = state.activeMode === "powersave" ? 0.7 : state.activeMode === "fast" ? 1.2 : 1.0;
            const jitter = () => Math.floor((Math.random() - 0.5) * 150000);
            return Promise.resolve({
                errno: 0,
                stdout: `${Math.floor(state.mockFrequencies.p0 * factor + jitter())}\n${Math.floor(state.mockFrequencies.p2 * factor + jitter())}\n${Math.floor(state.mockFrequencies.p5 * factor + jitter())}\n${Math.floor(state.mockFrequencies.p7 * factor + jitter())}`,
                stderr: ""
            });
        }
        if (cmd.includes("battery/capacity")) {
            return Promise.resolve({ errno: 0, stdout: "86", stderr: "" });
        }
        if (cmd.includes("battery/temp")) {
            return Promise.resolve({ errno: 0, stdout: "335", stderr: "" }); // 33.5°C
        }
        if (cmd.includes("ro.soc.model")) {
            return Promise.resolve({ errno: 0, stdout: "SM8650", stderr: "" });
        }
        return Promise.resolve({ errno: 0, stdout: "ok", stderr: "" });
    }

    /**
     * 弹出浮动气泡提示 (同时适配原生 ksu.toast 与 UI 液态玻璃 Toast)
     */
    function showToast(msg, icon = "✨") {
        if (state.isKsu && window.ksu && typeof window.ksu.toast === "function") {
            try {
                window.ksu.toast(msg);
            } catch (_) {}
        }

        const toast = document.createElement("div");
        toast.className = "toast";
        toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
        dom.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add("toast-out");
            setTimeout(() => toast.remove(), 320);
        }, 2200);
    }

    /* --------------------------------------------------------------------------
     * 2. 界面数据刷新与硬件状态呈现
     * -------------------------------------------------------------------------- */

    /**
     * 格式化频率为可读文本
     */
    function formatFreq(freqKHz) {
        if (!freqKHz || isNaN(freqKHz) || freqKHz <= 0) return "---- MHz";
        const mhz = Math.round(freqKHz / 1000);
        return `${mhz} MHz`;
    }

    /**
     * 计算频率进度条百分比
     */
    function calcPercentage(cur, min, max) {
        if (!cur || isNaN(cur)) return 15;
        const percent = Math.min(100, Math.max(10, ((cur - min) / (max - min)) * 100));
        return Math.round(percent);
    }

    /**
     * 读取并刷新当前生效的模式
     */
    async function refreshCurrentMode() {
        const { stdout } = await execRoot(`cat ${MODDIR}/mode 2>/dev/null || cat /data/powercfg.sh | grep -oE "balance|powersave|performance|fast" | head -n 1`);
        const cleanMode = (stdout || "").trim();
        if (cleanMode && MODE_NAMES[cleanMode]) {
            state.activeMode = cleanMode;
        }

        // 更新各卡片高亮
        Object.entries(dom.modeCards).forEach(([modeKey, cardEl]) => {
            if (!cardEl) return;
            const isMatch = (state.activeMode === modeKey) ||
                (modeKey === "powersave" && state.activeMode === "standby") ||
                (modeKey === "fast" && (state.activeMode === "init" || state.activeMode === "pedestal"));

            if (isMatch) {
                cardEl.classList.add("active");
                const statusText = cardEl.querySelector(".mode-status-text");
                if (statusText) statusText.textContent = "当前生效中";
            } else {
                cardEl.classList.remove("active");
                const statusText = cardEl.querySelector(".mode-status-text");
                if (statusText) statusText.textContent = "点击切换";
            }
        });

        // 更新顶栏模式文本
        dom.currentModeText.textContent = MODE_NAMES[state.activeMode] || state.activeMode || "日常均衡";
    }

    /**
     * 轮询刷新 CPU 核心频率与电池看板
     */
    async function updateHardwareMetrics() {
        if (!state.monitorActive) return;

        try {
            // 批量查询各 cluster 当前频率
            const freqCmd = `cat /sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq 2>/dev/null || cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq; ` +
                            `cat /sys/devices/system/cpu/cpufreq/policy2/scaling_cur_freq 2>/dev/null || cat /sys/devices/system/cpu/cpu2/cpufreq/cpuinfo_cur_freq; ` +
                            `cat /sys/devices/system/cpu/cpufreq/policy5/scaling_cur_freq 2>/dev/null || cat /sys/devices/system/cpu/cpu5/cpufreq/cpuinfo_cur_freq; ` +
                            `cat /sys/devices/system/cpu/cpufreq/policy7/scaling_cur_freq 2>/dev/null || cat /sys/devices/system/cpu/cpu7/cpufreq/cpuinfo_cur_freq;`;

            const freqRes = await execRoot(freqCmd);
            const lines = (freqRes.stdout || "").trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);

            if (lines.length >= 4) {
                const [f0, f2, f5, f7] = lines;
                // 更新文字
                dom.freqP0.textContent = formatFreq(f0);
                dom.freqP2.textContent = formatFreq(f2);
                dom.freqP5.textContent = formatFreq(f5);
                dom.freqP7.textContent = formatFreq(f7);

                // 更新进度条
                dom.progressP0.style.width = `${calcPercentage(f0, CLUSTER_SPECS.p0.minFreq, CLUSTER_SPECS.p0.maxFreq)}%`;
                dom.progressP2.style.width = `${calcPercentage(f2, CLUSTER_SPECS.p2.minFreq, CLUSTER_SPECS.p2.maxFreq)}%`;
                dom.progressP5.style.width = `${calcPercentage(f5, CLUSTER_SPECS.p5.minFreq, CLUSTER_SPECS.p5.maxFreq)}%`;
                dom.progressP7.style.width = `${calcPercentage(f7, CLUSTER_SPECS.p7.minFreq, CLUSTER_SPECS.p7.maxFreq)}%`;
            }

            // 查询电池电量与温度
            const batRes = await execRoot("cat /sys/class/power_supply/battery/capacity 2>/dev/null; cat /sys/class/power_supply/battery/temp 2>/dev/null");
            const batLines = (batRes.stdout || "").trim().split(/\s+/).map(Number);
            if (batLines.length >= 2) {
                const [cap, tempRaw] = batLines;
                if (!isNaN(cap) && cap > 0) dom.batteryLevel.textContent = `${cap}%`;
                if (!isNaN(tempRaw) && tempRaw > 0) {
                    const temp = tempRaw > 100 ? (tempRaw / 10).toFixed(1) : tempRaw.toFixed(1);
                    dom.batteryTemp.textContent = `${temp}°C`;
                }
            }
        } catch (e) {
            console.warn("Update hardware metrics failed:", e);
        }
    }

    /* --------------------------------------------------------------------------
     * 3. 用户交互事件绑定
     * -------------------------------------------------------------------------- */

    /**
     * 切换调度模式
     */
    async function switchMode(targetMode) {
        if (!targetMode) return;
        showToast(`正在切换至 [${MODE_NAMES[targetMode] || targetMode}]...`, "⏳");

        // 调用模块的 power_switch.sh 执行切换
        const switchCmd = `sh ${MODDIR}/power_switch.sh ${targetMode} || sh /data/powercfg.sh ${targetMode}`;
        const { errno, stderr } = await execRoot(switchCmd);

        if (errno === 0) {
            state.activeMode = targetMode;
            await refreshCurrentMode();
            showToast(`已成功切换至: ${MODE_NAMES[targetMode]}`, "✅");
            // 立即刷新硬件响应
            setTimeout(updateHardwareMetrics, 300);
        } else {
            showToast(`切换失败: ${stderr || "未知错误"}`, "❌");
        }
    }

    /**
     * 启动/暂停监控定时器
     */
    function toggleMonitor() {
        state.monitorActive = !state.monitorActive;
        if (state.monitorActive) {
            dom.monitorIcon.textContent = "⏸️";
            dom.liveIndicator.style.opacity = "1";
            showToast("实时硬件监控已恢复", "▶️");
            startMonitorLoop();
        } else {
            dom.monitorIcon.textContent = "▶️";
            dom.liveIndicator.style.opacity = "0.4";
            showToast("实时监控已挂起以降低耗电", "⏸️");
            if (state.monitorTimer) clearInterval(state.monitorTimer);
        }
    }

    function startMonitorLoop() {
        if (state.monitorTimer) clearInterval(state.monitorTimer);
        updateHardwareMetrics();
        state.monitorTimer = setInterval(updateHardwareMetrics, 1500);
    }

    /**
     * 重新初始化 Scene 调度接口
     */
    async function reinitSceneTools() {
        showToast("正在重构 /data/powercfg 接口...", "🔄");
        const res = await execRoot(`sh ${MODDIR}/vtools/init_vtools.sh $(realpath ${MODDIR}/module.prop)`);
        if (res.errno === 0) {
            showToast("Scene 调度接口已成功部署并刷新！", "🎉");
        } else {
            showToast("重新初始化失败，请检查模块路径", "⚠️");
        }
    }

    /**
     * 检查节点权限锁定状态
     */
    async function checkLockStatus() {
        showToast("正在检测 cpuset/walt 权限锁定...", "🔍");
        const res = await execRoot("ls -ld /dev/cpuset/background/cpus /dev/cpuset/top-app/cpus 2>/dev/null");
        if (res.stdout && res.stdout.includes("-r--r--r--")) {
            showToast("权限状态完美: 444 只读防反弹已生效！", "🛡️");
        } else if (res.stdout) {
            showToast("当前节点具备读写权，随时可接收调优指令", "ℹ️");
        } else {
            showToast("未检测到标准 cpuset 节点或处于调试环境", "🔔");
        }
    }

    /* --------------------------------------------------------------------------
     * 4. 初始化流程
     * -------------------------------------------------------------------------- */
    async function init() {
        // 检测是否在真实 KernelSU / APatch 环境下
        state.isKsu = Boolean(window.ksu && typeof window.ksu.exec === "function");

        if (state.isKsu) {
            dom.envDot.classList.add("online");
            dom.envText.textContent = "KernelSU 已连接";
        } else {
            dom.envText.textContent = "浏览器预览 (Mock)";
        }

        // 读取设备 SoC 型号
        const socRes = await execRoot("getprop ro.soc.model 2>/dev/null");
        const detectedSoc = (socRes.stdout || "").trim();
        if (detectedSoc) {
            dom.socBadge.textContent = detectedSoc;
        }

        // 绑定模式卡片点击事件
        Object.entries(dom.modeCards).forEach(([modeKey, cardEl]) => {
            if (!cardEl) return;
            cardEl.addEventListener("click", () => switchMode(modeKey));
        });

        // 绑定工具按钮
        dom.btnToggleMonitor.addEventListener("click", toggleMonitor);
        dom.btnReinit.addEventListener("click", reinitSceneTools);
        dom.btnLockcheck.addEventListener("click", checkLockStatus);

        // 初始化模式高亮与数据轮询
        await refreshCurrentMode();
        startMonitorLoop();
    }

    // 页面加载完成后立即启动
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
