// src/rewards.js
//
// 奖励积分系统（独立模块）
// 负责把一局对抗的摘要信息 -> 总奖励 R_total + 各子项 + 0–100 积分
//
// 设计要点：
// - goal：是否到达终点（成功 / 失败）
// - time：在允许时间窗口内越快越好，超时会变成负数
// - path：路径越接近最短路径越好
// - explore：探索新的格子有奖励（目前 Arena 还没真正传这项，先预留）
// - safety：陷阱 / 碰撞惩罚（目前先按 0 传入，接口保留）

/**
 * 默认的奖励系数配置。
 *
 * 如果之后觉得评分太“严格/宽松”，只需要改这里的数值，不需要改后面的算法。
 */
export const defaultRewardConfig = {
  // 目标奖励：成功 / 失败
  goalSuccess: 1.0,   // 到达终点 +1
  goalFail: -1.0,     // 没有到终点 -1
  wGoal: 1.0,         // 目标奖励在总分中的权重

  // 时间相关：maxTime = shortestLen / baseSpeed * timeSlack
  baseSpeed: 3.0,     // 估计的基础速度（步长换算成秒用）
  timeSlack: 3.0,     // 允许的“最慢时间” ≈ 最短时间的 3 倍
  wTime: 0.4,         // 时间奖励权重（占比中等偏上）

  // 路径相关：允许偏离最短路径的倍率（越接近最短越好）
  pathSlackRatio: 1.8, // 如果路径长度达到 1.8 × 最短路径，路径奖励就降到 0
  wPath: 0.3,          // 路径奖励权重

  // 探索奖励：每个新格子的小奖励
  explorePerNewCell: 0.02,
  wExplore: 0.3,

  // 安全惩罚：踩陷阱 / 碰撞
  penaltyPerTrap: 1.0,      // 每次踩陷阱 -1
  penaltyPerCollision: 0.3, // 每次碰撞 -0.3

  // 最终积分的缩放，把 R_total 映射到 0～100 分
  // 约为：score ≈ 50 + 25 * R_total
  scoreScale: 25,
  scoreBase: 50
}

/**
 * 单个智能体的奖励计算。
 *
 * 输入：一个 agent 的表现摘要 + 奖励系数；
 * 输出：总奖励、最终积分、各子项奖励、原始元数据。
 *
 * @param {object} agent
 * @param {boolean} agent.reachedGoal 是否到达终点
 * @param {number} agent.timeSec 用时（秒）
 * @param {number} agent.pathLen 实际路径长度
 * @param {number} agent.shortestPathLen 最短路径长度（由迷宫给出）
 * @param {number} agent.trapsHit 本局踩到陷阱次数
 * @param {number} agent.collisions 本局碰撞次数
 * @param {number} agent.exploredNewCells 本局探索到的新格子数量
 * @param {string} agent.difficulty 迷宫难度（easy / medium / hard）
 * @param {object} cfg 奖励配置，可选，不传则用 defaultRewardConfig
 */
export function computeSingleAgentReward (agent, cfg = defaultRewardConfig) {
  const {
    reachedGoal,
    timeSec,
    pathLen,
    shortestPathLen,
    trapsHit = 0,
    collisions = 0,
    exploredNewCells = 0,
    difficulty = 'unknown'
  } = agent

  const tiny = 1e-6
  // 确保最短路径不为 0，避免除零
  const spLen = Math.max(shortestPathLen, tiny)

  // 1) 目标奖励：到达 = +1，没到 = -1
  const rGoal = reachedGoal ? cfg.goalSuccess : cfg.goalFail

  // 2) 时间奖励：最快 ≈ +1，走到 maxTime ≈ 0，超时变成负数
  //
  // 思路：
  //   - 先估一个“最短时间 estMinTime”；
  //   - 允许时间窗口 maxTime = estMinTime * timeSlack；
  //   - 实际耗时越接近 0 越好，越接近 maxTime 越接近 0，再往上就负数。
  let rTime = 0
  const estMinTime = spLen / Math.max(cfg.baseSpeed, tiny)
  const maxTime = estMinTime * cfg.timeSlack

  if (reachedGoal && timeSec > 0) {
    // 把时间裁剪在 [0, 2*maxTime] 内，避免极端值
    const t = Math.min(timeSec, maxTime * 2)
    const ratio = t / maxTime // <=1 理想，>1 太慢

    // 映射到 [-1, 1]：
    //   ratio = 0 -> 1（极快）
    //   ratio = 1 -> 0
    //   ratio = 2 -> -1
    rTime = 1 - 2 * Math.min(ratio, 2)
  } else if (!reachedGoal) {
    // 没到达终点：给一个固定的小负值，视为“浪费时间但没成功”
    rTime = -0.5
  }

  // 3) 路径奖励：越接近最短路径越好
  //
  // ratio = pathLen / spLen：
  //   - ratio = 1      -> 完美，rPath = 1
  //   - ratio = ratioMax(pathSlackRatio) -> rPath = 0
  //   - 再长也按 ratioMax 处理，不再继续减少
  let rPath = 0
  if (pathLen > 0 && spLen > 0) {
    const ratio = Math.min(pathLen / spLen, cfg.pathSlackRatio)
    const denom = cfg.pathSlackRatio - 1
    rPath = denom > 0 ? (cfg.pathSlackRatio - ratio) / denom : 0
  }

  // 4) 探索奖励：每个新格子一点点加分
  const rExplore = exploredNewCells * cfg.explorePerNewCell

  // 5) 安全惩罚：陷阱 & 碰撞
  const rTrap = -trapsHit * cfg.penaltyPerTrap
  const rColl = -collisions * cfg.penaltyPerCollision

  // 6) 汇总：线性组合所有子项
  const total =
    cfg.wGoal * rGoal +
    cfg.wTime * rTime +
    cfg.wPath * rPath +
    cfg.wExplore * rExplore +
    rTrap +
    rColl

  // 7) 映射为 0–100 积分（可在 UI/看板直接用）
  let score = cfg.scoreBase + cfg.scoreScale * total
  if (!Number.isFinite(score)) score = 0

  // 限制在 [0, 100] 且取整
  score = Math.max(0, Math.min(100, Math.round(score)))

  return {
    total,    // 原始总奖励（可能为负数）
    score,    // 映射后的 0~100 分
    // 各子项奖励，方便在看板上拆开展示
    components: {
      goal: rGoal,
      time: rTime,
      path: rPath,
      explore: rExplore,
      trap: rTrap,
      collision: rColl
    },
    // 元信息：方便后续在图表上展示“在哪种迷宫 / 用时多少”等
    meta: {
      difficulty,
      shortestPathLen: spLen,
      pathLen,
      timeSec,
      reachedGoal,
      trapsHit,
      collisions,
      exploredNewCells
    }
  }
}

/**
 * 一局对抗中 A/B 两个智能体的奖励。
 *
 * 说明：
 *   - summary.maze 含有迷宫共享信息（id / difficulty / shortestPathLen）；
 *   - summary.A / summary.B 分别是两个智能体的表现摘要；
 *   - 最终返回 { A: {...}, B: {...}, config: cfg }。
 *
 * @param {object} summary 对抗结果概要
 * @param {object} summary.maze 迷宫信息
 * @param {string} summary.maze.id
 * @param {string} summary.maze.difficulty
 * @param {number} summary.maze.shortestPathLen
 * @param {object} summary.A 智能体 A 的指标
 * @param {object} summary.B 智能体 B 的指标
 * @param {object} cfg 奖励配置对象（可选）
 */
export function computeEpisodeRewards (summary, cfg = defaultRewardConfig) {
  const { maze, A, B } = summary

  // 先构造一个“公共部分”：最短路径长度 + 难度
  const base = {
    shortestPathLen: maze.shortestPathLen,
    difficulty: maze.difficulty
  }

  // 通过扩展运算符把 base + A/B 各自的指标合并成 agent 对象
  const rewardA = computeSingleAgentReward({ ...base, ...A }, cfg)
  const rewardB = computeSingleAgentReward({ ...base, ...B }, cfg)

  return {
    A: rewardA,
    B: rewardB,
    config: cfg
  }
}
