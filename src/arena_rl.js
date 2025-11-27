// src/arena_rl.js
// 离散网格世界 + Q-learning 训练 + 可视化

/* ------------------- 基本环境配置 ------------------- */

// 网格大小
const GRID_W = 7
const GRID_H = 7

// 起点在左下角，终点在右上角
const START = { x: 0, y: GRID_H - 1 }
const GOAL = { x: GRID_W - 1, y: 0 }

// 陷阱：手动给几个坐标，呈对角挡路（你可以按需调整）
const TRAP_CELLS = new Set([
  '2,5', '3,5',
  '3,4', '4,4',
  '1,3', '2,3',
  '4,2', '5,2'
])

function isTrap (x, y) {
  return TRAP_CELLS.has(`${x},${y}`)
}

// 每局最大步数（防止无限循环）
const MAX_STEPS_PER_EPISODE = 64

/* ------------------- Q-learning 参数 ------------------- */

let alpha = 0.30         // 学习率
let gamma = 0.95         // 折扣因子
let epsilon = 1.0        // 初始探索率
const EPSILON_MIN = 0.05
const EPSILON_DECAY = 0.995  // 每局之后：ε ← max(EPSILON_MIN, ε * EPSILON_DECAY)

// 状态数与动作数
const STATE_COUNT = GRID_W * GRID_H
const ACTION_COUNT = 4   // 上 下 左 右

// Q 表：STATE_COUNT × ACTION_COUNT
const Q = Array.from({ length: STATE_COUNT }, () => new Float64Array(ACTION_COUNT).fill(0))

function stateIndex (x, y) {
  return y * GRID_W + x
}

/* ------------------- 行动定义 ------------------- */

const ACTIONS = [
  { name: 'Up', dx: 0, dy: -1 },
  { name: 'Down', dx: 0, dy: 1 },
  { name: 'Left', dx: -1, dy: 0 },
  { name: 'Right', dx: 1, dy: 0 }
]

/* ------------------- 环境 step(s,a) ------------------- */

function stepEnvironment (x, y, actionIndex) {
  const a = ACTIONS[actionIndex]
  let nx = x + a.dx
  let ny = y + a.dy

  // 撞墙：位置不变，给比较明显的惩罚
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

  // 踩到陷阱：大惩罚，episode 结束
  if (isTrap(nx, ny)) {
    return {
      x: nx,
      y: ny,
      reward: -1.0,
      done: true,
      reason: 'trap'
    }
  }

  // 到达终点：大奖励，episode 结束
  if (nx === GOAL.x && ny === GOAL.y) {
    return {
      x: nx,
      y: ny,
      reward: 1.0,
      done: true,
      reason: 'goal'
    }
  }

  // 普通移动：轻微时间惩罚，鼓励更短路径
  return {
    x: nx,
    y: ny,
    reward: -0.02,
    done: false,
    reason: 'move'
  }
}

/* ------------------- 策略：ε-greedy ------------------- */

function chooseAction (s) {
  if (Math.random() < epsilon) {
    // 探索：随机动作
    return Math.floor(Math.random() * ACTION_COUNT)
  }
  // 利用：选择 Q 最大的动作
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

function updateQ (s, a, r, sNext) {
  const qSa = Q[s][a]
  let maxNext = Q[sNext][0]
  for (let i = 1; i < ACTION_COUNT; i++) {
    if (Q[sNext][i] > maxNext) maxNext = Q[sNext][i]
  }
  const target = r + gamma * maxNext
  Q[s][a] = qSa + alpha * (target - qSa)
}

/* ------------------- 训练循环状态 ------------------- */

// 当前局状态
let curX = START.x
let curY = START.y
let curSteps = 0
let curRewardSum = 0
let curDone = false

// 全局统计
let episodeCount = 0
let successCount = 0
let lastRewardEpisode = 0
let lastStepsEpisode = 0

// 最近若干局统计（滑动窗口）
const RECENT_WINDOW = 100
const recentRewards = []
const recentSteps = []
const recentSuccessFlags = []

function pushRecent (rewardSum, steps, success) {
  recentRewards.push(rewardSum)
  recentSteps.push(steps)
  recentSuccessFlags.push(success ? 1 : 0)
  if (recentRewards.length > RECENT_WINDOW) {
    recentRewards.shift()
    recentSteps.shift()
    recentSuccessFlags.shift()
  }
}

function mean (arr) {
  if (!arr.length) return 0
  const s = arr.reduce((a, b) => a + b, 0)
  return s / arr.length
}

/* ------------------- 一局（episode）逻辑 ------------------- */

function resetEpisode () {
  curX = START.x
  curY = START.y
  curSteps = 0
  curRewardSum = 0
  curDone = false
}

function runOneStep () {
  if (curDone) return

  const s = stateIndex(curX, curY)
  const a = chooseAction(s)
  const { x: nx, y: ny, reward, done, reason } = stepEnvironment(curX, curY, a)
  const sNext = stateIndex(nx, ny)

  updateQ(s, a, reward, sNext)

  curX = nx
  curY = ny
  curSteps++
  curRewardSum += reward

  // 达到最大步数也终止，算作失败
  if (curSteps >= MAX_STEPS_PER_EPISODE) {
    curDone = true
    finishEpisode(false)
    return
  }

  if (done) {
    const success = (reason === 'goal')
    curDone = true
    finishEpisode(success)
  }
}

function finishEpisode (success) {
  episodeCount++
  if (success) successCount++

  lastRewardEpisode = curRewardSum
  lastStepsEpisode = curSteps

  pushRecent(curRewardSum, curSteps, success)

  // ε 衰减
  epsilon = Math.max(EPSILON_MIN, epsilon * EPSILON_DECAY)

  // 自动开始下一局
  resetEpisode()
}

/* ------------------- Canvas 渲染 ------------------- */

const canvas = document.getElementById('rlCanvas')
const ctx = canvas.getContext('2d')

function resizeCanvas () {
  const rect = canvas.getBoundingClientRect()
  const size = Math.min(rect.width, rect.height)
  canvas.width = size * window.devicePixelRatio
  canvas.height = size * window.devicePixelRatio
}
resizeCanvas()
window.addEventListener('resize', resizeCanvas)

function drawGridWorld () {
  const w = canvas.width
  const h = canvas.height
  const cellW = w / GRID_W
  const cellH = h / GRID_H

  // 背景
  ctx.fillStyle = '#050814'
  ctx.fillRect(0, 0, w, h)

  // 每个格子
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = x * cellW
      const py = y * cellH

      // 基础色
      ctx.fillStyle = '#0b1220'

      // 特殊格子
      if (x === START.x && y === START.y) {
        ctx.fillStyle = '#064e3b'     // 深绿
      } else if (x === GOAL.x && y === GOAL.y) {
        ctx.fillStyle = '#78350f'     // 深黄
      } else if (isTrap(x, y)) {
        ctx.fillStyle = '#450a0a'     // 深红
      }

      ctx.fillRect(px, py, cellW, cellH)

      // 边框
      ctx.strokeStyle = '#1f2937'
      ctx.lineWidth = 1
      ctx.strokeRect(px, py, cellW, cellH)
    }
  }

  // 画起点 / 终点 / 陷阱的“高亮层”
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = x * cellW
      const py = y * cellH

      if (x === START.x && y === START.y) {
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.arc(px + cellW * 0.5, py + cellH * 0.5, Math.min(cellW, cellH) * 0.18, 0, Math.PI * 2)
        ctx.fill()
      } else if (x === GOAL.x && y === GOAL.y) {
        ctx.fillStyle = '#fbbf24'
        ctx.beginPath()
        ctx.arc(px + cellW * 0.5, py + cellH * 0.5, Math.min(cellW, cellH) * 0.18, 0, Math.PI * 2)
        ctx.fill()
      } else if (isTrap(x, y)) {
        ctx.fillStyle = '#ef4444'
        ctx.beginPath()
        ctx.arc(px + cellW * 0.5, py + cellH * 0.5, Math.min(cellW, cellH) * 0.14, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // 智能体
  const px = curX * cellW
  const py = curY * cellH
  ctx.fillStyle = '#60a5fa'
  ctx.beginPath()
  ctx.arc(px + cellW * 0.5, py + cellH * 0.5, Math.min(cellW, cellH) * 0.22, 0, Math.PI * 2)
  ctx.fill()
}

/* ------------------- UI 绑定 ------------------- */

const $ = id => document.getElementById(id)

const btnStart = $('btnRlStart')
const btnPause = $('btnRlPause')
const btnStepEp = $('btnRlStepEp')
const btnReset = $('btnRlReset')

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

elAlpha.textContent = alpha.toFixed(2)
elGamma.textContent = gamma.toFixed(2)
elEps.textContent = `${1.00.toFixed(2)} → ${EPSILON_MIN.toFixed(2)}`

let running = false
let paused = false

btnStart.addEventListener('click', () => {
  if (!running) {
    running = true
    paused = false
  } else {
    // 如果已经在跑，直接取消暂停
    paused = false
  }
})

btnPause.addEventListener('click', () => {
  if (!running) return
  paused = !paused
})

btnStepEp.addEventListener('click', () => {
  // 单步跑一局（同步完成），适合慢放演示
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

btnReset.addEventListener('click', () => {
  // 重置 Q 表和统计
  for (let s = 0; s < STATE_COUNT; s++) {
    Q[s].fill(0)
  }
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

let lastTime = performance.now()
const STEPS_PER_FRAME = 20   // 每帧跑多少个时间步，调大训练更快

function loop (now) {
  const dt = now - lastTime
  lastTime = now

  if (running && !paused) {
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      if (!curDone) {
        runOneStep()
      } else {
        resetEpisode()
      }
    }
    updateStatsUI()
  }

  drawGridWorld()
  requestAnimationFrame(loop)
}

resetEpisode()
updateStatsUI()
drawGridWorld()
requestAnimationFrame(loop)
