// src/dashboard.js
// ======================================================
// 训练看板（Dashboard）- 双智能体 RL (A / B) 对比专用版
// ======================================================
//
// 设计目标：
// 1. 只关注 Arena 页面中“双智能体 RL 训练”的数据，数据来源：
//      localStorage('arena_rl_dual_stats')
// 2. 展示三张折线图：
//      - 成功率趋势（who learns faster）
//      - 平均步数 vs 理论最短步数（who walks shorter）
//      - epsilon 衰减（探索率变化）
// 3. 文本区域总结：
//      - 整体平均成功率
//      - 最近窗口的路径效率（平均步数 / 最短步数）
//      - 首次达到接近 100% 成功率的回合
//      - 当前领先者的判定说明
//
// 性能优化：
// - 当快照很多时（例如 RL 挂机训练几千条），Chart.js 会卡顿。
// - 这里对“绘图用的数据”做了上限：只取“最新 MAX_POINTS 条”用于画图，
//   但文本统计（平均成功率等）仍然使用全部记录。
//   你可以按需要调整 MAX_POINTS 的大小。
// ------------------------------------------------------

// 存 RL 训练快照的 localStorage key，需与 arena_train.js 中保持一致
const RL_STATS_KEY = 'arena_rl_dual_stats'

/**
 * 从 localStorage 中读取 JSON 数组。
 *
 * @param {string} key - localStorage 的键名
 * @returns {Array<any>} - 若不存在或解析失败，则返回空数组
 */
const loadArray = (key) => {
  try {
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
 *
 * @param {string} canvasId - <canvas> 元素的 id
 * @param {string[]} labels - x 轴标签数组
 * @param {Array<object>} datasets - Chart.js dataset 配置数组
 * @param {string} title - 图表标题
 * @param {string} [yLabel='数值'] - y 轴标题
 */
function makeLineChart (canvasId, labels, datasets, title, yLabel = '数值') {
  const el = document.getElementById(canvasId)
  if (!el || !labels.length) return

  const ctx = el.getContext('2d')
  /* global Chart */
  new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      stacked: false,
      plugins: {
        legend: { position: 'top' },
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

;(function setupRlDualStats () {
  // 文本统计区域的容器 <div id="statsRlDual">
  const box = document.getElementById('statsRlDual')

  // 从 localStorage 读取所有快照
  const rlStatsRaw = loadArray(RL_STATS_KEY)

  if (!box) {
    console.warn('[RL Stats] 未找到容器 #statsRlDual')
  }

  // 若没有任何数据，则给出友好的提示
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

  // 注意：这里 rlStatsSorted 是“完整数据”，后面所有统计用它为基准
  const rlStatsSorted = [...rlStatsRaw].sort((a, b) => (a.ts || 0) - (b.ts || 0))

  // ---------- 2. 性能优化：限制绘图点数 ----------

  // MAX_POINTS 表示“最多用于绘图的快照数量”
  // - 比如设为 300：表示只绘制最后 300 个采样点
  // - 你可以根据机器和流畅度调整这个值
  const MAX_POINTS = 300

  // rlStatsForChart：仅用于绘图的子集（最新 MAX_POINTS 条）
  const rlStatsForChart =
    rlStatsSorted.length > MAX_POINTS
      ? rlStatsSorted.slice(-MAX_POINTS)
      : rlStatsSorted

  // 对应的 x 轴标签（1, 2, ..., N）
  const labels = rlStatsForChart.map((_, i) => i + 1)

  // ---------- 3. 从“绘图子集”中取出要画在图上的各个序列 ----------

  // 注意：这里 *_chart 开头的变量，都是“只用于绘图”的版本
  const succA_chart     = rlStatsForChart.map(r => Number(r.succA ?? 0))
  const succB_chart     = rlStatsForChart.map(r => Number(r.succB ?? 0))
  const avgStepsA_chart = rlStatsForChart.map(r => Number(r.avgStepsA ?? 0))
  const avgStepsB_chart = rlStatsForChart.map(r => Number(r.avgStepsB ?? 0))
  const shortest_chart  = rlStatsForChart.map(r => Number(r.shortestSteps ?? 0))
  const epsA_chart      = rlStatsForChart.map(r => Number(r.epsA ?? 0))
  const epsB_chart      = rlStatsForChart.map(r => Number(r.epsB ?? 0))

  // ---------- 4. 全量统计：平均成功率 / 路径效率 / 首次 100% 回合 ----------

  // 全量成功率序列（用于平均值与首次 100% 判定）
  const succA_all = rlStatsSorted.map(r => Number(r.succA ?? 0))
  const succB_all = rlStatsSorted.map(r => Number(r.succB ?? 0))

  // 全程平均成功率
  const avgSuccA = avg(succA_all)
  const avgSuccB = avg(succB_all)

  // 找到首次成功率 >= 99.5% 的快照下标（0-based）
  const idxPerfectA = succA_all.findIndex(v => v >= 99.5)
  const idxPerfectB = succB_all.findIndex(v => v >= 99.5)

  // 从对应快照中读取 episodeCount；若没有 epA，则兼容旧字段 ep
  const firstPerfectEpA =
    idxPerfectA >= 0
      ? (rlStatsSorted[idxPerfectA].epA ?? rlStatsSorted[idxPerfectA].ep ?? null)
      : null

  const firstPerfectEpB =
    idxPerfectB >= 0
      ? (rlStatsSorted[idxPerfectB].epB ?? rlStatsSorted[idxPerfectB].ep ?? null)
      : null

  // 最近窗口用于计算“路径效率”的大小（例如最多看最近 50 个点）
  const RECENT_WINDOW = Math.min(50, rlStatsSorted.length)
  const recent = rlStatsSorted.slice(-RECENT_WINDOW)

  /**
   * 在最近窗口中，计算“平均 (平均步数 / 最短步数)”。
   * 若 shortestSteps 为 0 或不存在，则跳过该点。
   *
   * @param {'A'|'B'} which - 指定计算 A 还是 B
   * @returns {number} - 该智能体最近窗口里的平均路径效率（越接近 1 越好）
   */
  const computeRecentRatio = (which) => {
    const vals = recent
      .map(r => {
        const shortestSteps = Number(r.shortestSteps ?? 0)
        const avgSteps =
          which === 'A' ? Number(r.avgStepsA ?? 0) : Number(r.avgStepsB ?? 0)
        return shortestSteps > 0 ? avgSteps / shortestSteps : NaN
      })
      .filter(x => Number.isFinite(x))

    return vals.length ? avg(vals) : NaN
  }

  const recentRatioA = computeRecentRatio('A')
  const recentRatioB = computeRecentRatio('B')

  // 最新一条快照（用于展示当前迷宫 / 难度等信息）
  const last = rlStatsSorted[rlStatsSorted.length - 1]

  // ---------- 5. 判定当前“领先者”的文字说明 ----------

  let leaderText = '暂未分出胜负（数据仍在积累）'

  if (firstPerfectEpA != null || firstPerfectEpB != null) {
    // 至少有一方已经达到几乎 100% 成功率
    if (firstPerfectEpA != null && firstPerfectEpB == null) {
      leaderText = 'A 更快达到 100% 成功率'
    } else if (firstPerfectEpB != null && firstPerfectEpA == null) {
      leaderText = 'B 更快达到 100% 成功率'
    } else if (firstPerfectEpA != null && firstPerfectEpB != null) {
      if (firstPerfectEpA < firstPerfectEpB) {
        leaderText = `A 更快达到 100% 成功率（${firstPerfectEpA} vs ${firstPerfectEpB} 回合）`
      } else if (firstPerfectEpB < firstPerfectEpA) {
        leaderText = `B 更快达到 100% 成功率（${firstPerfectEpB} vs ${firstPerfectEpA} 回合）`
      } else {
        // 同一回合满，再看路径效率（谁更接近最短路径）
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
    // 两者都还没满成功率，只看谁走得更短（谁更接近 1.0）
    const dA = Math.abs(recentRatioA - 1.0)
    const dB = Math.abs(recentRatioB - 1.0)
    if (dA < dB) {
      leaderText = '目前 A 路径更接近最短（虽然尚未满成功率）'
    } else if (dB < dA) {
      leaderText = '目前 B 路径更接近最短（虽然尚未满成功率）'
    }
  }

  // ---------- 6. 绘制三张折线图（使用“绘图子集”） ----------

  // 6.1 成功率趋势
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
        borderDash: [6, 4], // 虚线显示，便于区分
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
