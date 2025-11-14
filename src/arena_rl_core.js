// src/arena_rl_core.js
// 迷宫网格上的 Q-learning 核心逻辑
// 只依赖 getMazeDesc() 回调，不依赖 DOM / Three.js。

/**
 * 迷宫描述类型约定（由外部回调 getMazeDesc() 提供）：
 *
 * {
 *   id: string | null,
 *   width: number,   // 网格宽度（x 方向，下标 i: 0..width-1）
 *   height: number,  // 网格高度（z 方向，下标 k: 0..height-1）
 *   start: { i, k }, // 起点格
 *   end: { i, k },   // 终点格
 *   traps:  Array<{ i, k }>, // 陷阱格
 *   blocks: Array<{ i, k }>, // 阻塞格（整格不能进）
 *   // 可选：edgeMask[k][i][4] 布尔数组，表示在该格 4 个方向是否有通路：
 *   // 0=上, 1=下, 2=左, 3=右；true = 可以走，false = 有墙/没路
 *   edgeMask?: boolean[][][]
 * }
 */

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

/**
 * 创建一个 RL 智能体。
 *
 * @param {() => MazeDesc|null} getMazeDesc   外部提供迷宫描述的回调
 * @param {Partial<typeof DEFAULT_RL_CONFIG>} userConfig 可选，覆盖默认超参数
 */
export function createRlAgent (getMazeDesc, userConfig = {}) {
  const cfg = {
    ...DEFAULT_RL_CONFIG,
    ...(userConfig || {})
  }

  // === 迷宫与 Q 表相关状态 ===
  let maze = null                   // 当前迷宫描述（标准化后）
  let mazeKey = null                // 用来检测迷宫是否变化的 key
  let width = 0
  let height = 0
  let startCell = null              // { i, k }
  let endCell = null                // { i, k }
  let trapFlags = null              // [height][width] => boolean
  let blockFlags = null             // [height][width] => boolean
  let edgeMask = null               // [height][width][4]，从外部传入的通路信息
  let Q = null                      // [height][width][4] => number，4 个动作（上/下/左/右）

  // === 当前 episode 内部状态 ===
  let curI = 0
  let curK = 0
  let curDone = true
  let curRewardSum = 0
  let curSteps = 0
  let lastStepReason = 'none'       // 'goal' | 'trap' | 'maxSteps' | 'reset' | ...

  // === 统计量 ===
  let episodeCount = 0
  let successCount = 0
  let epsilon = cfg.epsilonStart

  let lastRewardEpisode = 0
  let lastStepsEpisode = 0

  const recentRewards = []          // 最近 N 局的总奖励
  const recentSteps = []            // 最近 N 局的步数
  const recentSuccess = []          // 最近 N 局是否成功（bool）

  function pushRecent (reward, steps, success) {
    recentRewards.push(reward)
    recentSteps.push(steps)
    recentSuccess.push(success ? 1 : 0)
    const maxN = cfg.recentWindow
    if (recentRewards.length > maxN) recentRewards.shift()
    if (recentSteps.length > maxN) recentSteps.shift()
    if (recentSuccess.length > maxN) recentSuccess.shift()
  }

  // === 工具函数 ===

  function stateInBounds (i, k) {
    return i >= 0 && i < width && k >= 0 && k < height
  }

  function isBlock (i, k) {
    if (!stateInBounds(i, k) || !blockFlags) return true
    return !!blockFlags[k][i]
  }

  function isTrap (i, k) {
    if (!stateInBounds(i, k) || !trapFlags) return false
    return !!trapFlags[k][i]
  }

  function isGoal (i, k) {
    if (!endCell) return false
    return i === endCell.i && k === endCell.k
  }

  function alloc2dBool (h, w) {
    const arr = new Array(h)
    for (let k = 0; k < h; k++) {
      arr[k] = new Array(w)
      for (let i = 0; i < w; i++) arr[k][i] = false
    }
    return arr
  }

  function allocQTable (h, w) {
    const q = new Array(h)
    for (let k = 0; k < h; k++) {
      q[k] = new Array(w)
      for (let i = 0; i < w; i++) {
        // 4 个动作：0=上, 1=下, 2=左, 3=右
        q[k][i] = [0, 0, 0, 0]
      }
    }
    return q
  }

  /**
   * 从外部回调读取迷宫，并标准化
   */
  function readMazeFromCallback () {
  if (typeof getMazeDesc !== 'function') return null
  const raw = getMazeDesc()
  if (!raw) return null
  if (raw.width == null || raw.height == null || !raw.start || !raw.end) {
    return null
  }
  const w = raw.width | 0
  const h = raw.height | 0
  if (w <= 0 || h <= 0) return null

  const traps = (raw.traps || []).map(c => ({ i: c.i | 0, k: c.k | 0 }))
  const blocks = (raw.blocks || []).map(c => ({ i: c.i | 0, k: c.k | 0 }))
  const edgeMask = raw.edgeMask || null   // 这里不做检查，留给 rebuild 时做

  return {
    id: raw.id || null,
    width: w,
    height: h,
    start: { i: raw.start.i | 0, k: raw.start.k | 0 },
    end:   { i: raw.end.i   | 0, k: raw.end.k   | 0 },
    traps,
    blocks,
    edgeMask
  }
}


  /**
   * 当迷宫变化时，重新构建内部结构（Q 表、陷阱/阻塞表等）
   */
  function rebuildMazeInternal (m) {
    maze = m
    width = m.width
    height = m.height
    startCell = m.start
    endCell = m.end

      trapFlags = alloc2dBool(height, width)
  blockFlags = alloc2dBool(height, width)

  for (const c of m.traps || []) {
    if (stateInBounds(c.i, c.k)) trapFlags[c.k][c.i] = true
  }
  for (const c of m.blocks || []) {
    if (stateInBounds(c.i, c.k)) blockFlags[c.k][c.i] = true
  }

  // === 新增：根据 m.edgeMask 初始化本地 edgeMask，带形状检查，防止异常数据崩溃 ===
  edgeMask = null
  if (m.edgeMask && Array.isArray(m.edgeMask)) {
    const em = m.edgeMask
    if (em.length === height) {
      let ok = true
      for (let k = 0; k < height && ok; k++) {
        if (!Array.isArray(em[k]) || em[k].length !== width) {
          ok = false
          break
        }
        for (let i = 0; i < width && ok; i++) {
          const v = em[k][i]
          if (!Array.isArray(v) || v.length !== 4) {
            ok = false
            break
          }
        }
      }
      if (ok) edgeMask = em
    }
  }

  Q = allocQTable(height, width)
  resetStatsOnly()
  resetEpisodeInternal(true)// 初次重建时从新迷宫起点开始
  }

  /**
   * 检查迷宫是否需要同步（例如加载了新迷宫），
   * 如果发生变化，则重置 Q 表和统计。
   */
  function syncMazeIfNeeded () {
    const m = readMazeFromCallback()
    let newKey = null
    if (m) {
      newKey = `${m.id || 'noid'}|${m.width}x${m.height}|` +
               `${m.start.i},${m.start.k}|${m.end.i},${m.end.k}`
    }

    if (newKey === mazeKey) {
      return
    }

    mazeKey = newKey
    if (!m) {
      // 当前无迷宫，清空状态
      maze = null
      width = 0
      height = 0
      trapFlags = null
      blockFlags = null
      edgeMask = null  
      Q = null
      curDone = true
      return
    }

    rebuildMazeInternal(m)
  }

  // === Episode 控制 ===

  function resetStatsOnly () {
    episodeCount = 0
    successCount = 0
    epsilon = cfg.epsilonStart
    lastRewardEpisode = 0
    lastStepsEpisode = 0
    recentRewards.length = 0
    recentSteps.length = 0
    recentSuccess.length = 0
  }

  /**
   * 内部重置一局（位置重置到起点）
   * @param {boolean} [forceReason] 是否强制记一次 lastStepReason='reset'
   */
  function resetEpisodeInternal (forceReason = false) {
    if (!maze || !startCell) {
      curDone = true
      return false
    }
    curI = startCell.i
    curK = startCell.k
    curRewardSum = 0
    curSteps = 0
    curDone = false
    if (forceReason) lastStepReason = 'reset'
    return true
  }

  /**
   * 结束一局：更新统计、ε 衰减、压入滑动窗口，然后保持 curDone = true，
   * 等下一次 step 时再自动 resetEpisodeInternal。
   */
  function finishEpisode (success, reason) {
    episodeCount++
    if (success) successCount++

    lastRewardEpisode = curRewardSum
    lastStepsEpisode = curSteps
    lastStepReason = reason || (success ? 'goal' : 'terminate')

    pushRecent(curRewardSum, curSteps, success)

    // ε 衰减
    epsilon = Math.max(cfg.epsilonMin, epsilon * cfg.epsilonDecay)

    curDone = true
  }

  // === Q-learning 核心 ===

  function chooseAction (i, k) {
    if (!Q || !stateInBounds(i, k)) {
      // fallback：返回一个合法动作
      return Math.floor(Math.random() * 4)
    }
    const qs = Q[k][i]

    // ε-greedy
    if (Math.random() < epsilon) {
      return Math.floor(Math.random() * 4)
    }

    // 选择 Q 最大的动作
    let bestA = 0
    let bestQ = qs[0]
    for (let a = 1; a < 4; a++) {
      if (qs[a] > bestQ) {
        bestQ = qs[a]
        bestA = a
      }
    }
    return bestA
  }

  /**
   * 环境一步（不暴露给外部，内部使用）
   * 返回 { reward, done, success, reason, i, k }
   */
  function envStepOne () {
    if (!maze || !Q) {
      return { reward: 0, done: true, success: false, reason: 'no_maze', i: curI, k: curK }
    }

    // 如果上一局已经结束，则自动从起点重开一局
    if (curDone) {
      const ok = resetEpisodeInternal(true)
      if (!ok) {
        return { reward: 0, done: true, success: false, reason: 'no_start', i: curI, k: curK }
      }
    }

    const sI = curI
const sK = curK
const action = chooseAction(sI, sK)

// 先根据 edgeMask 判断该方向是否被墙挡住
let blockedByWall = false
if (edgeMask && stateInBounds(sI, sK)) {
  const row = edgeMask[sK]
  if (row) {
    const mask = row[sI]
    // 如果这一格没有 mask，或者对应方向为 false，就视为被墙挡住
    if (!mask || !mask[action]) {
      blockedByWall = true
    }
  }
}

// 动作：0=上(k-1), 1=下(k+1), 2=左(i-1), 3=右(i+1)
let nI = sI
let nK = sK
if (!blockedByWall) {
  if (action === 0) nK--
  else if (action === 1) nK++
  else if (action === 2) nI--
  else if (action === 3) nI++
}

let reward = -0.01    // 每步都有轻微时间惩罚
let done = false
let success = false
let reason = 'step'

// 撞墙 / 尝试穿墙 / 出界 / 阻塞 => 原地不动 + 额外惩罚
if (blockedByWall || !stateInBounds(nI, nK) || isBlock(nI, nK)) {
  nI = sI
  nK = sK
  reward -= 0.04
  reason = 'hit_wall'
} else if (isTrap(nI, nK)) {
  // 踩陷阱 => 本局结束 + 大惩罚
  reward -= 1.0
  done = true
  success = false
  reason = 'trap'
} else if (isGoal(nI, nK)) {
  // 到终点 => 本局成功 + 大奖励
  reward += 1.0
  done = true
  success = true
  reason = 'goal'
}


    // Q-learning 更新
    const qs = Q[sK][sI]
    const qsa = qs[action]

    let maxNext = 0
    if (!done) {
      const qNext = Q[nK][nI]
      maxNext = Math.max(qNext[0], qNext[1], qNext[2], qNext[3])
    }

    const target = reward + (done ? 0 : cfg.gamma * maxNext)
    qs[action] = qsa + cfg.alpha * (target - qsa)

    // 更新当前状态与统计
    curI = nI
    curK = nK
    curRewardSum += reward
    curSteps++

    // 步数上限
    if (curSteps >= cfg.maxStepsPerEpisode && !done) {
      done = true
      success = false
      reason = 'maxSteps'
    }

    if (done) {
      finishEpisode(success, reason)
    }

    return { reward, done, success, reason, i: curI, k: curK }
  }

  // === 对外暴露的 API ===

  /**
   * 训练指定步数（可能跨多个 episode）
   */
  function trainSteps (nSteps) {
    syncMazeIfNeeded()
    if (!maze || !Q) return

    const N = nSteps | 0
    if (N <= 0) return

    for (let t = 0; t < N; t++) {
      const res = envStepOne()
      if (!maze || !Q) break
      // 如果当前迷宫在训练过程中被外部切换，syncMazeIfNeeded 会在下次调用时重建
      if (!res) break
    }
  }

  /**
   * 训练完整一局（直到到达终点 / 踩陷阱 / 步数上限）
   * 返回本局的统计摘要。
   */
  function trainOneEpisode () {
    syncMazeIfNeeded()
    if (!maze || !Q) {
      return {
        steps: 0,
        totalReward: 0,
        success: false,
        reason: 'no_maze'
      }
    }

    // 如果上一局没结束，先标记为结束再开新局
    if (!curDone) {
      finishEpisode(false, 'force_terminate')
    }
    resetEpisodeInternal(true)

    let loops = 0
    const maxLoops = cfg.maxStepsPerEpisode + 5 // 足够大就行
    while (!curDone && loops < maxLoops) {
      envStepOne()
      loops++
    }

    return {
      steps: lastStepsEpisode,
      totalReward: lastRewardEpisode,
      success: (lastStepReason === 'goal'),
      reason: lastStepReason
    }
  }

  /**
   * 重置所有 Q 值与统计
   */
  function resetAll () {
    syncMazeIfNeeded()
    if (!maze) {
      // 即使当前无迷宫，也要把统计清零
      resetStatsOnly()
      curDone = true
      return
    }
    rebuildMazeInternal(maze)
  }

  /**
   * 提供给外部 Three.js 可视化使用：返回当前 agent 所在格子
   * @returns {{ i:number, k:number }|null}
   */
  function getVisualState () {
    if (!maze || !startCell) return null
    if (curDone) {
      // 如果当前局已结束，就返回起点位置（视觉上更稳定）
      return { i: startCell.i, k: startCell.k }
    }
    return { i: curI, k: curK }
  }

  /**
   * 获取当前统计信息，用于 UI 面板展示
   */
  function getStats () {
    const total = episodeCount || 0
    const succ = successCount || 0
    const successRateAll = total > 0 ? (succ / total * 100) : 0

    let avgRewardRecent = 0
    let avgStepsRecent = 0
    let successRateRecent = 0

    if (recentRewards.length > 0) {
      avgRewardRecent = recentRewards.reduce((a, b) => a + b, 0) / recentRewards.length
    }
    if (recentSteps.length > 0) {
      avgStepsRecent = recentSteps.reduce((a, b) => a + b, 0) / recentSteps.length
    }
    if (recentSuccess.length > 0) {
      const s = recentSuccess.reduce((a, b) => a + b, 0)
      successRateRecent = s / recentSuccess.length * 100
    }

    return {
      episodeCount: total,
      successRateAll,
      successRateRecent,
      avgRewardRecent,
      avgStepsRecent,
      lastRewardEpisode,
      lastStepsEpisode,
      epsilon,
      lastReason: lastStepReason
    }
  }

  /**
   * 给外部调试用：返回当前配置（只读）
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
