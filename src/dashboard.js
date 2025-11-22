// src/dashboard.js
// ======================================================
// 训练看板（Dashboard）- 双智能体 RL (A / B) 对比专用版
// ======================================================
//
// 功能概述：
//   Dashboard 页面只负责“展示”Arena 页面里双智能体 RL 训练的结果。
//   数据来源是 arena_train.js 在训练过程中写入 localStorage 的
//   'arena_rl_dual_stats' 快照数组。
//
// 本文件主要做了三件事：
//   1. 从 localStorage 读取所有 RL 训练快照，并做一些统计。
//   2. 利用 Chart.js 绘制 3 张折线图：成功率趋势、平均步数 vs 最短步数、epsilon 衰减。
//   3. 在 #statsRlDual 文本区域生成一段可读性较好的“总结说明”。
// ------------------------------------------------------

// 存 RL 训练快照的 localStorage key，需与 arena_train.js 中保持一致
const RL_STATS_KEY = 'arena_rl_dual_stats'

/**
 * 从 localStorage 中读取 JSON 数组。
 * 这是一个小工具函数，封装了 JSON.parse + 异常处理。
 *
 * @param {string} key - localStorage 的键名
 * @returns {Array<any>} - 若不存在或解析失败，则返回空数组
 */
const loadArray = (key) => {
  try {
    // localStorage 中没有该 key 时会返回 null，此处用 '[]' 兜底
    return JSON.parse(localStorage.getItem(key) || '[]') || []
  } catch (e) {
    console.error('解析 localStorage 失败：', key, e)
    return []
  }
}

/**
 * 计算数组平均值。
 *
 * @param {number[]} arr - 数值数组
 * @returns {number} - 平均值；若数组为空则返回 0
 */
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0)

/**
 * 创建一张折线图（Chart.js）。
 * 注意：只负责封装 Chart.js 的调用逻辑，实际坐标数据由上层准备。
 *
 * @param {string} canvasId - <canvas> 元素的 id
 * @param {string[]} labels - x 轴标签数组（与 data 数组长度一致）
 * @param {Array<object>} datasets - Chart.js dataset 配置数组
 * @param {string} title - 图表标题
 * @param {string} [yLabel='数值'] - y 轴标题
 */
function makeLineChart (canvasId, labels, datasets, title, yLabel = '数值') {
  const el = document.getElementById(canvasId)
  // 若找不到 canvas 或没有数据，则不绘制
  if (!el || !labels.length) return

  const ctx = el.getContext('2d')
  /* global Chart */ // 告诉 ESLint / 打包器：Chart 是全局变量（由外部 <script> 引入）

  // 使用 Chart.js 绘制折线图
  new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      // 鼠标悬停时，采用“index 模式 + 不必相交”的交互方式
      interaction: { mode: 'index', intersect: false },
      stacked: false,
      plugins: {
        legend: { position: 'top' }, // 图例放在上方
        title: { display: true, text: title }
      },
      scales: {
        x: { title: { display: true, text: '快照序号（训练过程中的采样点）' } },
        y: { title: { display: true, text: yLabel } }
      }
    }
  })
}

/* -------------------- 双智能体 RL 统计主入口 -------------------- */

// IIFE 立即执行函数，用于在脚本加载时自动启动 Dashboard 的构建逻辑
;(function setupRlDualStats () {
  // 文本统计区域的容器 <div id="statsRlDual">
  const box = document.getElementById('statsRlDual')

  // 从 localStorage 读取所有快照，每个快照对应一次训练过程中的采样点
  const rlStatsRaw = loadArray(RL_STATS_KEY)

  if (!box) {
    console.warn('[RL Stats] 未找到容器 #statsRlDual')
  }

  // 若没有任何数据，则给出友好的提示，告诉用户先去 Arena 页训练
  if (!rlStatsRaw.length) {
    if (box) {
      box.innerHTML = `
        <p>当前没有双智能体 RL 训练数据。</p>
        <p class="arena-muted">
          请先在 <b>Arena</b> 页面启动“双 RL 智能体训练”，并确保在
          <code>arena_train.js</code> 中按约定写入
          <code>localStorage('${RL_STATS_KEY}')</code>。
        </p>
      `
    }
    return
  }

  // ---------- 1. 全量数据排序（按时间戳从早到晚） ----------

  // rlStatsSorted 是“完整数据”，所有统计都基于它
  // arena_train.js 每条快照里都带有 ts (Date.now())
  const rlStatsSorted = [...rlStatsRaw].sort((a, b) => (a.ts || 0) - (b.ts || 0))

  // ---------- 2. 性能优化：限制绘图点数 ----------

  // MAX_POINTS 表示“最多用于绘图的快照数量”
  // - 比如设为 300：表示只绘制最后 300 个采样点
  // - 统计计算仍然使用完整数据（rlStatsSorted）
  const MAX_POINTS = 300

  // rlStatsForChart：仅用于绘图的子集（最新 MAX_POINTS 条）
  const rlStatsForChart =
    rlStatsSorted.length > MAX_POINTS
      ? rlStatsSorted.slice(-MAX_POINTS)
      : rlStatsSorted

  // 对应的 x 轴标签（简单用 1, 2, ..., N 表示快照序号）
  const labels = rlStatsForChart.map((_, i) => i + 1)

  // ---------- 3. 从“绘图子集”中取出要画在图上的各个序列 ----------

  // 注意：这些 *_chart 开头的数组只用于绘制折线图
  const succA_chart     = rlStatsForChart.map(r => Number(r.succA ?? 0))
  const succB_chart     = rlStatsForChart.map(r => Number(r.succB ?? 0))
  const avgStepsA_chart = rlStatsForChart.map(r => Number(r.avgStepsA ?? 0))
  const avgStepsB_chart = rlStatsForChart.map(r => Number(r.avgStepsB ?? 0))
  const shortest_chart  = rlStatsForChart.map(r => Number(r.shortestSteps ?? 0))
  const epsA_chart      = rlStatsForChart.map(r => Number(r.epsA ?? 0))
  const epsB_chart      = rlStatsForChart.map(r => Number(r.epsB ?? 0))

  // ---------- 4. 全量统计：平均成功率 / 路径效率 / 首次 100% 回合 ----------

  // 以下 succA_all / succB_all 使用“完整数据”用于全程平均和首次 100% 判定
  const succA_all = rlStatsSorted.map(r => Number(r.succA ?? 0))
  const succB_all = rlStatsSorted.map(r => Number(r.succB ?? 0))

  // 全程平均成功率（所有快照的 succA/ succB 求平均）
  const avgSuccA = avg(succA_all)
  const avgSuccB = avg(succB_all)

  // 找到首次成功率 >= 99.5% 的快照下标（0-based）
  // 这里用 99.5% 视作“接近 100%”
  const idxPerfectA = succA_all.findIndex(v => v >= 99.5)
  const idxPerfectB = succB_all.findIndex(v => v >= 99.5)

  // 从对应快照中读取 episodeCount；兼容旧字段 epA / epB / ep
  const firstPerfectEpA =
    idxPerfectA >= 0
      ? (rlStatsSorted[idxPerfectA].epA ?? rlStatsSorted[idxPerfectA].ep ?? null)
      : null

  const firstPerfectEpB =
    idxPerfectB >= 0
      ? (rlStatsSorted[idxPerfectB].epB ?? rlStatsSorted[idxPerfectB].ep ?? null)
      : null

  // 最近窗口用于计算“路径效率”的大小（例如最多看最近 50 个点）
  // 这里 RECENT_WINDOW 取 min(50, 总快照数)
  const RECENT_WINDOW = Math.min(50, rlStatsSorted.length)
  // recent 是“最近 RECENT_WINDOW 条快照”
  const recent = rlStatsSorted.slice(-RECENT_WINDOW)

  /**
   * 在最近窗口中，计算“平均 (平均步数 / 最短步数)”，即路径效率。
   * 若 shortestSteps 为 0 或不存在，则跳过该样本。
   *
   * @param {'A'|'B'} which - 指定计算智能体 A 还是 B
   * @returns {number} - 该智能体最近窗口里的平均路径效率（越接近 1 越好）
   */
  const computeRecentRatio = (which) => {
    const vals = recent
      .map(r => {
        const shortestSteps = Number(r.shortestSteps ?? 0)
        const avgSteps =
          which === 'A' ? Number(r.avgStepsA ?? 0) : Number(r.avgStepsB ?? 0)
        // 若 shortestSteps <= 0，认为该样本不可用，返回 NaN 方便 filter
        return shortestSteps > 0 ? avgSteps / shortestSteps : NaN
      })
      .filter(x => Number.isFinite(x))

    return vals.length ? avg(vals) : NaN
  }

  // A/B 在最近窗口里的平均路径效率
  const recentRatioA = computeRecentRatio('A')
  const recentRatioB = computeRecentRatio('B')

  // 最新一条快照（用于展示当前迷宫 / 难度 / succ / eps 等信息）
  const last = rlStatsSorted[rlStatsSorted.length - 1]

  // ---------- 5. 判定当前“领先者”的文字说明 ----------

  // leaderText 用来在文本里说明“目前谁更占优势”
  // 主要依据：谁先达成 100% 成功率 + 谁路径更接近最短
  let leaderText = '暂未分出胜负（数据仍在积累）'

  if (firstPerfectEpA != null || firstPerfectEpB != null) {
    // 至少有一方已经达到接近 100% 成功率
    if (firstPerfectEpA != null && firstPerfectEpB == null) {
      leaderText = 'A 更快达到 100% 成功率'
    } else if (firstPerfectEpB != null && firstPerfectEpA == null) {
      leaderText = 'B 更快达到 100% 成功率'
    } else if (firstPerfectEpA != null && firstPerfectEpB != null) {
      // 双方都满成功率，则比较“谁先满”
      if (firstPerfectEpA < firstPerfectEpB) {
        leaderText = `A 更快达到 100% 成功率（${firstPerfectEpA} vs ${firstPerfectEpB} 回合）`
      } else if (firstPerfectEpB < firstPerfectEpA) {
        leaderText = `B 更快达到 100% 成功率（${firstPerfectEpB} vs ${firstPerfectEpA} 回合）`
      } else {
        // 在同一个 episode 达成满成功率，再看路径效率谁更接近最短
        if (Number.isFinite(recentRatioA) && Number.isFinite(recentRatioB)) {
          const dA = Math.abs(recentRatioA - 1.0)
          const dB = Math.abs(recentRatioB - 1.0)
          if (dA < dB) {
            leaderText = 'A 路径更接近最短路径（在相同成功率下）'
          } else if (dB < dA) {
            leaderText = 'B 路径更接近最短路径（在相同成功率下）'
          } else {
            leaderText = '两者在成功率和路径效率上都难分伯仲'
          }
        }
      }
    }
  } else if (Number.isFinite(recentRatioA) && Number.isFinite(recentRatioB)) {
    // 两者都还没满成功率，此时先比较“谁路径更短”（谁更接近 1.0）
    const dA = Math.abs(recentRatioA - 1.0)
    const dB = Math.abs(recentRatioB - 1.0)
    if (dA < dB) {
      leaderText = '目前 A 路径更接近最短（虽然尚未满成功率）'
    } else if (dB < dA) {
      leaderText = '目前 B 路径更接近最短（虽然尚未满成功率）'
    }
  }

  // ---------- 6. 绘制三张折线图（使用“绘图子集”） ----------

  // 6.1 成功率趋势（折线图）
  makeLineChart(
    'chartRlSucc',
    labels,
    [
      { label: 'A 成功率（最近窗口，%）', data: succA_chart, fill: false, tension: 0.15 },
      { label: 'B 成功率（最近窗口，%）', data: succB_chart, fill: false, tension: 0.15 }
    ],
    '双智能体 RL 训练 - 成功率趋势',
    '成功率 (%)'
  )

  // 6.2 平均步数 vs 理论最短步数
  makeLineChart(
    'chartRlSteps',
    labels,
    [
      { label: 'A 平均步数', data: avgStepsA_chart, fill: false, tension: 0.15 },
      { label: 'B 平均步数', data: avgStepsB_chart, fill: false, tension: 0.15 },
      {
        label: '理论最短步数',
        data: shortest_chart,
        fill: false,
        borderDash: [6, 4], // 虚线显示最短步数，便于区分
        tension: 0
      }
    ],
    '双智能体 RL 训练 - 平均步数 vs 最短步数',
    '步数（格子数）'
  )

  // 6.3 epsilon 衰减曲线
  makeLineChart(
    'chartRlEps',
    labels,
    [
      { label: 'A epsilon', data: epsA_chart, fill: false, tension: 0.15 },
      { label: 'B epsilon', data: epsB_chart, fill: false, tension: 0.15 }
    ],
    '双智能体 RL 训练 - epsilon 衰减',
    'epsilon'
  )

  // ---------- 7. 填充文字统计区域 ----------

  if (box) {
    box.innerHTML = `
      <p>共记录 <b>${rlStatsSorted.length}</b> 个双智能体 RL 训练快照。</p>
      <ul>
        <li>全程平均成功率：
          A = <b>${avgSuccA.toFixed(1)}%</b>，
          B = <b>${avgSuccB.toFixed(1)}%</b>
        </li>
        <li>最近 ${RECENT_WINDOW} 个快照的路径效率
          （平均步数 / 最短步数，越接近 <code>1.0</code> 越好）：
          A ≈ <b>${Number.isFinite(recentRatioA) ? recentRatioA.toFixed(2) : '-' } × 最短</b>，
          B ≈ <b>${Number.isFinite(recentRatioB) ? recentRatioB.toFixed(2) : '-' } × 最短</b>
        </li>
        <li>首次达到接近 100% 成功率（≥ 99.5%）的回合：
          A = <b>${firstPerfectEpA != null ? firstPerfectEpA : '尚未'}</b>，
          B = <b>${firstPerfectEpB != null ? firstPerfectEpB : '尚未'}</b>
        </li>
        <li>最新快照（迷宫 <code>${last.mazeId ?? '-'}</code> / 难度
          <b>${last.difficulty ?? 'unknown'}</b>）：
          成功率 A = <b>${(last.succA ?? 0).toFixed ? last.succA.toFixed(1) : last.succA}%</b>，
          B = <b>${(last.succB ?? 0).toFixed ? last.succB.toFixed(1) : last.succB}%</b>，
          epsilon A = <b>${(last.epsA ?? 0).toFixed ? last.epsA.toFixed(2) : last.epsA}</b>，
          B = <b>${(last.epsB ?? 0).toFixed ? last.epsB.toFixed(2) : last.epsB}</b>
        </li>
        <li><b>${leaderText}</b></li>
      </ul>
    `
  }
})()




