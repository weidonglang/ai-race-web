// src/arena_rl.js
// ---------------------------------------------------------
// 离散网格世界 + Q-learning 训练 + Canvas 可视化（二维演示版）
//
// 和三维迷宫 + RL 引擎相比，这个文件的特点：
// 1. 环境是一个固定的 7x7 网格（GRID_W × GRID_H），比较简单、直观。
// 2. 使用 Q-learning 在这个小网格上学习，从起点走到终点，同时躲开陷阱。
// 3. 使用 <canvas> 直接画出当前环境与智能体位置，方便可视化教学。
// 4. 通过按钮控制“开始/暂停/单局/重置”等操作，并在右侧展示统计指标。
//
// 你可以把这个文件当作“Q-learning 最小演示 demo”，
// 比 3D 场景要简单很多，非常适合给初学者讲基本原理。
// ---------------------------------------------------------

/* ------------------- 基本环境配置 ------------------- */

// 网格大小（固定：7×7）
// - x 方向为列（0..GRID_W-1）
// - y 方向为行（0..GRID_H-1），通常 0 在上，GRID_H-1 在下
const GRID_W = 7
const GRID_H = 7

// 起点在左下角，终点在右上角
// 注意：这里用 {x,y} 作为坐标
const START = { x: 0, y: GRID_H - 1 }
const GOAL = { x: GRID_W - 1, y: 0 }

// 陷阱：手动给几个坐标，呈对角挡路（你可以按需调整）
// 使用 Set 存储 "x,y" 字符串，查询 O(1)
const TRAP_CELLS = new Set([
  '2,5', '3,5',
  '3,4', '4,4',
  '1,3', '2,3',
  '4,2', '5,2'
])

/**
 * 判断一个格子是否是陷阱格。
 * @param {number} x - 列坐标
 * @param {number} y - 行坐标
 * @returns {boolean}
 */
function isTrap (x, y) {
  return TRAP_CELLS.has(`${x},${y}`)
}

// 每局最大步数（防止 agent 在迷宫里来回乱走永不结束）
// 超过这个步数还没结束，就强制认为失败并重启一局。
const MAX_STEPS_PER_EPISODE = 64

/* ------------------- Q-learning 参数 ------------------- */

// Q-learning 的核心超参数
let alpha = 0.30         // 学习率 α：越大越相信新经验，越小越保守
let gamma = 0.95         // 折扣因子 γ：越接近 1 越看重远期奖励
let epsilon = 1.0        // 初始探索率 ε：刚开始全部靠随机探索

// ε 的下限与衰减规则
const EPSILON_MIN = 0.05
const EPSILON_DECAY = 0.995  // 每局之后：ε ← max(EPSILON_MIN, ε * EPSILON_DECAY)

// 状态数与动作数
// - 状态 = 网格上的一个格子位置 => 共 GRID_W × GRID_H 个状态
// - 动作 = {上,下,左,右} => 共 4 个动作
const STATE_COUNT = GRID_W * GRID_H
const ACTION_COUNT = 4   // 上 下 左 右

// Q 表：二维结构（状态维度）中每一行是一个 Float64Array，长度为 ACTION_COUNT。
// Q[s][a] 表示：在状态 s 下采取动作 a 的价值估计。
const Q = Array.from(
  { length: STATE_COUNT },
  () => new Float64Array(ACTION_COUNT).fill(0)
)

/**
 * 将 (x,y) 网格坐标编码为一个一维状态下标 s。
 * 这里采用行优先编码：s = y * GRID_W + x。
 * @param {number} x
 * @param {number} y
 * @returns {number} 状态索引 s ∈ [0, STATE_COUNT)
 */
function stateIndex (x, y) {
  return y * GRID_W + x
}

/* ------------------- 行动定义 ------------------- */

// 动作数组：四个方向，上/下/左/右
// - dx, dy 表示在 x/y 上的增量
// - name 仅用于调试和可读性
const ACTIONS = [
  { name: 'Up',    dx: 0,  dy: -1 },
  { name: 'Down',  dx: 0,  dy: 1 },
  { name: 'Left',  dx: -1, dy: 0 },
  { name: 'Right', dx: 1,  dy: 0 }
]

/* ------------------- 环境 step(s,a) ------------------- */

/**
 * 环境动力学：在状态 (x,y) 下执行动作 actionIndex，返回下一状态和奖励。
 * 这是一个“纯函数”，不依赖外部全局 RL 状态。
 *
 * @param {number} x - 当前 x 坐标
 * @param {number} y - 当前 y 坐标
 * @param {number} actionIndex - 动作下标（0~3）
 * @returns {{
 *   x:number, y:number,
 *   reward:number,
 *   done:boolean,
 *   reason:'wall'|'trap'|'goal'|'move'
 * }}
 */
function stepEnvironment (x, y, actionIndex) {
  const a = ACTIONS[actionIndex]
  let nx = x + a.dx
  let ny = y + a.dy

  // 情况 1：撞墙（越界）
  // - 智能体不移动（仍在原地）
  // - 给一个比较明显的负奖励，鼓励它少撞墙
  if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
    nx = x
    ny = y
    return {
      x: nx,
      y: ny,
      reward: -0.2,
      done: false,
      reason: 'wall'
    }
  }

  // 情况 2：踩到陷阱
  // - episode 结束
  // - 给一个较大负奖励
  if (isTrap(nx, ny)) {
    return {
      x: nx,
      y: ny,
      reward: -1.0,
      done: true,
      reason: 'trap'
    }
  }

  // 情况 3：成功到达终点
  // - episode 结束
  // - 给一个较大正奖励
  if (nx === GOAL.x && ny === GOAL.y) {
    return {
      x: nx,
      y: ny,
      reward: 1.0,
      done: true,
      reason: 'goal'
    }
  }

  // 情况 4：普通移动
  // - 智能体成功移动到一个新的格子
  // - 只给轻微的时间惩罚，鼓励走更短的路径
  return {
    x: nx,
    y: ny,
    reward: -0.02,
    done: false,
    reason: 'move'
  }
}

/* ------------------- 策略：ε-greedy ------------------- */

/**
 * ε-greedy 策略：
 * - 以概率 ε 做“探索”（随机选一个动作）；
 * - 以概率 1-ε 做“利用”（选 Q 值最大的动作）。
 *
 * @param {number} s - 当前状态下标
 * @returns {number} 动作下标 a ∈ [0, ACTION_COUNT)
 */
function chooseAction (s) {
  // 探索：完全随机选择一个动作
  if (Math.random() < epsilon) {
    return Math.floor(Math.random() * ACTION_COUNT)
  }

  // 利用：选择当前状态下 Q 值最大的动作
  const qRow = Q[s]
  let bestA = 0
  let bestQ = qRow[0]
  for (let a = 1; a < ACTION_COUNT; a++) {
    if (qRow[a] > bestQ) {
      bestQ = qRow[a]
      bestA = a
    }
  }
  return bestA
}

/**
 * Q-learning 更新公式：
 * Q(s,a) ← Q(s,a) + α * (r + γ * max_a' Q(s',a') - Q(s,a))
 *
 * @param {number} s     - 当前状态 s
 * @param {number} a     - 动作 a
 * @param {number} r     - 即时奖励 r
 * @param {number} sNext - 下一状态 s'
 */
function updateQ (s, a, r, sNext) {
  const qSa = Q[s][a]

  // 计算下一状态 sNext 的最大 Q 值 max_a' Q(s',a')
  let maxNext = Q[sNext][0]
  for (let i = 1; i < ACTION_COUNT; i++) {
    if (Q[sNext][i] > maxNext) maxNext = Q[sNext][i]
  }

  const target = r + gamma * maxNext
  Q[s][a] = qSa + alpha * (target - qSa)
}

/* ------------------- 训练循环状态 ------------------- */

// 当前局（episode）内部状态
let curX = START.x       // 当前智能体所在的 x 坐标
let curY = START.y       // 当前智能体所在的 y 坐标
let curSteps = 0         // 当前局已经走了多少步
let curRewardSum = 0     // 当前局累计奖励
let curDone = false      // 当前局是否已经结束（到终点 / 踩陷阱 / 步数上限）

// 全局统计（从程序启动以来）
let episodeCount = 0     // 总共跑了多少局
let successCount = 0     // 其中成功（到达终点）的局数
let lastRewardEpisode = 0 // 上一局的总奖励
let lastStepsEpisode = 0  // 上一局的总步数

// 最近若干局统计（滑动窗口）
const RECENT_WINDOW = 100
const recentRewards = []       // 最近 N 局的 reward 和
const recentSteps = []         // 最近 N 局的步数
const recentSuccessFlags = []  // 最近 N 局是否成功（1=成功, 0=失败）

/**
 * 向“最近 N 局滑动窗口”里追加一条记录。
 *
 * @param {number} rewardSum - 本局的总奖励
 * @param {number} steps - 本局的步数
 * @param {boolean} success - 是否成功（到达终点）
 */
function pushRecent (rewardSum, steps, success) {
  recentRewards.push(rewardSum)
  recentSteps.push(steps)
  recentSuccessFlags.push(success ? 1 : 0)

  // 控制队列长度不超过 RECENT_WINDOW
  if (recentRewards.length > RECENT_WINDOW) {
    recentRewards.shift()
    recentSteps.shift()
    recentSuccessFlags.shift()
  }
}

/**
 * 计算数组平均值的简单工具函数。
 * @param {number[]} arr
 * @returns {number}
 */
function mean (arr) {
  if (!arr.length) return 0
  const s = arr.reduce((a, b) => a + b, 0)
  return s / arr.length
}

/* ------------------- 一局（episode）逻辑 ------------------- */

/**
 * 重置一局（Episode）：
 * - 把智能体放回起点；
 * - 清零步数与奖励；
 * - 标记为“未结束”。
 */
function resetEpisode () {
  curX = START.x
  curY = START.y
  curSteps = 0
  curRewardSum = 0
  curDone = false
}

/**
 * 在当前局上执行“一步”：
 * - 若当前局已结束（curDone=true），函数直接返回；
 * - 否则执行 ε-greedy 选动作 -> 调 stepEnvironment -> 更新 Q 表；
 * - 检查是否达到最大步数或环境 done 标志，从而决定是否结束一局。
 */
function runOneStep () {
  if (curDone) return

  // 1. 将当前 (x,y) 映射成状态下标 s
  const s = stateIndex(curX, curY)

  // 2. 用 ε-greedy 选动作 a
  const a = chooseAction(s)

  // 3. 让环境执行一步，得到下一状态 (nx,ny) 和奖励等信息
  const { x: nx, y: ny, reward, done, reason } = stepEnvironment(curX, curY, a)
  const sNext = stateIndex(nx, ny)

  // 4. 用 Q-learning 更新 Q 表
  updateQ(s, a, reward, sNext)

  // 5. 更新当前局状态
  curX = nx
  curY = ny
  curSteps++
  curRewardSum += reward

  // 6. 若达到最大步数 => 强制结束，视为失败
  if (curSteps >= MAX_STEPS_PER_EPISODE) {
    curDone = true
    finishEpisode(false)
    return
  }

  // 7. 环境自己判定 done（成功到达终点或踩陷阱）
  if (done) {
    const success = (reason === 'goal')
    curDone = true
    finishEpisode(success)
  }
}

/**
 * 结束一局：更新全局统计 + 推入最近窗口 + ε 衰减 + 自动开始下一局。
 *
 * @param {boolean} success - 这一局是否成功到达终点
 */
function finishEpisode (success) {
  episodeCount++
  if (success) successCount++

  // 记录上一局的关键指标
  lastRewardEpisode = curRewardSum
  lastStepsEpisode = curSteps

  // 压入最近窗口，便于计算平均 reward / 步数 / 成功率
  pushRecent(curRewardSum, curSteps, success)

  // ε 衰减：训练越久，探索越少，越多利用已有经验
  epsilon = Math.max(EPSILON_MIN, epsilon * EPSILON_DECAY)

  // 自动开始下一局（状态重置回起点）
  resetEpisode()
}

/* ------------------- Canvas 渲染 ------------------- */

// 绑定 Canvas 元素，并获取 2D 绘图上下文
const canvas = document.getElementById('rlCanvas')
const ctx = canvas.getContext('2d')

/**
 * 自适应 Canvas 尺寸：
 * - 根据 DOM 实际大小（CSS 尺寸）和 devicePixelRatio，调整像素尺寸；
 * - 可以让画面在 Retina 显示器上更清晰。
 */
function resizeCanvas () {
  const rect = canvas.getBoundingClientRect()
  const size = Math.min(rect.width, rect.height)
  canvas.width = size * window.devicePixelRatio
  canvas.height = size * window.devicePixelRatio
}
resizeCanvas()
window.addEventListener('resize', resizeCanvas)

/**
 * 绘制整个网格世界：
 * - 背景 -> 网格 -> 填充不同类型的格子颜色（起点、终点、陷阱）；
 * - 画起点 / 终点 / 陷阱的高亮圆点；
 * - 最后画出当前智能体所在位置（蓝色圆）。
 */
function drawGridWorld () {
  const w = canvas.width
  const h = canvas.height
  const cellW = w / GRID_W
  const cellH = h / GRID_H

  // 1. 背景
  ctx.fillStyle = '#050814'
  ctx.fillRect(0, 0, w, h)

  // 2. 绘制每一个格子的基础色和边框
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = x * cellW
      const py = y * cellH

      // 基础格子颜色（深色）
      ctx.fillStyle = '#0b1220'

      // 特殊格子背景色（起点 / 终点 / 陷阱）
      if (x === START.x && y === START.y) {
        ctx.fillStyle = '#064e3b'     // 起点：深绿
      } else if (x === GOAL.x && y === GOAL.y) {
        ctx.fillStyle = '#78350f'     // 终点：深黄棕
      } else if (isTrap(x, y)) {
        ctx.fillStyle = '#450a0a'     // 陷阱：深红
      }

      ctx.fillRect(px, py, cellW, cellH)

      // 网格线（边框）
      ctx.strokeStyle = '#1f2937'
      ctx.lineWidth = 1
      ctx.strokeRect(px, py, cellW, cellH)
    }
  }

  // 3. 起点 / 终点 / 陷阱的“高亮圆点”
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = x * cellW
      const py = y * cellH

      if (x === START.x && y === START.y) {
        // 起点：亮绿色小圆
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.arc(
          px + cellW * 0.5,
          py + cellH * 0.5,
          Math.min(cellW, cellH) * 0.18,
          0,
          Math.PI * 2
        )
        ctx.fill()
      } else if (x === GOAL.x && y === GOAL.y) {
        // 终点：亮黄色小圆
        ctx.fillStyle = '#fbbf24'
        ctx.beginPath()
        ctx.arc(
          px + cellW * 0.5,
          py + cellH * 0.5,
          Math.min(cellW, cellH) * 0.18,
          0,
          Math.PI * 2
        )
        ctx.fill()
      } else if (isTrap(x, y)) {
        // 陷阱：红色小圆
        ctx.fillStyle = '#ef4444'
        ctx.beginPath()
        ctx.arc(
          px + cellW * 0.5,
          py + cellH * 0.5,
          Math.min(cellW, cellH) * 0.14,
          0,
          Math.PI * 2
        )
        ctx.fill()
      }
    }
  }

  // 4. 智能体位置（蓝色圆）
  const px = curX * cellW
  const py = curY * cellH
  ctx.fillStyle = '#60a5fa'
  ctx.beginPath()
  ctx.arc(
    px + cellW * 0.5,
    py + cellH * 0.5,
    Math.min(cellW, cellH) * 0.22,
    0,
    Math.PI * 2
  )
  ctx.fill()
}

/* ------------------- UI 绑定 ------------------- */

// 简易选择器：按 id 获取 DOM 元素
const $ = id => document.getElementById(id)

// 控制按钮
const btnStart = $('btnRlStart')
const btnPause = $('btnRlPause')
const btnStepEp = $('btnRlStepEp')
const btnReset = $('btnRlReset')

// 统计信息显示区域
const elEp = $('rlEpisode')
const elSucc = $('rlSuccess')
const elSuccRate = $('rlSuccessRate')
const elAvgReward = $('rlAvgReward')
const elAvgSteps = $('rlAvgSteps')
const elLastReward = $('rlLastReward')
const elLastSteps = $('rlLastSteps')
const elAlpha = $('rlAlpha')
const elGamma = $('rlGamma')
const elEps = $('rlEps')
const elEpsNow = $('rlEpsNow')

// 初始化界面上显示的超参数
elAlpha.textContent = alpha.toFixed(2)
elGamma.textContent = gamma.toFixed(2)
elEps.textContent = `${1.00.toFixed(2)} → ${EPSILON_MIN.toFixed(2)}`

// 运行状态标记
let running = false   // 是否处于“自动持续训练”的模式
let paused = false    // 是否暂停（仅在 running=true 时生效）

// “开始/继续”按钮：
// - 如果当前未 running，则开启持续训练；
// - 如果已经 running，则仅取消暂停，让训练继续。
btnStart.addEventListener('click', () => {
  if (!running) {
    running = true
    paused = false
  } else {
    // 如果已经在跑，直接取消暂停
    paused = false
  }
})

// “暂停”按钮：
// - 只有在 running=true 时才允许切换 paused 状态。
btnPause.addEventListener('click', () => {
  if (!running) return
  paused = !paused
})

// “单局演示”按钮：
// - 一次性同步地跑完一整局（从起点到终止条件）
// - 适合课堂上“慢放”演示效果。
// - 注意：如果正在持续训练（running=true），则直接返回，避免状态冲突。
btnStepEp.addEventListener('click', () => {
  if (running) return // 避免和持续训练抢状态

  resetEpisode()
  let steps = 0
  while (!curDone && steps < MAX_STEPS_PER_EPISODE) {
    runOneStep()
    steps++
  }
  updateStatsUI()
  drawGridWorld()
})

// “重置”按钮：
// - 将 Q 表全部清零（相当于忘记所有学到的东西）；
// - 重置 ε 和统计信息；
// - 停止自动训练，回到起点。
btnReset.addEventListener('click', () => {
  // 重置所有 Q 值为 0
  for (let s = 0; s < STATE_COUNT; s++) {
    Q[s].fill(0)
  }
  // 重置 ε 和全局指标
  epsilon = 1.0
  episodeCount = 0
  successCount = 0
  lastRewardEpisode = 0
  lastStepsEpisode = 0
  recentRewards.length = 0
  recentSteps.length = 0
  recentSuccessFlags.length = 0

  resetEpisode()
  running = false
  paused = false
  updateStatsUI()
  drawGridWorld()
})

/**
 * 将当前统计信息刷新到右侧 UI 面板。
 * 包括：
 * - 总局数 / 成功局数；
 * - 最近 N 局的成功率 / 平均奖励 / 平均步数；
 * - 上一局的奖励 / 步数；
 * - 当前 ε。
 */
function updateStatsUI () {
  elEp.textContent = episodeCount.toString()
  elSucc.textContent = successCount.toString()

  const succRate = mean(recentSuccessFlags) * 100
  const avgR = mean(recentRewards)
  const avgSteps = mean(recentSteps)

  elSuccRate.textContent = `${succRate.toFixed(1)}%`
  elAvgReward.textContent = avgR.toFixed(2)
  elAvgSteps.textContent = avgSteps.toFixed(1)
  elLastReward.textContent = lastRewardEpisode.toFixed(2)
  elLastSteps.textContent = lastStepsEpisode.toString()
  elEpsNow.textContent = epsilon.toFixed(2)
}

/* ------------------- 主循环：持续训练 + 可视化 ------------------- */

// 动画循环用的时间戳（这里 dt 没拿来改逻辑，仅保留结构）
let lastTime = performance.now()

// 每一帧跑多少个“环境时间步”
// - 数值越大，训练越快，但画面中的移动会“跳”得更快。
const STEPS_PER_FRAME = 20

/**
 * 主循环：
 * - 使用 requestAnimationFrame 保持界面流畅更新时间；
 * - 在 running 且未暂停的情况下，每帧执行若干个 RL 时间步；
 * - 每帧重绘一次网格世界。
 *
 * @param {DOMHighResTimeStamp} now
 */
function loop (now) {
  const dt = now - lastTime
  lastTime = now
  // 当前版本中 dt 只是保留，以后可用于调节训练速率（例如按时间基准而非固定步数）

  // 若处于持续训练状态（running=true 且 paused=false）
  if (running && !paused) {
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      if (!curDone) {
        // 当前局未结束 -> 继续往前走一步
        runOneStep()
      } else {
        // 当前局结束 -> 自动开始新一局
        resetEpisode()
      }
    }
    // 更新统计面板
    updateStatsUI()
  }

  // 无论是否在训练，每帧都重绘一次网格，可以看到 agent 当前所在位置
  drawGridWorld()

  // 下一帧
  requestAnimationFrame(loop)
}

// 初始化：先重置一局、刷新一次 UI 和画面，然后启动动画循环
resetEpisode()
updateStatsUI()
drawGridWorld()
requestAnimationFrame(loop)
