// src/arena_rl_core.js
// 迷宫网格上的 Q-learning 核心逻辑
// 只依赖 getMazeDesc() 回调，不依赖 DOM / Three.js。

/**
 * 默认 RL 超参数
 */
export const DEFAULT_RL_CONFIG = {
  alpha: 0.30,          // 学习率 α
  gamma: 0.95,          // 折扣因子 γ
  epsilonStart: 1.0,    // 初始探索率 ε0
  epsilonMin: 0.05,     // 最小探索率
  epsilonDecay: 0.995,  // 每局后的 ε 衰减系数
  maxStepsPerEpisode: 256, // 每局最大步数（防无限循环）
  recentWindow: 100     // 滑动窗口大小，用于统计
}

// 内部使用的动作定义：上 / 下 / 左 / 右
const ACTIONS = [
  { name: 'up',    dx: 0,  dy: -1 },
  { name: 'down',  dx: 0,  dy: 1  },
  { name: 'left',  dx: -1, dy: 0  },
  { name: 'right', dx: 1,  dy: 0  }
]

// 工具：高斯随机（Box-Muller），当前版本没用到，但保留扩展用
function randomNormal () {
  const u = Math.random() || 1e-6
  const v = Math.random() || 1e-6
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 尝试把外部传入的迷宫描述“规范化”，变成内部统一格式。
 * 允许传入：isTrap / isBlocked 函数，也允许 traps / blocks 数组。
 */
function normalizeMaze (desc) {
  if (!desc || typeof desc !== 'object') return null
  const width = Number(desc.width) | 0
  const height = Number(desc.height) | 0
  if (!(width > 0 && height > 0)) return null

  const start = desc.start || desc.startCell || { i: 0, k: height - 1 }
  const end = desc.end || desc.goal || { i: width - 1, k: 0 }

  // 处理 traps
  let trapSet = null
  let isTrapFn = null
  if (typeof desc.isTrap === 'function') {
    isTrapFn = desc.isTrap
  } else if (Array.isArray(desc.traps)) {
    trapSet = new Set()
    for (const t of desc.traps) {
      if (!t) continue
      if (typeof t === 'string') {
        trapSet.add(t)
      } else if (typeof t === 'object' && t.i != null && t.k != null) {
        trapSet.add(`${t.i},${t.k}`)
      }
    }
    isTrapFn = (i, k) => trapSet.has(`${i},${k}`)
  } else {
    isTrapFn = () => false
  }

  // 处理 blocks（墙 / 不可走）
  let blockSet = null
  let isBlockedFn = null
  if (typeof desc.isBlocked === 'function') {
    isBlockedFn = desc.isBlocked
  } else if (Array.isArray(desc.blocks)) {
    blockSet = new Set()
    for (const b of desc.blocks) {
      if (!b) continue
      if (typeof b === 'string') {
        blockSet.add(b)
      } else if (typeof b === 'object' && b.i != null && b.k != null) {
        blockSet.add(`${b.i},${b.k}`)
      }
    }
    isBlockedFn = (i, k) => blockSet.has(`${i},${k}`)
  } else {
    // 默认：只有越界是 blocked，内部格子都可走
    isBlockedFn = () => false
  }

  return {
    id: desc.id ?? null,
    width,
    height,
    start: { i: start.i ?? 0, k: start.k ?? (height - 1) },
    end:   { i: end.i ?? (width - 1), k: end.k ?? 0 },
    isTrap: isTrapFn,
    isBlocked: isBlockedFn
  }
}

/**
 * 创建 Q 表：stateCount × actionCount，初始为 0
 */
function createQTable (stateCount, actionCount) {
  const Q = new Array(stateCount)
  for (let s = 0; s < stateCount; s++) {
    Q[s] = new Float64Array(actionCount)
  }
  return Q
}

/**
 * 创建一个基于当前迷宫的 Q-learning 智能体。
 *
 * @param {() => MazeDesc | null} getMazeDesc 外部回调，用于获取当前迷宫信息
 * @param {Partial<typeof DEFAULT_RL_CONFIG>} options 覆盖默认超参数
 */
export function createRlAgent (getMazeDesc, options = {}) {
  const cfg = { ...DEFAULT_RL_CONFIG, ...options }
  const ACTION_COUNT = ACTIONS.length

  // 当前使用的迷宫 & Q 表
  let maze = null
  let mazeSignature = null
  let width = 0
  let height = 0
  let stateCount = 0
  let Q = null

  // 当前 episode 状态
  let curX = 0
  let curY = 0
  let curSteps = 0
  let curRewardSum = 0
  let curDone = false
  let lastStepReward = 0
  let lastStepReason = 'init' // 'move' | 'wall' | 'trap' | 'goal' | 'timeout' | 'init'

  // 全局统计
  let epsilon = cfg.epsilonStart
  let episodeCount = 0
  let successCount = 0

  // 最近 N 局的统计（滑动窗口）
  const recentRewards = []
  const recentSteps = []
  const recentSuccess = []
  const W = cfg.recentWindow

  function pushRecent (rewardSum, steps, success) {
    recentRewards.push(rewardSum)
    recentSteps.push(steps)
    recentSuccess.push(success ? 1 : 0)
    if (recentRewards.length > W) {
      recentRewards.shift()
      recentSteps.shift()
      recentSuccess.shift()
    }
  }

  function mean (arr) {
    if (!arr.length) return 0
    let s = 0
    for (let i = 0; i < arr.length; i++) s += arr[i]
    return s / arr.length
  }

  // 状态索引：把 (i,k) 映射到 [0, stateCount)
  function stateIndex (i, k) {
    return k * width + i
  }

  /**
   * 同步迷宫：如果外部切换了迷宫，就重新初始化 Q 表和 episode 状态。
   * 当前实现：只要迷宫结构变化（id / 尺寸 / 起终点）就会重置全部进度。
   */
  function syncMazeIfNeeded () {
    const descRaw = typeof getMazeDesc === 'function' ? getMazeDesc() : null
    const nm = normalizeMaze(descRaw)
    if (!nm) {
      maze = null
      Q = null
      width = height = stateCount = 0
      return
    }

    const sig = `${nm.id ?? 'noid'}|${nm.width}x${nm.height}|${nm.start.i},${nm.start.k}|${nm.end.i},${nm.end.k}`

    // 第一次或迷宫变化：重置所有状态
    if (!maze || sig !== mazeSignature) {
      maze = nm
      mazeSignature = sig
      width = maze.width
      height = maze.height
      stateCount = width * height
      Q = createQTable(stateCount, ACTION_COUNT)

      // 重置 RL 状态和统计
      epsilon = cfg.epsilonStart
      episodeCount = 0
      successCount = 0
      recentRewards.length = 0
      recentSteps.length = 0
      recentSuccess.length = 0

      resetEpisodeInternal(true)
      // 控制台提示一下方便调试
      console.log('[RL] Maze changed, RL state reset.', {
        id: maze.id,
        width,
        height,
        start: maze.start,
        end: maze.end
      })
    }
  }

  /**
   * 重置当前 episode，不清空统计。
   * @param {boolean} [force] 如果 maze 还没准备好，force 为 false 时会直接返回。
   */
  function resetEpisodeInternal (force = false) {
    if (!maze) {
      if (!force) return
      syncMazeIfNeeded()
      if (!maze) return
    }
    curX = maze.start.i
    curY = maze.start.k
    curSteps = 0
    curRewardSum = 0
    curDone = false
    lastStepReward = 0
    lastStepReason = 'init'
  }

  /**
   * 环境一步：给定 (x,y) 和动作 a，返回下一状态与奖励。
   * 奖励设计：
   *  - 越界或撞墙：位置不变，reward = -0.2，done = false
   *  - 踩陷阱：reward = -1.0，done = true
   *  - 到达终点：reward = +1.0，done = true
   *  - 普通移动：reward = -0.02，done = false
   */
  function stepEnvironment (x, y, actionIndex) {
    const act = ACTIONS[actionIndex]
    let nx = x + act.dx
    let ny = y + act.dy

    // 越界或撞墙：当作 "wall"，不移动
    if (nx < 0 || nx >= width || ny < 0 || ny >= height || maze.isBlocked(nx, ny)) {
      return {
        x,
        y,
        reward: -0.2,
        done: false,
        reason: 'wall'
      }
    }

    // 踩陷阱
    if (maze.isTrap(nx, ny)) {
      return {
        x: nx,
        y: ny,
        reward: -1.0,
        done: true,
        reason: 'trap'
      }
    }

    // 到达终点
    if (nx === maze.end.i && ny === maze.end.k) {
      return {
        x: nx,
        y: ny,
        reward: 1.0,
        done: true,
        reason: 'goal'
      }
    }

    // 普通移动：时间惩罚
    return {
      x: nx,
      y: ny,
      reward: -0.02,
      done: false,
      reason: 'move'
    }
  }

  /**
   * ε-greedy 策略选择动作
   */
  function chooseAction (s) {
    if (Math.random() < epsilon) {
      return (Math.random() * ACTION_COUNT) | 0
    }
    const row = Q[s]
    let bestA = 0
    let bestQ = row[0]
    for (let a = 1; a < ACTION_COUNT; a++) {
      if (row[a] > bestQ) {
        bestQ = row[a]
        bestA = a
      }
    }
    return bestA
  }

  /**
   * Q-learning 更新：
   * Q(s,a) ← Q(s,a) + α [ r + γ max_a' Q(s',a') - Q(s,a) ]
   */
  function updateQ (s, a, r, sNext) {
    const qsa = Q[s][a]
    let maxNext = Q[sNext][0]
    for (let i = 1; i < ACTION_COUNT; i++) {
      if (Q[sNext][i] > maxNext) maxNext = Q[sNext][i]
    }
    const target = r + cfg.gamma * maxNext
    Q[s][a] = qsa + cfg.alpha * (target - qsa)
  }

  /**
   * 结束一局：更新统计、ε 衰减、压入滑动窗口，然后保持 curDone = true，
   * 等下一次 trainOneStep 时再自动 resetEpisodeInternal。
   */
  function finishEpisode (success, reason) {
    episodeCount++
    if (success) successCount++

    pushRecent(curRewardSum, curSteps, success)

    // ε 衰减
    epsilon = Math.max(cfg.epsilonMin, epsilon * cfg.epsilonDecay)

    lastStepReason = reason || (success ? 'goal' : 'timeout')
    curDone = true
  }

  /**
   * 单步训练：一步时间步
   * - 如果 episode 已结束，则先重置
   * - 然后按当前策略选择动作 → 环境 step → 更新 Q → 更新统计
   */
  function trainOneStep () {
    syncMazeIfNeeded()
    if (!maze || !Q) return

    if (curDone) {
      // 上一局刚结束，这里开启新一局
      resetEpisodeInternal(true)
    }

    const s = stateIndex(curX, curY)
    const a = chooseAction(s)
    const { x: nx, y: ny, reward, done, reason } = stepEnvironment(curX, curY, a)
    const sNext = stateIndex(nx, ny)

    updateQ(s, a, reward, sNext)

    curX = nx
    curY = ny
    curSteps++
    curRewardSum += reward
    lastStepReward = reward
    lastStepReason = reason

    // 是否达到了局结束条件
    if (done) {
      const success = (reason === 'goal')
      finishEpisode(success, reason)
    } else if (curSteps >= cfg.maxStepsPerEpisode) {
      finishEpisode(false, 'timeout')
    }
  }

  /**
   * 公开 API：连续训练 n 步
   */
  function trainSteps (n = 1) {
    for (let i = 0; i < n; i++) {
      trainOneStep()
    }
  }

  /**
   * 公开 API：一次性跑完一整局（直到 done 或步数耗尽）
   * 注意：为了视觉效果，本函数不会自动帮你多跑很多局，
   * 只跑当前这 1 局。
   */
  function trainOneEpisode () {
    // 如果上局已经结束，让它从新的一局开始
    if (curDone) {
      resetEpisodeInternal(true)
    }
    while (!curDone && curSteps < cfg.maxStepsPerEpisode) {
      trainOneStep()
      // trainOneStep 里面会在 done 时设置 curDone = true
      if (curDone) break
    }
  }

  /**
   * 公开 API：重置 Q 表和统计信息（迷宫结构保持不变）
   */
  function resetAll () {
    syncMazeIfNeeded()
    if (!maze) return
    stateCount = maze.width * maze.height
    Q = createQTable(stateCount, ACTION_COUNT)
    epsilon = cfg.epsilonStart
    episodeCount = 0
    successCount = 0
    recentRewards.length = 0
    recentSteps.length = 0
    recentSuccess.length = 0
    resetEpisodeInternal(true)
  }

  /**
   * 公开 API：当前用于可视化的一帧状态
   * - i, k: 当前格子的坐标
   * - episode: 当前已经完成的局数
   * - stepInEpisode: 当前局内走了多少步
   * - done: 当前局是否已经结束（true 时下一次 step 会开启新局）
   * - lastReward: 最近一次 step 的奖励
   * - lastReason: 最近一次 step 的原因（move/wall/trap/goal/timeout/init）
   * - epsilon: 当前探索率
   */
  function getVisualState () {
    return {
      i: curX,
      k: curY,
      episode: episodeCount,
      stepInEpisode: curSteps,
      done: curDone,
      lastReward: lastStepReward,
      lastReason: lastStepReason,
      epsilon
    }
  }

  /**
   * 公开 API：训练统计
   */
  function getStats () {
    const avgR = mean(recentRewards)
    const avgSteps = mean(recentSteps)
    const succRate = mean(recentSuccess) * 100

    return {
      episodeCount,
      successCount,
      successRateRecent: succRate,  // 0 ~ 100
      avgRewardRecent: avgR,
      avgStepsRecent: avgSteps,
      lastRewardEpisode: curRewardSum,
      lastStepsEpisode: curSteps,
      epsilon
    }
  }

  /**
   * 公开 API：返回配置（方便 UI 展示超参数）
   */
  function getConfig () {
    return { ...cfg, epsilon }
  }

  // 初始化一次（如果此时还没加载迷宫，也不会报错）
  syncMazeIfNeeded()

  // 返回给外部的对象
  return {
    trainSteps,
    trainOneEpisode,
    resetAll,
    getVisualState,
    getStats,
    getConfig
  }
}
