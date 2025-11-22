// src/arena_rl_core.js
// 迷宫网格上的 Q-learning 核心逻辑（与 Three.js 解耦）
// ---------------------------------------------------------
// 本模块只依赖外部传入的 getMazeDesc() 回调，完全不接触 DOM / Three.js。
// 你可以把它看成是一个“纯算法模块”：负责维护 Q 表、进行训练、统计指标等。
//
// 典型调用方式：
//
//   import { createRlAgent } from './arena_rl_core.js'
//
//   const agent = createRlAgent(() => getMazeMetaFromArenaCore(), {
//     alpha: 0.3,
//     gamma: 0.95,
//     ...
//   })
//
//   // 训练若干步：
//   agent.trainSteps(1000)
//
//   // 训练一整局：
//   const ep = agent.trainOneEpisode()
//   console.log(ep.steps, ep.totalReward, ep.success)
//
//   // 获取统计信息：
//   const stats = agent.getStats()
//
// ---------------------------------------------------------

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
 *
 *   // 可选：edgeMask[k][i][4] 布尔数组，表示在该格 4 个方向是否有通路：
 *   // 0=上, 1=下, 2=左, 3=右；true = 可以走，false = 有墙/没路
 *   // 该 edgeMask 通常由 arena_core.js 中的“墙体信息”转换而来。
 *   edgeMask?: boolean[][][]
 * }
 */

/**
 * 默认 RL 超参数
 * - alpha   : 学习率 α
 * - gamma   : 折扣因子 γ
 * - epsilon : ε-greedy 探索率相关参数
 */
export const DEFAULT_RL_CONFIG = {
  alpha: 0.30,             // 学习率 α
  gamma: 0.95,             // 折扣因子 γ
  epsilonStart: 1.0,       // 初始探索率 ε0（完全随机）
  epsilonMin: 0.05,        // 最小探索率（保证始终有一点点探索）
  epsilonDecay: 0.995,     // 每局后的 ε 衰减系数
  maxStepsPerEpisode: 256, // 每局最大步数（防止无限循环）
  recentWindow: 100        // 统计滑动窗口大小（最近 N 局）
}

/**
 * 创建一个 RL 智能体（Q-learning Agent）。
 *
 * @template MazeDesc
 * @param {() => MazeDesc|null} getMazeDesc 外部提供迷宫描述的回调
 *        - 通常包装 arena_core.js 中的 getMazeMeta()
 * @param {Partial<typeof DEFAULT_RL_CONFIG>} userConfig 可选，覆盖默认超参数
 *
 * @returns {{
 *   trainSteps: (nSteps: number) => void,
 *   trainOneEpisode: () => { steps:number,totalReward:number,success:boolean,reason:string },
 *   resetAll: () => void,
 *   getVisualState: () => {i:number,k:number}|null,
 *   getStats: () => any,
 *   getConfig: () => any
 * }}
 */
export function createRlAgent (getMazeDesc, userConfig = {}) {
  // 合并默认配置和用户配置
  const cfg = {
    ...DEFAULT_RL_CONFIG,
    ...(userConfig || {})
  }

  // === 迷宫与 Q 表相关状态 ====================================

  /** @type {ReturnType<typeof readMazeFromCallback>|null} */
  let maze = null           // 当前迷宫描述（标准化后）
  let mazeKey = null        // 用来检测迷宫是否变化的 key（id + size + 起终点）

  let width = 0             // 迷宫宽度（格子数）
  let height = 0            // 迷宫高度（格子数）
  let startCell = null      // { i, k } 起点格
  let endCell = null        // { i, k } 终点格

  // 陷阱和阻塞格布尔矩阵：trapFlags[k][i] / blockFlags[k][i]
  let trapFlags = null      // [height][width] => boolean
  let blockFlags = null     // [height][width] => boolean

  // 通路信息（可选）：edgeMask[k][i][4]
  // - 由外部迷宫生成模块给出，用于判断“此方向是否被墙挡住”
  let edgeMask = null       // [height][width][4]

  // Q 表：Q[k][i][a] 表示在状态 (i,k) 采取动作 a 的价值
  // 动作顺序约定：0=上, 1=下, 2=左, 3=右
  let Q = null              // [height][width][4] => number

  // === 当前 episode 内部状态 ================================

  let curI = 0              // 当前格子横坐标 i
  let curK = 0              // 当前格子纵坐标 k
  let curDone = true        // 当前局是否已经结束
  let curRewardSum = 0      // 当前局累计奖励
  let curSteps = 0          // 当前局已经走了多少步

  // 当前局结束的原因：
  // - 'goal'        : 到达终点
  // - 'trap'        : 踩陷阱
  // - 'maxSteps'    : 超过最大步数上限
  // - 'reset'       : 通过 resetEpisodeInternal 重置
  // - 'force_terminate' : 上一局未结束被强制终止
  // - 'no_maze'     : 没有迷宫
  // - 'no_start'    : 没有起点
  // - ...
  let lastStepReason = 'none'

  // === 统计量 ==============================================

  let episodeCount = 0      // 总训练局数
  let successCount = 0      // 成功局数（到达终点）

  // 当前 ε（随训练逐渐衰减）
  let epsilon = cfg.epsilonStart

  // 上一局的总奖励、步数记录（方便 UI 展示）
  let lastRewardEpisode = 0
  let lastStepsEpisode = 0

  // 最近 N 局（滑动窗口）统计
  const recentRewards = []  // 最近 N 局的总奖励
  const recentSteps = []    // 最近 N 局的步数
  const recentSuccess = []  // 最近 N 局是否成功（1/0）

  /**
   * 向滑动窗口中压入一条记录
   * @param {number} reward
   * @param {number} steps
   * @param {boolean} success
   */
  function pushRecent (reward, steps, success) {
    recentRewards.push(reward)
    recentSteps.push(steps)
    recentSuccess.push(success ? 1 : 0)

    const maxN = cfg.recentWindow
    if (recentRewards.length > maxN) recentRewards.shift()
    if (recentSteps.length > maxN) recentSteps.shift()
    if (recentSuccess.length > maxN) recentSuccess.shift()
  }

  // === 工具函数 =============================================

  /**
   * 判断 (i,k) 是否在迷宫范围内
   */
  function stateInBounds (i, k) {
    return i >= 0 && i < width && k >= 0 && k < height
  }

  /**
   * 判断某格子是否为阻塞格（不可走）
   * - 如果 blockFlags 为空，则默认无阻塞，但越界仍然算“不能走”。
   */
  function isBlock (i, k) {
    if (!stateInBounds(i, k) || !blockFlags) return true
    return !!blockFlags[k][i]
  }

  /**
   * 判断某格子是否为陷阱格
   */
  function isTrap (i, k) {
    if (!stateInBounds(i, k) || !trapFlags) return false
    return !!trapFlags[k][i]
  }

  /**
   * 判断某格子是否为终点
   */
  function isGoal (i, k) {
    if (!endCell) return false
    return i === endCell.i && k === endCell.k
  }

  /**
   * 分配一个 h×w 的二维布尔数组，并全部初始化为 false。
   */
  function alloc2dBool (h, w) {
    const arr = new Array(h)
    for (let k = 0; k < h; k++) {
      arr[k] = new Array(w)
      for (let i = 0; i < w; i++) arr[k][i] = false
    }
    return arr
  }

  /**
   * 分配一个 h×w 的 Q 表：
   * - 对每个格子初始化 4 个动作的 Q 值为 0。
   */
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
   * 从外部回调读取迷宫，并做一次“标准化”：
   * - 保证 width/height/start/end 等为整数；
   * - traps / blocks 转成 {i,k} 数组；
   * - edgeMask 暂时不做深度检查（rebuild 时再做形状校验）。
   *
   * @returns {null|{
   *   id:string|null,
   *   width:number,
   *   height:number,
   *   start:{i:number,k:number},
   *   end:{i:number,k:number},
   *   traps:Array<{i:number,k:number}>,
   *   blocks:Array<{i:number,k:number}>,
   *   edgeMask:boolean[][][]|null
   * }}
   */
  function readMazeFromCallback () {
    if (typeof getMazeDesc !== 'function') return null

    const raw = getMazeDesc()
    if (!raw) return null
    if (raw.width == null || raw.height == null || !raw.start || !raw.end) {
      // 关键字段缺失 => 视为无效迷宫
      return null
    }

    const w = raw.width | 0
    const h = raw.height | 0
    if (w <= 0 || h <= 0) return null

    // 统一转换 traps / blocks 为整数网格坐标
    const traps = (raw.traps || []).map(c => ({ i: c.i | 0, k: c.k | 0 }))
    const blocks = (raw.blocks || []).map(c => ({ i: c.i | 0, k: c.k | 0 }))

    // edgeMask 只做存在性记录，形状检查留到 rebuild 时
    const edgeMask = raw.edgeMask || null

    return {
      id: raw.id || null,
      width: w,
      height: h,
      start: { i: raw.start.i | 0, k: raw.start.k | 0 },
      end: { i: raw.end.i | 0, k: raw.end.k | 0 },
      traps,
      blocks,
      edgeMask
    }
  }

  /**
   * 当迷宫变化时，重新构建内部结构（Q 表、陷阱/阻塞表、edgeMask 等）。
   * - 重建会清空所有 Q 值与统计信息，相当于“换了一个任务重新训练”。
   *
   * @param {ReturnType<typeof readMazeFromCallback>} m
   */
  function rebuildMazeInternal (m) {
    maze = m
    width = m.width
    height = m.height
    startCell = m.start
    endCell = m.end

    // 初始化陷阱和阻塞格布尔矩阵
    trapFlags = alloc2dBool(height, width)
    blockFlags = alloc2dBool(height, width)

    // 标记所有陷阱
    for (const c of m.traps || []) {
      if (stateInBounds(c.i, c.k)) trapFlags[c.k][c.i] = true
    }
    // 标记所有阻塞格
    for (const c of m.blocks || []) {
      if (stateInBounds(c.i, c.k)) blockFlags[c.k][c.i] = true
    }

    // === edgeMask 处理：根据 m.edgeMask 初始化本地 edgeMask，
    // === 带形状检查，防止异常数据导致崩溃 ======================
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

    // 分配新的 Q 表，并清零统计
    Q = allocQTable(height, width)
    resetStatsOnly()

    // 初次重建时，从新迷宫起点开始一局
    resetEpisodeInternal(true)
  }

  /**
   * 检查迷宫是否需要同步（例如外部加载了新迷宫）。
   * - 通过比较 mazeKey 判断“迷宫版本”是否变化；
   * - 一旦变化，重新 rebuildMazeInternal，并清空 Q 表和统计。
   */
  function syncMazeIfNeeded () {
    const m = readMazeFromCallback()
    let newKey = null
    if (m) {
      newKey = `${m.id || 'noid'}|${m.width}x${m.height}|` +
               `${m.start.i},${m.start.k}|${m.end.i},${m.end.k}`
    }

    if (newKey === mazeKey) {
      // 迷宫结构没变，不做任何事
      return
    }

    mazeKey = newKey

    if (!m) {
      // 当前无迷宫，清空所有状态
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

    // 迷宫发生变化 -> 重建内部结构
    rebuildMazeInternal(m)
  }

  // === Episode 控制 =========================================

  /**
   * 仅重置统计量（不改变当前迷宫，也不改变 Q 表结构）。
   * - 在 rebuildMazeInternal 中调用，以保证“从零开始统计”。
   */
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
   * 内部重置一局（将 agent 位置重置到起点）。
   *
   * @param {boolean} [forceReason=false]
   *   是否强制记一次 lastStepReason = 'reset'
   * @returns {boolean} 是否重置成功
   */
  function resetEpisodeInternal (forceReason = false) {
    if (!maze || !startCell) {
      // 当前没有迷宫或起点，无法开始一局
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
   * 结束一局：更新统计、ε 衰减、滑动窗口等。
   * - 不会立即重开下一局，只是标记 curDone = true。
   * - 下一次调用 envStepOne() 时，如果发现 curDone，为你自动 reset。
   *
   * @param {boolean} success 是否成功到达终点
   * @param {string} reason 结束原因（'goal'/'trap'/'maxSteps'/...）
   */
  function finishEpisode (success, reason) {
    episodeCount++
    if (success) successCount++

    lastRewardEpisode = curRewardSum
    lastStepsEpisode = curSteps
    lastStepReason = reason || (success ? 'goal' : 'terminate')

    pushRecent(curRewardSum, curSteps, success)

    // ε 衰减：逐渐减小探索率，但不低于 epsilonMin
    epsilon = Math.max(cfg.epsilonMin, epsilon * cfg.epsilonDecay)

    curDone = true
  }

  // === Q-learning 核心 =======================================

  /**
   * 在当前状态 (i,k) 选择一个动作（0..3）。
   * 策略：ε-greedy。
   * - 以概率 ε 随机选择（探索）；
   * - 以概率 1-ε 选择 Q 值最大的动作（利用）。
   */
  function chooseAction (i, k) {
    if (!Q || !stateInBounds(i, k)) {
      // 如果 Q 表还没准备好，就随机一个动作
      return Math.floor(Math.random() * 4)
    }
    const qs = Q[k][i]

    // ε-greedy：以概率 ε 随机选
    if (Math.random() < epsilon) {
      return Math.floor(Math.random() * 4)
    }

    // 否则选 Q 值最大的动作（如有多个并列最大，选最前的）
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
   * 环境一步（内部函数，不暴露给外部）。
   * - 依据当前状态 (curI, curK) 和策略 chooseAction() 决定动作；
   * - 应用 edgeMask / trap / block / goal 等环境规则，得到新状态 (nI,nK)；
   * - 按 Q-learning 公式更新 Q 表；
   * - 更新 episode 累计奖励与步数，并在必要时结束一局。
   *
   * @returns {{ reward:number, done:boolean, success:boolean, reason:string, i:number, k:number }}
   */
  function envStepOne () {
    if (!maze || !Q) {
      return {
        reward: 0,
        done: true,
        success: false,
        reason: 'no_maze',
        i: curI,
        k: curK
      }
    }

    // 如果上一局已经结束，则自动从起点重开一局
    if (curDone) {
      const ok = resetEpisodeInternal(true)
      if (!ok) {
        return {
          reward: 0,
          done: true,
          success: false,
          reason: 'no_start',
          i: curI,
          k: curK
        }
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

    // 动作编码：0=上(k-1), 1=下(k+1), 2=左(i-1), 3=右(i+1)
    let nI = sI
    let nK = sK
    if (!blockedByWall) {
      if (action === 0) nK--
      else if (action === 1) nK++
      else if (action === 2) nI--
      else if (action === 3) nI++
    }

    // 基本奖励：每走一步有轻微时间惩罚，鼓励尽快到达终点
    let reward = -0.01
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

    // ---------------- Q-learning 更新 ----------------
    const qs = Q[sK][sI]
    const qsa = qs[action]

    let maxNext = 0
    if (!done) {
      // 如果还没结束，使用下一状态的最大 Q 值作为目标的一部分
      const qNext = Q[nK][nI]
      maxNext = Math.max(qNext[0], qNext[1], qNext[2], qNext[3])
    }

    // 目标值 target = r + γ * max_a' Q(s', a')（终止状态不加后项）
    const target = reward + (done ? 0 : cfg.gamma * maxNext)
    // Q(s,a) ← Q(s,a) + α * (target - Q(s,a))
    qs[action] = qsa + cfg.alpha * (target - qsa)

    // 更新当前状态与统计
    curI = nI
    curK = nK
    curRewardSum += reward
    curSteps++

    // 步数上限检查
    if (curSteps >= cfg.maxStepsPerEpisode && !done) {
      done = true
      success = false
      reason = 'maxSteps'
    }

    // 如果这一局已经结束，则更新统计和 ε
    if (done) {
      finishEpisode(success, reason)
    }

    return { reward, done, success, reason, i: curI, k: curK }
  }

  // === 对外暴露的 API =======================================

  /**
   * 训练指定步数（可能跨越多个 episode）。
   * - 内部会自动处理“当前局已结束 -> 开新局”的逻辑。
   *
   * @param {number} nSteps 要执行的环境步数
   */
  function trainSteps (nSteps) {
    syncMazeIfNeeded()
    if (!maze || !Q) return

    const N = nSteps | 0
    if (N <= 0) return

    for (let t = 0; t < N; t++) {
      const res = envStepOne()
      if (!maze || !Q) break
      if (!res) break
      // 如果训练过程中外部切换迷宫，在下一次 trainSteps/ trainOneEpisode 前
      // syncMazeIfNeeded 会检测并重建内部结构。
    }
  }

  /**
   * 训练“完整一局”：
   * - 从起点出发，直到到达终点 / 踩陷阱 / 达到步数上限。
   * - 返回该局的统计摘要（步数、总奖励、是否成功、结束原因）。
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

    // 如果上一局还没结束，先强制结束一次，避免状态串局
    if (!curDone) {
      finishEpisode(false, 'force_terminate')
    }
    // 然后开启新一局
    resetEpisodeInternal(true)

    let loops = 0
    const maxLoops = cfg.maxStepsPerEpisode + 5 // 略大于步数上限即可
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
   * 重置所有 Q 值与统计信息。
   * - 会重新根据“当前迷宫”分配 Q 表，清空所有学习结果。
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
   * 提供给外部 Three.js 可视化使用：返回当前 agent 所在格子。
   * - 如果当前局已结束，则返回起点位置（视觉上更稳定）。
   *
   * @returns {{ i:number, k:number }|null}
   */
  function getVisualState () {
    if (!maze || !startCell) return null
    if (curDone) {
      return { i: startCell.i, k: startCell.k }
    }
    return { i: curI, k: curK }
  }

  /**
   * 获取当前统计信息，用于 UI 面板展示。
   *
   * @returns {{
   *   episodeCount:number,
   *   successRateAll:number,
   *   successRateRecent:number,
   *   avgRewardRecent:number,
   *   avgStepsRecent:number,
   *   lastRewardEpisode:number,
   *   lastStepsEpisode:number,
   *   epsilon:number,
   *   lastReason:string
   * }}
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
   * 给外部调试用：返回当前配置（浅拷贝，只读）。
   */
  function getConfig () {
    return { ...cfg, epsilon }
  }

  // 初始化一次（如果此时还没加载迷宫，也不会报错）
  syncMazeIfNeeded()

  // 返回给外部使用的 API
  return {
    trainSteps,
    trainOneEpisode,
    resetAll,
    getVisualState,
    getStats,
    getConfig
  }
}
