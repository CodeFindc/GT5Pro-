import './style.css';
import { exec, toast as ksuToast, moduleInfo } from 'kernelsu';

/**
 * 默认模块根目录（若 moduleInfo() 可用则动态覆盖）
 */
const DEFAULT_MODDIR = '/data/adb/modules/fengyin';

const MODE_NAMES = {
    powersave: '省电 / 待机',
    standby: '省电 / 待机',
    balance: '日常均衡',
    performance: '游戏性能',
    fast: '极速释放',
    init: '极速释放',
    pedestal: '极速释放'
};

// SM8650 常见核心簇标签映射，用于保留友好描述
const KNOWN_SM8650_LABELS = {
    0: '小核簇 (2x A520)',
    2: '中核簇1 (3x A720)',
    5: '中核簇2 (2x A720)',
    7: '超大核 (1x Cortex-X4)'
};

const state = {
    isKsu: false,
    modDir: DEFAULT_MODDIR,
    socModel: '',
    activeMode: 'balance',
    monitorActive: true,
    monitorTimer: null,
    isPolling: false,
    clusters: [],
    mockFrequencies: {
        0: 1200000,
        2: 1800000,
        5: 1900000,
        7: 2200000
    }
};

const dom = {
    envDot: document.querySelector('.env-dot'),
    envText: document.getElementById('env-text'),
    modelBadge: document.getElementById('model-badge'),
    socBadge: document.getElementById('soc-badge'),
    moduleVersion: document.getElementById('module-version'),
    currentModeText: document.getElementById('current-mode-text'),
    batteryLevel: document.getElementById('battery-level'),
    batteryTemp: document.getElementById('battery-temp'),
    clusterBoard: document.getElementById('cluster-board'),
    btnToggleMonitor: document.getElementById('btn-toggle-monitor'),
    monitorIcon: document.getElementById('monitor-icon'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    themeIcon: document.getElementById('theme-icon'),
    liveIndicator: document.getElementById('live-indicator'),
    btnReinit: document.getElementById('btn-reinit'),
    btnLockcheck: document.getElementById('btn-lockcheck'),
    toastContainer: document.getElementById('toast-container'),
    modeCards: {
        powersave: document.getElementById('card-powersave'),
        balance: document.getElementById('card-balance'),
        performance: document.getElementById('card-performance'),
        fast: document.getElementById('card-fast')
    }
};

/* --------------------------------------------------------------------------
 * 1. KernelSU exec 桥接与浏览器 Mock 降级
 * -------------------------------------------------------------------------- */

function detectKsuEnvironment() {
    return typeof window !== 'undefined' && typeof window.ksu !== 'undefined' && typeof window.ksu.exec === 'function';
}

/**
 * 统一执行 Shell 命令：
 * - 在 KernelSU / APatch / MMRL 中使用官方 kernelsu 的 exec()
 * - 在普通浏览器中自动降级到 Mock，方便离线预览界面
 */
async function execRoot(cmd) {
    if (state.isKsu) {
        try {
            const { errno, stdout, stderr } = await exec(cmd);
            return {
                errno: typeof errno === 'number' ? errno : 0,
                stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
                stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
            };
        } catch (err) {
            console.error('[KernelSU exec error]:', err);
            return { errno: -1, stdout: '', stderr: String(err) };
        }
    }
    return mockExec(cmd);
}

function mockExec(cmd) {
    if (cmd.includes('ro.product.model')) {
        return Promise.resolve({ errno: 0, stdout: 'PJZ110\n', stderr: '' });
    }
    if (cmd.includes('ro.soc.model')) {
        return Promise.resolve({ errno: 0, stdout: 'SM8650\n', stderr: '' });
    }
    if (cmd.includes('power_switch.sh')) {
        const match = cmd.match(/power_switch\.sh\s+(\w+)/);
        if (match && match[1]) {
            state.activeMode = match[1];
        }
        return Promise.resolve({ errno: 0, stdout: 'mode switched', stderr: '' });
    }
    if (cmd.includes('/mode')) {
        return Promise.resolve({ errno: 0, stdout: state.activeMode, stderr: '' });
    }
    if (cmd.includes('__CLUSTER_PROBE__')) {
        return Promise.resolve({
            errno: 0,
            stdout: [
                '0|0 1|460800|2265600',
                '2|2 3 4|499200|3148800',
                '5|5 6|499200|2956800',
                '7|7|480000|3302400'
            ].join('\n'),
            stderr: ''
        });
    }
    if (cmd.includes('__FREQ_POLL__')) {
        const factor = state.activeMode === 'powersave' ? 0.72 : state.activeMode === 'fast' ? 1.15 : 1.0;
        const jitter = () => Math.floor((Math.random() - 0.5) * 150000);
        const lines = [0, 2, 5, 7].map((id) => {
            const val = Math.max(460800, Math.floor(state.mockFrequencies[id] * factor + jitter()));
            return `${id}:${val}`;
        });
        return Promise.resolve({ errno: 0, stdout: lines.join('\n'), stderr: '' });
    }
    if (cmd.includes('__BAT_POLL__')) {
        return Promise.resolve({ errno: 0, stdout: 'CAP:86\nTEMP:335\n', stderr: '' });
    }
    return Promise.resolve({ errno: 0, stdout: 'ok', stderr: '' });
}

function showToast(msg, icon = '✨') {
    if (state.isKsu && typeof window.ksu?.toast === 'function') {
        try {
            ksuToast(msg);
        } catch (_) {}
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 320);
    }, 2200);
}

/* --------------------------------------------------------------------------
 * 2. 设备信息与动态核心簇发现
 * -------------------------------------------------------------------------- */

function resolveModuleDir() {
    if (!state.isKsu) return DEFAULT_MODDIR;
    try {
        if (typeof window.ksu?.moduleInfo === 'function') {
            const raw = moduleInfo();
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed?.moduleDir) return parsed.moduleDir;
            if (parsed?.id) return `/data/adb/modules/${parsed.id}`;
        }
    } catch (_) {}
    return DEFAULT_MODDIR;
}

async function loadDeviceIdentity() {
    // 严格按 kernelsu 标准写法获取机型与芯片平台
    const { errno, stdout } = await execRoot('getprop ro.product.model');
    const model = errno === 0 ? stdout.trim() : '';
    if (model) {
        dom.modelBadge.textContent = model;
        dom.modelBadge.title = model;
    } else {
        const marketRes = await execRoot('getprop ro.vendor.oplus.market.name');
        if (marketRes.errno === 0 && marketRes.stdout.trim()) {
            dom.modelBadge.textContent = marketRes.stdout.trim();
        }
    }

    const socRes = await execRoot('getprop ro.soc.model');
    let soc = socRes.errno === 0 ? socRes.stdout.trim() : '';
    if (!soc) {
        const platformRes = await execRoot('getprop ro.board.platform');
        soc = platformRes.errno === 0 ? platformRes.stdout.trim() : '';
    }
    if (soc) {
        state.socModel = soc;
        dom.socBadge.textContent = soc;
    }

    const verRes = await execRoot(`grep -m1 '^version=' ${state.modDir}/module.prop 2>/dev/null | cut -d= -f2`);
    if (verRes.errno === 0 && verRes.stdout.trim()) {
        dom.moduleVersion.textContent = verRes.stdout.trim();
    }
}

function buildClusterDescription(policyId, cpusStr, isLast) {
    if (state.socModel === 'SM8650' && KNOWN_SM8650_LABELS[policyId]) {
        return KNOWN_SM8650_LABELS[policyId];
    }
    const cpus = cpusStr ? cpusStr.trim().split(/\s+/).filter(Boolean) : [];
    const count = cpus.length || 1;
    const range = cpus.length > 1 ? `CPU ${cpus[0]}-${cpus[cpus.length - 1]}` : `CPU ${cpus[0] ?? policyId}`;
    const tier = policyId === 0 ? '能效簇' : isLast ? '超大核 / 性能簇' : '性能中核簇';
    return `${tier} (${count}核 · ${range})`;
}

/**
 * 动态扫描 /sys/devices/system/cpu/cpufreq/policy*，适配 ColorOS 16 下不同 SoC 拓扑
 */
async function discoverCpuClusters() {
    const probeCmd = [
        '# __CLUSTER_PROBE__',
        'for d in /sys/devices/system/cpu/cpufreq/policy*; do',
        '  [ -d "$d" ] || continue;',
        '  id=${d##*policy};',
        '  cpus=$(cat "$d/related_cpus" 2>/dev/null || cat "$d/affected_cpus" 2>/dev/null || echo "$id");',
        '  minf=$(cat "$d/cpuinfo_min_freq" 2>/dev/null || cat "$d/scaling_min_freq" 2>/dev/null || echo 300000);',
        '  maxf=$(cat "$d/cpuinfo_max_freq" 2>/dev/null || cat "$d/scaling_max_freq" 2>/dev/null || echo 3000000);',
        '  echo "$id|$cpus|$minf|$maxf";',
        'done'
    ].join(' ');

    const { errno, stdout } = await execRoot(probeCmd);
    const parsed = [];

    if (errno === 0 && stdout.trim()) {
        for (const line of stdout.trim().split(/\r?\n/)) {
            const parts = line.split('|');
            if (parts.length < 4) continue;
            const id = Number(parts[0].trim());
            if (Number.isNaN(id)) continue;
            const cpusStr = parts[1].trim();
            const minFreq = Number(parts[2].trim()) || 300000;
            const maxFreq = Number(parts[3].trim()) || 3000000;
            parsed.push({ id, cpusStr, minFreq, maxFreq });
        }
    }

    parsed.sort((a, b) => a.id - b.id);

    if (parsed.length === 0) {
        // 兜底保留 SM8650 默认拓扑，避免空看板
        state.clusters = [
            { id: 0, cpusStr: '0 1', minFreq: 460800, maxFreq: 2265600 },
            { id: 2, cpusStr: '2 3 4', minFreq: 499200, maxFreq: 3148800 },
            { id: 5, cpusStr: '5 6', minFreq: 499200, maxFreq: 2956800 },
            { id: 7, cpusStr: '7', minFreq: 480000, maxFreq: 3302400 }
        ];
    } else {
        state.clusters = parsed;
    }

    renderClusterRows();
}

function renderClusterRows() {
    dom.clusterBoard.innerHTML = '';
    const total = state.clusters.length;

    state.clusters.forEach((cluster, index) => {
        const isLast = index === total - 1 && total > 1;
        const toneIdx = isLast ? 3 : Math.min(index, 2);
        const desc = buildClusterDescription(cluster.id, cluster.cpusStr, isLast);

        const row = document.createElement('div');
        row.className = 'cluster-row';
        row.innerHTML = `
            <div class="cluster-meta">
                <span class="cluster-badge ${isLast ? 'cluster-prime' : ''}">Policy ${cluster.id}</span>
                <span class="cluster-desc">${desc}</span>
            </div>
            <div class="cluster-track-wrap">
                <div class="cluster-progress-bar">
                    <div class="cluster-progress-fill fill-tone-${toneIdx}" id="progress-p${cluster.id}" style="width: 15%;"></div>
                </div>
            </div>
            <div class="cluster-val" id="freq-p${cluster.id}">---- MHz</div>
        `;
        dom.clusterBoard.appendChild(row);

        cluster.freqEl = document.getElementById(`freq-p${cluster.id}`);
        cluster.progressEl = document.getElementById(`progress-p${cluster.id}`);
    });
}

/* --------------------------------------------------------------------------
 * 3. 硬件数据采集（电量 / 温度 / 各核频率）
 * -------------------------------------------------------------------------- */

function formatFreq(freqKHz) {
    if (!freqKHz || Number.isNaN(freqKHz) || freqKHz <= 0) return '---- MHz';
    return `${Math.round(freqKHz / 1000)} MHz`;
}

function calcPercentage(cur, min, max) {
    if (!cur || Number.isNaN(cur) || cur <= 0 || max <= min) return 8;
    const percent = Math.min(100, Math.max(8, ((cur - min) / (max - min)) * 100));
    return Math.round(percent);
}

function normalizeTemperature(raw) {
    if (Number.isNaN(raw) || raw <= -40000) return null;
    if (raw >= 1000) return (raw / 1000).toFixed(1);
    if (raw >= 100) return (raw / 10).toFixed(1);
    return raw.toFixed(1);
}

async function updateCpuFrequencies() {
    if (state.clusters.length === 0) return;

    const policyLoops = state.clusters.map((c) => {
        const cpuIds = c.cpusStr ? c.cpusStr.split(/\s+/).filter(Boolean) : [String(c.id)];
        const fallbackCats = cpuIds
            .map((cid) => `cat /sys/devices/system/cpu/cpu${cid}/cpufreq/scaling_cur_freq 2>/dev/null`)
            .join(' || ');
        return (
            `f=$(cat /sys/devices/system/cpu/cpufreq/policy${c.id}/scaling_cur_freq 2>/dev/null ` +
            `|| cat /sys/devices/system/cpu/cpufreq/policy${c.id}/cpuinfo_cur_freq 2>/dev/null ` +
            `|| ${fallbackCats}); ` +
            `echo "${c.id}:$f"`
        );
    }).join('; ');

    const { errno, stdout } = await execRoot(`# __FREQ_POLL__\n${policyLoops}`);
    if (errno !== 0 && !stdout) return;

    const freqMap = new Map();
    for (const line of stdout.trim().split(/\r?\n/)) {
        const match = line.match(/^(\d+):(\d+)/);
        if (match) {
            freqMap.set(Number(match[1]), Number(match[2]));
        }
    }

    for (const cluster of state.clusters) {
        const freq = freqMap.get(cluster.id);
        if (freq && freq > 0) {
            cluster.freqEl.textContent = formatFreq(freq);
            cluster.progressEl.style.width = `${calcPercentage(freq, cluster.minFreq, cluster.maxFreq)}%`;
        } else {
            cluster.freqEl.textContent = '离线';
            cluster.progressEl.style.width = '0%';
        }
    }
}

async function updateBatteryMetrics() {
    // 电量与温度独立采集，附带 ColorOS / OPLUS bms / thermal_zone / dumpsys 多级回退
    const batCmd = [
        '# __BAT_POLL__',
        'cap=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null || cat /sys/class/power_supply/bms/capacity 2>/dev/null || cat /sys/class/power_supply/oplus_chg/capacity 2>/dev/null);',
        'if [ -z "$cap" ]; then cap=$(dumpsys battery 2>/dev/null | awk \'/level:/{print $2; exit}\'); fi;',
        'temp=$(cat /sys/class/power_supply/battery/temp 2>/dev/null || cat /sys/class/power_supply/bms/temp 2>/dev/null || cat /sys/class/power_supply/battery/batt_temp 2>/dev/null || cat /sys/class/power_supply/oplus_chg/temp 2>/dev/null);',
        'if [ -z "$temp" ]; then',
        '  for tz in /sys/class/thermal/thermal_zone*; do',
        '    t=$(cat "$tz/type" 2>/dev/null);',
        '    case "$t" in *batt*|*battery*|*skin*) temp=$(cat "$tz/temp" 2>/dev/null); [ -n "$temp" ] && break ;; esac;',
        '  done;',
        'fi;',
        'if [ -z "$temp" ]; then temp=$(dumpsys battery 2>/dev/null | awk \'/temperature:/{print $2; exit}\'); fi;',
        'echo "CAP:$cap"; echo "TEMP:$temp"'
    ].join(' ');

    const { stdout } = await execRoot(batCmd);
    if (!stdout) return;

    const capMatch = stdout.match(/CAP:(-?\d+)/);
    if (capMatch) {
        const cap = Number(capMatch[1]);
        if (!Number.isNaN(cap) && cap >= 0 && cap <= 100) {
            dom.batteryLevel.textContent = `${cap}%`;
        }
    }

    const tempMatch = stdout.match(/TEMP:(-?\d+(?:\.\d+)?)/);
    if (tempMatch) {
        const tempStr = normalizeTemperature(Number(tempMatch[1]));
        if (tempStr !== null) {
            dom.batteryTemp.textContent = `${tempStr}°C`;
        }
    }
}

async function updateHardwareMetrics() {
    if (!state.monitorActive || state.isPolling) return;
    state.isPolling = true;
    try {
        await Promise.all([updateCpuFrequencies(), updateBatteryMetrics()]);
    } catch (e) {
        console.warn('Update hardware metrics failed:', e);
    } finally {
        state.isPolling = false;
    }
}

/* --------------------------------------------------------------------------
 * 4. 调度模式同步与用户交互
 * -------------------------------------------------------------------------- */

async function refreshCurrentMode() {
    const { stdout } = await execRoot(
        `cat ${state.modDir}/mode 2>/dev/null || grep -oE "balance|powersave|performance|fast" /data/powercfg.sh 2>/dev/null | head -n 1`
    );
    const cleanMode = (stdout || '').trim();
    if (cleanMode && MODE_NAMES[cleanMode]) {
        state.activeMode = cleanMode;
    }

    Object.entries(dom.modeCards).forEach(([modeKey, cardEl]) => {
        if (!cardEl) return;
        const isMatch =
            state.activeMode === modeKey ||
            (modeKey === 'powersave' && state.activeMode === 'standby') ||
            (modeKey === 'fast' && (state.activeMode === 'init' || state.activeMode === 'pedestal'));

        const statusText = cardEl.querySelector('.mode-status-text');
        if (isMatch) {
            cardEl.classList.add('active');
            if (statusText) statusText.textContent = '当前生效中';
        } else {
            cardEl.classList.remove('active');
            if (statusText) statusText.textContent = '点击切换';
        }
    });

    dom.currentModeText.textContent = MODE_NAMES[state.activeMode] || state.activeMode || '日常均衡';
}

async function switchMode(targetMode) {
    if (!targetMode) return;
    showToast(`正在切换至 [${MODE_NAMES[targetMode] || targetMode}]...`, '⏳');

    const switchCmd = `sh ${state.modDir}/power_switch.sh ${targetMode} || sh /data/powercfg.sh ${targetMode}`;
    const { errno, stderr } = await execRoot(switchCmd);

    if (errno === 0) {
        state.activeMode = targetMode;
        await refreshCurrentMode();
        showToast(`已成功切换至: ${MODE_NAMES[targetMode]}`, '✅');
        setTimeout(updateHardwareMetrics, 300);
    } else {
        showToast(`切换失败: ${stderr || '未知错误'}`, '❌');
    }
}

function toggleMonitor() {
    state.monitorActive = !state.monitorActive;
    if (state.monitorActive) {
        dom.monitorIcon.textContent = '⏸️';
        dom.liveIndicator.style.opacity = '1';
        showToast('实时硬件监控已恢复', '▶️');
        startMonitorLoop();
    } else {
        dom.monitorIcon.textContent = '▶️';
        dom.liveIndicator.style.opacity = '0.4';
        showToast('实时监控已挂起以降低耗电', '⏸️');
        if (state.monitorTimer) clearInterval(state.monitorTimer);
    }
}

function startMonitorLoop() {
    if (state.monitorTimer) clearInterval(state.monitorTimer);
    updateHardwareMetrics();
    state.monitorTimer = setInterval(updateHardwareMetrics, 1500);
}

async function reinitSceneTools() {
    showToast('正在重构 /data/powercfg 接口...', '🔄');
    const res = await execRoot(`sh ${state.modDir}/vtools/init_vtools.sh $(realpath ${state.modDir}/module.prop)`);
    if (res.errno === 0) {
        showToast('Scene 调度接口已成功部署并刷新！', '🎉');
    } else {
        showToast('重新初始化失败，请检查模块路径', '⚠️');
    }
}

async function checkLockStatus() {
    showToast('正在检测 cpuset/walt 权限锁定...', '🔍');
    const res = await execRoot('ls -ld /dev/cpuset/background/cpus /dev/cpuset/top-app/cpus 2>/dev/null');
    if (res.stdout && res.stdout.includes('-r--r--r--')) {
        showToast('权限状态完美: 444 只读防反弹已生效！', '🛡️');
    } else if (res.stdout) {
        showToast('当前节点具备读写权，随时可接收调优指令', 'ℹ️');
    } else {
        showToast('未检测到标准 cpuset 节点或处于调试环境', '🔔');
    }
}

/* --------------------------------------------------------------------------
 * 5. 主题切换（白灰 / 暗夜）与初始化入口
 * -------------------------------------------------------------------------- */

function applyTheme(theme) {
    const isLight = theme === 'light';
    if (isLight) {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    if (dom.themeIcon) {
        dom.themeIcon.textContent = isLight ? '☀️' : '🌙';
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
        metaTheme.setAttribute('content', isLight ? '#eceef2' : '#08090c');
    }
}

function initTheme() {
    let saved = 'dark';
    try {
        saved = localStorage.getItem('fengyin_theme') || 'dark';
    } catch (_) {}
    applyTheme(saved);
}

function toggleTheme() {
    const isCurrentlyLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isCurrentlyLight ? 'dark' : 'light';
    applyTheme(next);
    try {
        localStorage.setItem('fengyin_theme', next);
    } catch (_) {}
    showToast(next === 'light' ? '已切换至白灰主题' : '已切换至暗夜主题', next === 'light' ? '☀️' : '🌙');
}

async function init() {
    initTheme();
    state.isKsu = detectKsuEnvironment();
    state.modDir = resolveModuleDir();

    if (state.isKsu) {
        dom.envDot.classList.add('online');
        dom.envText.textContent = 'KernelSU 已连接';
    } else {
        dom.envText.textContent = '浏览器预览 (Mock)';
    }

    Object.entries(dom.modeCards).forEach(([modeKey, cardEl]) => {
        if (!cardEl) return;
        cardEl.addEventListener('click', () => switchMode(modeKey));
    });

    if (dom.btnThemeToggle) {
        dom.btnThemeToggle.addEventListener('click', toggleTheme);
    }
    dom.btnToggleMonitor.addEventListener('click', toggleMonitor);
    dom.btnReinit.addEventListener('click', reinitSceneTools);
    dom.btnLockcheck.addEventListener('click', checkLockStatus);

    await loadDeviceIdentity();
    await discoverCpuClusters();
    await refreshCurrentMode();
    startMonitorLoop();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
