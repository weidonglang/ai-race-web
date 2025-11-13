// src/arena.js
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { computeEpisodeRewards, defaultRewardConfig } from './rewards.js'

/* ------------------- 基础 Three.js 场景 ------------------- */

const root = document.getElementById('arena-viewport')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
camera.position.set(12, 14, 12)
camera.lookAt(0, 0, 0)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
controls.update()

// 光照
const hemi = new THREE.HemisphereLight(0xffffff, 0x111827, 0.8)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(8, 12, 6)
scene.add(dir)

/* ------------------- 迷宫渲染 & 图结构 ------------------- */

// 迷宫数据 & 几何 group
let mazeSize = null            // { nx, nz, cellSize }
let mazeGroup = null           // 包含墙、陷阱、start/goal 的 Group
let ground = null              // 地板
let grid = null                // 网格
let mazePathPoints = null      // THREE.Vector3[] 最短路径（世界坐标）
let trapMap = null             // 布尔矩阵 [k][i] 表示该格子是否为陷阱

let currentMazeMeta = { id: null, difficulty: null }

// 图结构 & 距离场（用于路径规划）
let mazeStartCell = null       // { i, k }
let mazeGoalCell = null        // { i, k }
let mazeNeighbors = null       // [k][i] -> [{i,k}, ...]
let mazeDistField = null       // [k][i] -> 距离终点的 BFS 步数
let shortestPathCellCount = 0  // 最短路径的步数（格子数）

// 从 Python 生成脚本约定的命名：maze_easy_000.json 等
const MAZE_COUNTS = {
  easy: 5,
  medium: 5,
  hard: 5
}

const WALL_HEIGHT = 1.6
const WALL_THICKNESS = 0.16

// start / goal markers
let startMarker = null
let goalMarker = null

function disposeMesh (obj) {
  if (!obj) return
  if (obj.geometry) obj.geometry.dispose()
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
    else obj.material.dispose()
  }
}

function clearMaze () {
  if (mazeGroup) {
    mazeGroup.traverse(obj => {
      if (obj.isMesh) disposeMesh(obj)
    })
    scene.remove(mazeGroup)
    mazeGroup = null
  }
  if (startMarker) {
    scene.remove(startMarker)
    disposeMesh(startMarker)
    startMarker = null
  }
  if (goalMarker) {
    scene.remove(goalMarker)
    disposeMesh(goalMarker)
    goalMarker = null
  }
  mazePathPoints = null
  mazeSize = null
  trapMap = null
  currentMazeMeta = { id: null, difficulty: null }

  mazeStartCell = null
  mazeGoalCell = null
  mazeNeighbors = null
  mazeDistField = null
  shortestPathCellCount = 0
}

function rebuildGround () {
  if (ground) { scene.remove(ground); disposeMesh(ground); ground = null }
  if (grid) { scene.remove(grid); grid = null }

  if (!mazeSize) return
  const w = mazeSize.nx * mazeSize.cellSize + 2
  const d = mazeSize.nz * mazeSize.cellSize + 2

  const floorGeo = new THREE.PlaneGeometry(w, d, 1, 1)
  floorGeo.rotateX(-Math.PI / 2)
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0, roughness: 1 })
  ground = new THREE.Mesh(floorGeo, floorMat)
  ground.receiveShadow = true
  scene.add(ground)

  grid = new THREE.GridHelper(w, mazeSize.nx, 0x374151, 0x1f2933)
  grid.position.y = 0.01
  scene.add(grid)
}

// 把迷宫格子坐标 (i,k) 映射到世界坐标
function gridToWorld (i, k, y = 0.3) {
  if (!mazeSize) return new THREE.Vector3()
  const cs = mazeSize.cellSize
  const width = mazeSize.nx * cs
  const depth = mazeSize.nz * cs
  const originX = -width / 2 + cs / 2
  const originZ = -depth / 2 + cs / 2
  return new THREE.Vector3(originX + i * cs, y, originZ + k * cs)
}

// 从世界坐标反推迷宫格子坐标 (i,k)
function worldToCell (pos) {
  if (!mazeSize) return null
  const cs = mazeSize.cellSize
  const width = mazeSize.nx * cs
  const depth = mazeSize.nz * cs
  const originX = -width / 2 + cs / 2
  const originZ = -depth / 2 + cs / 2

  const iFloat = (pos.x - originX) / cs
  const kFloat = (pos.z - originZ) / cs

  const i = Math.round(iFloat)
  const k = Math.round(kFloat)
  if (i < 0 || i >= mazeSize.nx || k < 0 || k >= mazeSize.nz) return null
  return { i, k }
}

// 计算路径长度（用于奖励中的路径效率）
function computePathLength (points) {
  if (!points || points.length < 2) return 0
  let L = 0
  for (let i = 0; i < points.length - 1; i++) {
    L += points[i].distanceTo(points[i + 1])
  }
  return L
}

/**
 * 根据 cells 的 walls 信息构建邻接表 & 从终点做一次 BFS 得到距离场
 */
function buildGraphAndDistances (data) {
  if (!mazeSize) return
  const { nx, nz } = mazeSize

  mazeNeighbors = Array.from({ length: nz }, () =>
    Array.from({ length: nx }, () => [])
  )

  // 建邻接表
  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const walls = cell.walls
      const neighbors = mazeNeighbors[k][i]

      // N: k-1
      if (!walls.N && k > 0) neighbors.push({ i, k: k - 1 })
      // S: k+1
      if (!walls.S && k < nz - 1) neighbors.push({ i, k: k + 1 })
      // W: i-1
      if (!walls.W && i > 0) neighbors.push({ i: i - 1, k })
      // E: i+1
      if (!walls.E && i < nx - 1) neighbors.push({ i: i + 1, k })
    }
  }

  // BFS 计算终点到各点的“步数距离”
  mazeDistField = Array.from({ length: nz }, () => Array(nx).fill(Infinity))
  if (!mazeGoalCell) return

  const q = []
  mazeDistField[mazeGoalCell.k][mazeGoalCell.i] = 0
  q.push({ i: mazeGoalCell.i, k: mazeGoalCell.k })

  while (q.length > 0) {
    const cur = q.shift()
    const curD = mazeDistField[cur.k][cur.i]
    const neigh = mazeNeighbors[cur.k][cur.i] || []
    for (const n of neigh) {
      const old = mazeDistField[n.k][n.i]
      if (curD + 1 < old) {
        mazeDistField[n.k][n.i] = curD + 1
        q.push({ i: n.i, k: n.k })
      }
    }
  }
}

/**
 * 基于距离场 + 探索偏好，为一个智能体生成一条路径（格子序列）
 * - exploreBias 越大，越愿意选“不是最优”的邻居（探索更多，但更慢、更容易踩陷阱）
 * - maxFactor 控制路径最长允许步数（相对于最短路）
 */
function generatePathCells (exploreBias, maxFactor = 4) {
  if (!mazeStartCell || !mazeGoalCell || !mazeNeighbors || !mazeDistField) return null

  const keyOf = (c) => `${c.i},${c.k}`
  const goalKey = keyOf(mazeGoalCell)

  const shortestSteps = Math.max(shortestPathCellCount || 1, 1)
  const maxSteps = Math.max(Math.floor(shortestSteps * maxFactor), shortestSteps + 2)

  let cur = { i: mazeStartCell.i, k: mazeStartCell.k }
  let prevKey = null
  let reachedGoal = false

  const path = [cur]
  const visited = new Set([keyOf(cur)])

  for (let steps = 0; steps < maxSteps; steps++) {
    const curKey = keyOf(cur)
    if (curKey === goalKey) {
      reachedGoal = true
      break
    }

    const neigh = mazeNeighbors[cur.k][cur.i] || []
    if (neigh.length === 0) break

    const curDist = mazeDistField[cur.k][cur.i]
    // 只考虑可达终点的邻居（dist < ∞）
    const candidates = neigh.filter(n => mazeDistField[n.k][n.i] < Infinity)
    if (candidates.length === 0) break

    // 贪心候选：距离最小的邻居
    let greedy = []
    let bestDist = Infinity
    for (const n of candidates) {
      const d = mazeDistField[n.k][n.i]
      if (d < bestDist - 1e-6) {
        bestDist = d
        greedy = [n]
      } else if (Math.abs(d - bestDist) < 1e-6) {
        greedy.push(n)
      }
    }

    // 探索候选：不会立即回头、距离不要比当前大太多
    const exploreCandidates = candidates.filter(n => {
      const nk = keyOf(n)
      if (prevKey && nk === prevKey) return false
      const d = mazeDistField[n.k][n.i]
      return d <= curDist + 1.5
    })

    let chosen
    const r = Math.random()
    if (exploreCandidates.length > 0 && r < exploreBias) {
      // 探索：从 exploreCandidates 随机选一个
      chosen = exploreCandidates[Math.floor(Math.random() * exploreCandidates.length)]
    } else {
      // 利用：在 greedy 中随机打破平局
      const base = greedy.length > 0 ? greedy : candidates
      chosen = base[Math.floor(Math.random() * base.length)]
    }

    prevKey = curKey
    cur = { i: chosen.i, k: chosen.k }
    path.push(cur)
    visited.add(keyOf(cur))

    if (keyOf(cur) === goalKey) {
      reachedGoal = true
      break
    }
  }

  if (!reachedGoal) return null
  return path
}

function buildMazeFromData (data) {
  clearMaze()

  const { nx, nz, cellSize } = data.size
  mazeSize = { nx, nz, cellSize: cellSize || 1.0 }
  currentMazeMeta.id = data.id || 'unknown'
  currentMazeMeta.difficulty = data.difficulty || 'unknown'

  mazeStartCell = { i: data.start.i, k: data.start.k }
  mazeGoalCell = { i: data.goal.i, k: data.goal.k }
  shortestPathCellCount = (data.shortestPath && data.shortestPath.length) || 0

  // 初始化陷阱矩阵
  trapMap = Array.from({ length: nz }, () => Array(nx).fill(false))

  rebuildGround()

  mazeGroup = new THREE.Group()
  scene.add(mazeGroup)

  const cs = mazeSize.cellSize
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4b5563 })
  const trapMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c })

  // 遍历每个格子，根据 walls.N/S/E/W 生成墙体 & 陷阱
  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const { walls, trap } = cell
      const center = gridToWorld(i, k, WALL_HEIGHT / 2)

      // 陷阱：地面上的红色小方块
      if (trap) {
        trapMap[k][i] = true
        const trapGeo = new THREE.BoxGeometry(cs * 0.6, 0.05, cs * 0.6)
        const trapMesh = new THREE.Mesh(trapGeo, trapMat)
        const trapPos = gridToWorld(i, k, 0.03)
        trapMesh.position.copy(trapPos)
        mazeGroup.add(trapMesh)
      }

      // 为简单起见，不做去重：相邻格子可能生成重叠墙，但视觉上没问题
      // 北墙：沿 x 方向
      if (walls.N) {
        const geo = new THREE.BoxGeometry(cs, WALL_HEIGHT, WALL_THICKNESS)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x, WALL_HEIGHT / 2, center.z - cs / 2)
        mazeGroup.add(mesh)
      }
      // 南墙
      if (walls.S) {
        const geo = new THREE.BoxGeometry(cs, WALL_HEIGHT, WALL_THICKNESS)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x, WALL_HEIGHT / 2, center.z + cs / 2)
        mazeGroup.add(mesh)
      }
      // 西墙：沿 z 方向
      if (walls.W) {
        const geo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, cs)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x - cs / 2, WALL_HEIGHT / 2, center.z)
        mazeGroup.add(mesh)
      }
      // 东墙
      if (walls.E) {
        const geo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, cs)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x + cs / 2, WALL_HEIGHT / 2, center.z)
        mazeGroup.add(mesh)
      }
    }
  }

  // 起点 / 终点标记
  const startPos = gridToWorld(data.start.i, data.start.k, 0.25)
  const goalPos = gridToWorld(data.goal.i, data.goal.k, 0.25)

  const markerGeo = new THREE.SphereGeometry(0.25, 24, 16)
  const startMat = new THREE.MeshStandardMaterial({ color: 0x22c55e })
  const goalMat = new THREE.MeshStandardMaterial({ color: 0xf97316 })

  startMarker = new THREE.Mesh(markerGeo, startMat)
  goalMarker = new THREE.Mesh(markerGeo, goalMat)
  startMarker.position.copy(startPos)
  goalMarker.position.copy(goalPos)
  mazeGroup.add(startMarker, goalMarker)

  // 最短路径转成世界坐标点序列（作为“理论最优”参考）
  const sp = data.shortestPath || []
  mazePathPoints = sp.map(cell => gridToWorld(cell.i, cell.k, 0.3))

  // 构建邻接表 + 距离场（供路径规划使用）
  buildGraphAndDistances(data)

  // 摄像机对准迷宫中心
  controls.target.set(0, 0, 0)
  controls.update()

  // 更新面板显示
  updatePanel()
}

async function loadRandomMaze (difficulty) {
  const count = MAZE_COUNTS[difficulty] || 1
  const idx = Math.floor(Math.random() * count)
  const filename = `mazes/maze_${difficulty}_${String(idx).padStart(3, '0')}.json`

  try {
    const res = await fetch(filename)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    buildMazeFromData(data)
    console.log(`[Arena] Loaded maze: ${filename}`)
  } catch (err) {
    console.error('[Arena] 迷宫加载失败', err)
    alert(`加载迷宫失败：${filename}\n请确认文件存在，且通过 maze_*.py 已生成。`)
  }
}

/* ------------------- Agent 跑路径 + 探索/陷阱统计 ------------------- */

class AgentRunner {
  constructor (mesh, speed = 3.0) {
    this.mesh = mesh
    this.speed = speed
    this.path = null
    this.segIndex = 0
    this.running = false
    this.done = false

    // 探索 / 陷阱统计
    this.visitedCells = new Set()   // 'i,k'
    this.exploredNewCells = 0
    this.trapsHit = 0
    this._lastCellKey = null        // 防止同一帧重复计算
    this._trapCells = new Set()     // 已经统计过陷阱的格子
  }

  _resetStats () {
    this.visitedCells = new Set()
    this._trapCells = new Set()
    this.exploredNewCells = 0
    this.trapsHit = 0
    this._lastCellKey = null
  }

  resetWithPath (path) {
    if (!path || path.length < 2) {
      this.path = null
      this.running = false
      this.done = false
      this.mesh.visible = false
      this._resetStats()
      return
    }
    // 拷贝一份路径
    this.path = path.map(p => p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))
    this.segIndex = 0
    this.running = false
    this.done = false
    this.mesh.visible = false
    this.mesh.position.copy(this.path[0])
    this._resetStats()
    // 初始格子也视为访问一次 & 探索一次
    this._updateCellMetrics()
  }

  start () {
    if (!this.path || this.path.length < 2) return false
    this.running = true
    this.done = false
    this.mesh.visible = true
    return true
  }

  stop () {
    this.running = false
  }

  _updateCellMetrics () {
    if (!mazeSize) return
    const cell = worldToCell(this.mesh.position)
    if (!cell) return
    const key = `${cell.i},${cell.k}`

    // 防止同一格子在连续帧重复计数
    if (key === this._lastCellKey) return
    this._lastCellKey = key

    // 探索统计
    if (!this.visitedCells.has(key)) {
      this.visitedCells.add(key)
      this.exploredNewCells++
    }

    // 陷阱统计：同一格子只算一次
    if (trapMap && trapMap[cell.k] && trapMap[cell.k][cell.i]) {
      if (!this._trapCells.has(key)) {
        this._trapCells.add(key)
        this.trapsHit++
      }
    }
  }

  update (dt) {
    if (!this.running || this.done || !this.path) return
    const pos = this.mesh.position
    let target = this.path[this.segIndex + 1]
    if (!target) {
      this.done = true
      this.running = false
      return
    }
    const dir = new THREE.Vector3().subVectors(target, pos)
    const dist = dir.length()
    if (dist < 0.05) {
      this.segIndex++
      target = this.path[this.segIndex + 1]
      if (!target) {
        this.done = true
        this.running = false
        return
      }
    }
    dir.normalize()
    pos.addScaledVector(dir, this.speed * dt)

    // 每次更新位置以后，根据位置更新探索 / 陷阱统计
    this._updateCellMetrics()
  }

  getPathLength () {
    return computePathLength(this.path)
  }
}

/* ------------------- 进化策略：元参数（速度 + 探索偏好） ------------------- */

// 为了让平均积分逐渐变高，我们为每个 Agent 维护一套“基础参数” + 随机扰动，
// 采用 (1+1)-ES / hill-climbing 风格的更新：如果这次候选参数得到的 score 更好，
// 就把基础参数朝候选方向挪一点。类似简化版进化策略。

const policyA = {
  baseSpeed: 3.0,
  baseExploreBias: 0.15,
  bestScore: 0,
  sigmaSpeed: 0.4,
  sigmaBias: 0.2,
  lastCandidate: null
}

const policyB = {
  baseSpeed: 2.8,
  baseExploreBias: 0.4,
  bestScore: 0,
  sigmaSpeed: 0.4,
  sigmaBias: 0.2,
  lastCandidate: null
}

// A、B 共享的“允许最大绕路倍率”
const MAX_STEPS_FACTOR_A = 3.0
const MAX_STEPS_FACTOR_B = 4.0

// Box–Muller 正态采样
function randomNormal () {
  const u = Math.random() || 1e-6
  const v = Math.random() || 1e-6
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function samplePolicy (meta) {
  const cand = {
    speed: meta.baseSpeed + randomNormal() * meta.sigmaSpeed,
    exploreBias: meta.baseExploreBias + randomNormal() * meta.sigmaBias
  }
  // 裁剪范围，避免飞到奇怪值
  cand.speed = Math.min(Math.max(cand.speed, 1.0), 6.0)
  cand.exploreBias = Math.min(Math.max(cand.exploreBias, 0.0), 0.9)
  meta.lastCandidate = cand
  return cand
}

function updatePolicy (meta, score) {
  const cand = meta.lastCandidate
  if (!cand) return
  // 简单策略：如果这局得分超过历史 best，就向候选靠拢
  if (score > meta.bestScore) {
    const lr = 0.35 // “学习率”，可以之后根据曲线调
    meta.baseSpeed = (1 - lr) * meta.baseSpeed + lr * cand.speed
    meta.baseExploreBias = (1 - lr) * meta.baseExploreBias + lr * cand.exploreBias
    meta.bestScore = score
    console.log('[Policy] Updated meta:', {
      baseSpeed: meta.baseSpeed.toFixed(3),
      baseExploreBias: meta.baseExploreBias.toFixed(3),
      bestScore: meta.bestScore.toFixed(2)
    })
  }
}

// 两个选手：A（蓝），B（橙）
const agentGeom = new THREE.SphereGeometry(0.3, 20, 20)
const matA = new THREE.MeshStandardMaterial({ color: 0x60a5fa })
const matB = new THREE.MeshStandardMaterial({ color: 0xf97316 })

const meshA = new THREE.Mesh(agentGeom, matA)
const meshB = new THREE.Mesh(agentGeom, matB)
meshA.castShadow = meshB.castShadow = true
meshA.visible = meshB.visible = false
scene.add(meshA, meshB)

const runnerA = new AgentRunner(meshA, 3.0)
const runnerB = new AgentRunner(meshB, 2.8)

/* ------------------- 对抗生命周期 & UI ------------------- */

const arena = {
  episode: 0,
  status: 'idle',      // 'idle' | 'running' | 'paused' | 'finished'
  paused: false,
  elapsedA: 0,
  elapsedB: 0,
  doneA: false,
  doneB: false,
  scoreA: 0,
  scoreB: 0
}

// 面板元素
const $ep = document.getElementById('arenaEp')
const $status = document.getElementById('arenaStatus')
const $timeA = document.getElementById('arenaTimeA')
const $timeB = document.getElementById('arenaTimeB')
const $doneA = document.getElementById('arenaDoneA')
const $doneB = document.getElementById('arenaDoneB')
const $winner = document.getElementById('arenaWinner')
const $scoreA = document.getElementById('arenaScoreA')
const $scoreB = document.getElementById('arenaScoreB')

const $mazeId = document.getElementById('arenaMazeId')
const $mazeDiff = document.getElementById('arenaMazeDiff')
const $mazeSize = document.getElementById('arenaMazeSize')

const btnStart = document.getElementById('btnArenaStart')
const btnPause = document.getElementById('btnArenaPause')
const btnNext = document.getElementById('btnArenaNext')
const btnClear = document.getElementById('btnArenaClear')

const btnMazeEasy = document.getElementById('btnMazeEasy')
const btnMazeMedium = document.getElementById('btnMazeMedium')
const btnMazeHard = document.getElementById('btnMazeHard')

const HISTORY_KEY = 'arena_runs'

function computeWinnerLabel () {
  if (!arena.doneA && !arena.doneB) return '-'
  if (arena.doneA && !arena.doneB) return 'A'
  if (!arena.doneA && arena.doneB) return 'B'
  // 都到达，按用时判
  if (arena.elapsedA < arena.elapsedB - 1e-3) return 'A'
  if (arena.elapsedB < arena.elapsedA - 1e-3) return 'B'
  return '平局'
}

function updatePanel () {
  $ep.textContent = String(arena.episode)
  $status.textContent = arena.status + (arena.paused ? ' (Paused)' : '')
  $timeA.textContent = arena.elapsedA.toFixed(2) + ' s'
  $timeB.textContent = arena.elapsedB.toFixed(2) + ' s'
  $doneA.textContent = arena.doneA ? '是' : '否'
  $doneB.textContent = arena.doneB ? '是' : '否'
  $winner.textContent = computeWinnerLabel()
  $scoreA.textContent = Number.isFinite(arena.scoreA) ? String(arena.scoreA) : '0'
  $scoreB.textContent = Number.isFinite(arena.scoreB) ? String(arena.scoreB) : '0'

  if (mazeSize) {
    $mazeId.textContent = currentMazeMeta.id || '-'
    $mazeDiff.textContent = currentMazeMeta.difficulty || '-'
    $mazeSize.textContent = `${mazeSize.nx} × ${mazeSize.nz}`
  } else {
    $mazeId.textContent = '-'
    $mazeDiff.textContent = '-'
    $mazeSize.textContent = '-'
  }
}

function beginEpisode () {
  if (!mazePathPoints || mazePathPoints.length < 2 || !mazeStartCell || !mazeGoalCell) {
    alert('请先加载一个迷宫（并确保 shortestPath / start / goal 存在）。')
    return
  }

  // 为 A/B 各自采样一组策略参数（速度 + 探索偏好）
  const candA = samplePolicy(policyA)
  const candB = samplePolicy(policyB)

  // 用候选 exploreBias 生成路径
  const cellsA = generatePathCells(candA.exploreBias, MAX_STEPS_FACTOR_A)
  const cellsB = generatePathCells(candB.exploreBias, MAX_STEPS_FACTOR_B)
  if (!cellsA || !cellsB) {
    alert('生成路径失败：可能迷宫连通性有问题，或步数限制过小。')
    return
  }
  const pathA = cellsA.map(c => gridToWorld(c.i, c.k, 0.3))
  const pathB = cellsB.map(c => gridToWorld(c.i, c.k, 0.3))

  arena.episode += 1
  arena.status = 'running'
  arena.paused = false
  arena.elapsedA = 0
  arena.elapsedB = 0
  arena.doneA = false
  arena.doneB = false
  arena.scoreA = 0
  arena.scoreB = 0

  // 用候选速度更新 runner
  runnerA.speed = candA.speed
  runnerB.speed = candB.speed

  runnerA.resetWithPath(pathA)
  runnerB.resetWithPath(pathB)

  const okA = runnerA.start()
  const okB = runnerB.start()
  if (!okA || !okB) {
    alert('无法开始对抗：路径无效。')
    arena.status = 'idle'
  }

  console.log(`[Arena] Episode ${arena.episode} start:`, {
    candA, candB
  })

  updatePanel()
}

function finishEpisodeIfNeeded () {
  if (arena.status !== 'running') return
  if (!arena.doneA || !arena.doneB) return

  arena.status = 'finished'
  arena.paused = false

  // 理论最短路径的长度（作为奖励中的参考）
  const shortestPathLen = computePathLength(mazePathPoints)

  const pathLenA = runnerA.getPathLength() || shortestPathLen
  const pathLenB = runnerB.getPathLength() || shortestPathLen

  // 构造一局对抗的摘要，交给奖励模块
  const summary = {
    episode: arena.episode,
    maze: {
      id: currentMazeMeta.id,
      difficulty: currentMazeMeta.difficulty,
      shortestPathLen
    },
    A: {
      reachedGoal: arena.doneA,
      timeSec: arena.elapsedA,
      pathLen: pathLenA,
      trapsHit: runnerA.trapsHit,
      collisions: 0,                        // TODO: 后续接入真实碰撞
      exploredNewCells: runnerA.exploredNewCells
    },
    B: {
      reachedGoal: arena.doneB,
      timeSec: arena.elapsedB,
      pathLen: pathLenB,
      trapsHit: runnerB.trapsHit,
      collisions: 0,
      exploredNewCells: runnerB.exploredNewCells
    }
  }

  const rewards = computeEpisodeRewards(summary, defaultRewardConfig)
  arena.scoreA = rewards.A.score
  arena.scoreB = rewards.B.score

  // —— 在这里根据得分更新策略（进化一步） ——
  updatePolicy(policyA, rewards.A.score)
  updatePolicy(policyB, rewards.B.score)

  // 写入历史记录（含候选/基础参数）
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  history.push({
    ep: arena.episode,
    mazeId: currentMazeMeta.id,
    mazeDiff: currentMazeMeta.difficulty,
    timeA: arena.elapsedA,
    timeB: arena.elapsedB,
    winner: computeWinnerLabel(),
    // 探索 / 陷阱
    exploredA: runnerA.exploredNewCells,
    exploredB: runnerB.exploredNewCells,
    trapsA: runnerA.trapsHit,
    trapsB: runnerB.trapsHit,
    pathLenA,
    pathLenB,
    // 奖励相关
    scoreA: rewards.A.score,
    scoreB: rewards.B.score,
    rewardA: rewards.A.total,
    rewardB: rewards.B.total,
    componentsA: rewards.A.components,
    componentsB: rewards.B.components,
    // 本局用到的候选参数 & 更新后的基础参数
    paramsA: {
      speed: policyA.lastCandidate?.speed,
      exploreBias: policyA.lastCandidate?.exploreBias
    },
    paramsB: {
      speed: policyB.lastCandidate?.speed,
      exploreBias: policyB.lastCandidate?.exploreBias
    },
    baseA: {
      speed: policyA.baseSpeed,
      exploreBias: policyA.baseExploreBias,
      bestScore: policyA.bestScore
    },
    baseB: {
      speed: policyB.baseSpeed,
      exploreBias: policyB.baseExploreBias,
      bestScore: policyB.bestScore
    },
    ts: Date.now()
  })
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history))

  console.log(`[Arena] Episode ${arena.episode} finished:`, {
    scoreA: arena.scoreA,
    scoreB: arena.scoreB,
    baseA: policyA,
    baseB: policyB
  })

  updatePanel()
}

function togglePause () {
  if (arena.status !== 'running') return
  arena.paused = !arena.paused
  // 暂停/恢复只是停止更新 elapsed，与 runner 的 running 状态同步
  runnerA.running = !arena.paused && !runnerA.done
  runnerB.running = !arena.paused && !runnerB.done
  updatePanel()
}

function clearHistory () {
  localStorage.removeItem(HISTORY_KEY)
  alert('arena_runs 历史记录已清空。')
}

/* ------------------- 按钮事件 ------------------- */

btnStart.addEventListener('click', () => {
  if (arena.status === 'running') return
  beginEpisode()
})

btnPause.addEventListener('click', () => {
  togglePause()
})

btnNext.addEventListener('click', () => {
  beginEpisode()
})

btnClear.addEventListener('click', () => {
  clearHistory()
})

btnMazeEasy.addEventListener('click', () => loadRandomMaze('easy'))
btnMazeMedium.addEventListener('click', () => loadRandomMaze('medium'))
btnMazeHard.addEventListener('click', () => loadRandomMaze('hard'))

/* ------------------- 主循环 & 自适应 ------------------- */

let lastTime = performance.now()

function loop (now) {
  const dt = (now - lastTime) / 1000
  lastTime = now

  if (arena.status === 'running' && !arena.paused) {
    runnerA.update(dt)
    runnerB.update(dt)

    if (!runnerA.done) arena.elapsedA += dt
    else arena.doneA = true
    if (!runnerB.done) arena.elapsedB += dt
    else arena.doneB = true

    finishEpisodeIfNeeded()
    updatePanel()
  }

  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}

requestAnimationFrame(loop)

function resizeRenderer () {
  const w = root.clientWidth || window.innerWidth
  const h = root.clientHeight || (window.innerHeight - 64)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

window.addEventListener('resize', resizeRenderer)
resizeRenderer()
