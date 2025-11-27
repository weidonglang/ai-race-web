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
 * 默认的奖励系数配置（之后想调就改这里即可）
 */
export const defaultRewardConfig = {
  // 目标奖励：成功 / 失败
  goalSuccess: 1.0,
  goalFail: -1.0,
  wGoal: 1.0,

  // 时间相关：maxTime = shortestLen / baseSpeed * timeSlack
  baseSpeed: 3.0,        // 估计值，实际可按 agent 平均速度改
  timeSlack: 3.0,        // 最慢允许时间 ≈ 最短时间的 3 倍
  wTime: 0.4,            // 时间奖励权重（占比中等偏上）

  // 路径相关：允许偏离最短路径的倍率
  pathSlackRatio: 1.8,   // 最坏情况：路径长度 = 1.8 × 最短路径
  wPath: 0.3,            // 路径奖励权重

  // 探索奖励：每个新格子的基础奖励
  explorePerNewCell: 0.02,
  wExplore: 0.3,

  // 安全惩罚
  penaltyPerTrap: 1.0,      // 每次踩陷阱 -1
  penaltyPerCollision: 0.3, // 每次碰撞 -0.3

  // 最终积分的缩放：score ≈ 50 + 25 * R_total
  scoreScale: 25,
  scoreBase: 50
}

/**
 * 单个智能体的奖励计算
 * @param {object} agent
 * @param {boolean} agent.reachedGoal      是否到达终点
 * @param {number}  agent.timeSec          用时（秒）
 * @param {number}  agent.pathLen          实际路径长度
 * @param {number}  agent.shortestPathLen  最短路径长度（由迷宫给出）
 * @param {number}  agent.trapsHit         本局踩到陷阱次数
 * @param {number}  agent.collisions       本局碰撞次数
 * @param {number}  agent.exploredNewCells 本局探索到的新格子数量
 * @param {string}  agent.difficulty       迷宫难度（easy / medium / hard）
 * @param {object}  cfg                    奖励配置
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
  const spLen = Math.max(shortestPathLen, tiny)

  // 1) 目标奖励：到达 = +1，没到 = -1
  const rGoal = reachedGoal ? cfg.goalSuccess : cfg.goalFail

  // 2) 时间奖励：最快 ≈ +1，走到 maxTime ≈ 0，超时变成负数
  let rTime = 0
  const estMinTime = spLen / Math.max(cfg.baseSpeed, tiny)
  const maxTime = estMinTime * cfg.timeSlack

  if (reachedGoal && timeSec > 0) {
    const t = Math.min(timeSec, maxTime * 2) // 上限裁剪
    const ratio = t / maxTime                // <=1 理想，>1 太慢
    // 映射到 [-1, 1]，ratio=0 -> 1（极快），ratio=1 -> 0，ratio=2 -> -1
    rTime = 1 - 2 * Math.min(ratio, 2)
  } else if (!reachedGoal) {
    // 没到达，一般给固定小负值
    rTime = -0.5
  }

  // 3) 路径奖励：越接近最短路径越好
  let rPath = 0
  if (pathLen > 0 && spLen > 0) {
    const ratio = Math.min(pathLen / spLen, cfg.pathSlackRatio)
    // ratio = 1 -> 1；ratio = pathSlackRatio -> 0
    const denom = cfg.pathSlackRatio - 1
    rPath = denom > 0 ? (cfg.pathSlackRatio - ratio) / denom : 0
  }

  // 4) 探索奖励：每个新格子一点点加分
  const rExplore = exploredNewCells * cfg.explorePerNewCell

  // 5) 安全惩罚：陷阱 & 碰撞
  const rTrap = -trapsHit * cfg.penaltyPerTrap
  const rColl = -collisions * cfg.penaltyPerCollision

  // 6) 汇总
  const total =
    cfg.wGoal * rGoal +
    cfg.wTime * rTime +
    cfg.wPath * rPath +
    cfg.wExplore * rExplore +
    rTrap + rColl

  // 映射为 0–100 积分（可在 UI/看板直接用）
  let score = cfg.scoreBase + cfg.scoreScale * total
  if (!Number.isFinite(score)) score = 0
  score = Math.max(0, Math.min(100, Math.round(score)))

  return {
    total,
    score,
    components: {
      goal: rGoal,
      time: rTime,
      path: rPath,
      explore: rExplore,
      trap: rTrap,
      collision: rColl
    },
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
 * 一局对抗中 A/B 两个智能体的奖励
 * @param {object} summary
 * @param {object} summary.maze
 * @param {string} summary.maze.id
 * @param {string} summary.maze.difficulty
 * @param {number} summary.maze.shortestPathLen
 * @param {object} summary.A
 * @param {object} summary.B
 * @param {object} cfg
 */
export function computeEpisodeRewards (summary, cfg = defaultRewardConfig) {
  const { maze, A, B } = summary
  const base = {
    shortestPathLen: maze.shortestPathLen,
    difficulty: maze.difficulty
  }

  const rewardA = computeSingleAgentReward({ ...base, ...A }, cfg)
  const rewardB = computeSingleAgentReward({ ...base, ...B }, cfg)

  return {
    A: rewardA,
    B: rewardB,
    config: cfg
  }
}
