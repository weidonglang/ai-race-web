// src/arena_core.js
// 三维场景 + 迷宫构建 + 路径生成 + AgentRunner 基础引擎
// -------------------------------------------------------
// 本文件的核心作用：
// 1. 使用 Three.js 创建 3D 场景（地面、网格、灯光等）。
// 2. 根据 JSON 迷宫数据在 3D 中搭建墙体、陷阱、起点/终点。
// 3. 把迷宫描述成“图结构”（邻接表 + BFS 距离场），为路径规划服务。
// 4. 提供 generatePathCells() 生成一条带“绕路倾向”的路径。
// 5. 提供 AgentRunner 类，用于沿路径移动 Agent，并统计探索/踩陷阱等指标。
// 6. 导出若干工具函数给 arena_train.js 等其他模块使用。

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/* ------------------- 基础 Three.js 场景 ------------------- */

// WebGL 渲染输出挂载到的 DOM 容器
const root = document.getElementById('arena-viewport')

// 创建渲染器：开启抗锯齿（antialias）
const renderer = new THREE.WebGLRenderer({ antialias: true })

// 控制渲染器的像素比（防止高 DPI 设备上太吃性能）
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

// 将画布追加到 DOM 中
root.appendChild(renderer.domElement)

// 创建场景对象（所有 3D 元素都添加到这里）
const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115') // 深色背景

// 透视相机：
// 参数：视野角度、宽高比、近裁剪面、远裁剪面
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
// 设置相机初始位置（稍微在上方、斜侧）
camera.position.set(12, 14, 12)
camera.lookAt(0, 0, 0)

// 轨道控制器：支持鼠标旋转 / 缩放 / 平移视角
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0) // 观察中心
controls.update()

// 柔和的环境光：上半球为白色，下半球为深色
const hemi = new THREE.HemisphereLight(0xffffff, 0x111827, 0.8)
scene.add(hemi)

// 平行光（模拟太阳光）
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(8, 12, 6)
scene.add(dir)

/* ------------------- 迷宫数据 & 图结构 ------------------- */

/**
 * mazeSize：保存迷宫尺寸信息
 * nx / nz  : 横向/纵向格子数
 * cellSize : 每个格子的边长（世界单位）
 */
let mazeSize = null

// 迷宫整体的 THREE.Group 容器（墙、陷阱、起终点标记都挂在这里）
let mazeGroup = null

// 地面和网格辅助线
let ground = null
let grid = null

// 最短路径的 3D 世界坐标点数组（用于可视化）
let mazePathPoints = null // THREE.Vector3[]

// 陷阱格子标记：trapMap[k][i] = true 表示该格子是陷阱
let trapMap = null

// 当前迷宫的元信息（id、难度）
let currentMazeMeta = { id: null, difficulty: null }

// 起点/终点所在的格子坐标（迷宫坐标系）
let mazeStartCell = null // { i, k }
let mazeGoalCell = null  // { i, k }

// 图结构：每个格子对应的邻接点列表
// mazeNeighbors[k][i] = [ { i, k }, ... ]
let mazeNeighbors = null

// BFS 计算出来的“距离场”
// mazeDistField[k][i] = 从该格子到终点的最少步数（格子数）
let mazeDistField = null

// 最短路径步数（以格子为单位）
let shortestPathCellCount = 0

// 每种难度下预生成的迷宫数量（用于随机选择文件）
const MAZE_COUNTS = {
  easy: 5,
  medium: 5,
  hard: 5
}

// 迷宫墙体的高度和厚度（世界单位）
const WALL_HEIGHT = 1.6
const WALL_THICKNESS = 0.16

// 起点和终点的小球标记
let startMarker = null
let goalMarker = null

/**
 * 安全释放一个 mesh 或 Object3D 上的几何体和材质资源
 * 避免频繁加载/销毁迷宫时造成 GPU 内存泄漏。
 * @param {THREE.Object3D} obj
 */
function disposeMesh (obj) {
  if (!obj) return
  if (obj.geometry) obj.geometry.dispose()
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
    else obj.material.dispose()
  }
}

/**
 * 清空当前迷宫相关的所有 3D 对象和数据。
 * - 从场景中移除墙体、起点/终点标记、地面、网格等。
 * - 重置相关全局变量（邻接表、距离场、路径等）。
 * 在加载新迷宫前调用。
 */
function clearMaze () {
  // 删除迷宫 Group（包括墙体与陷阱）
  if (mazeGroup) {
    mazeGroup.traverse(obj => {
      if (obj.isMesh) disposeMesh(obj)
    })
    scene.remove(mazeGroup)
    mazeGroup = null
  }

  // 删除起点和终点标记
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

  // 删除地面和网格
  if (ground) {
    scene.remove(ground)
    disposeMesh(ground)
    ground = null
  }
  if (grid) {
    scene.remove(grid)
    grid = null
  }

  // 重置与迷宫有关的各种数据结构
  mazePathPoints = null
  trapMap = null
  mazeSize = null
  currentMazeMeta = { id: null, difficulty: null }

  mazeStartCell = null
  mazeGoalCell = null
  mazeNeighbors = null
  mazeDistField = null
  shortestPathCellCount = 0
}

/**
 * 根据 mazeSize 重新创建地面和网格辅助线。
 * 通常在加载新迷宫后调用。
 */
function rebuildGround () {
  if (!mazeSize) return

  // 根据迷宫尺寸计算地面的宽度和深度（略比迷宫大一点）
  const w = mazeSize.nx * mazeSize.cellSize + 2
  const d = mazeSize.nz * mazeSize.cellSize + 2

  // 地面是一个旋转过的平面（默认 Plane 在 XY 平面，这里转到 XZ）
  const floorGeo = new THREE.PlaneGeometry(w, d, 1, 1)
  floorGeo.rotateX(-Math.PI / 2)

  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x111827,
    metalness: 0,
    roughness: 1
  })

  ground = new THREE.Mesh(floorGeo, floorMat)
  ground.receiveShadow = true
  scene.add(ground)

  // 网格辅助线（主要方便调试和观察迷宫结构）
  grid = new THREE.GridHelper(w, mazeSize.nx, 0x374151, 0x1f2933)
  grid.position.y = 0.01 // 稍微抬高一点避免与地面 Z-fighting
  scene.add(grid)
}

/**
 * 将格子坐标 (i, k) 转为世界坐标中的中心点位置。
 *
 * @param {number} i - 迷宫横向索引（x 方向）
 * @param {number} k - 迷宫纵向索引（z 方向）
 * @param {number} [y=0.3] - 返回的 y 高度（可以指定不同高度）
 * @returns {THREE.Vector3} 转换后的世界坐标
 */
function gridToWorld (i, k, y = 0.3) {
  if (!mazeSize) return new THREE.Vector3()

  const cs = mazeSize.cellSize
  const width = mazeSize.nx * cs
  const depth = mazeSize.nz * cs

  // 左下角原点位置（x、z）
  const originX = -width / 2 + cs / 2
  const originZ = -depth / 2 + cs / 2

  return new THREE.Vector3(
    originX + i * cs,
    y,
    originZ + k * cs
  )
}

/**
 * 将世界坐标转换为迷宫格子坐标。
 * - 做的是“反向”操作：根据当前 x/z 推回格子索引。
 * - 使用 Math.round()，默认靠近哪一个格子就算哪个。
 *
 * @param {THREE.Vector3} pos - 世界坐标
 * @returns {{i:number,k:number}|null} 返回格子坐标，若超出迷宫范围则返回 null
 */
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

  // 越界判断
  if (i < 0 || i >= mazeSize.nx || k < 0 || k >= mazeSize.nz) return null
  return { i, k }
}

/**
 * 计算路径（世界坐标点序列）的欧式长度之和。
 *
 * @param {THREE.Vector3[]} points - 路径上的点序列
 * @returns {number} 路径总长度（单位与世界坐标一致）
 */
function computePathLength (points) {
  if (!points || points.length < 2) return 0
  let L = 0
  for (let i = 0; i < points.length - 1; i++) {
    L += points[i].distanceTo(points[i + 1])
  }
  return L
}

/* ------------------- 图结构 & 距离场 ------------------- */

/**
 * 根据 JSON 迷宫数据构建：
 * 1. 邻接表 mazeNeighbors：每个格子能连到哪些邻居。
 * 2. 距离场 mazeDistField：从每个格子到终点的最短步数（通过 BFS 算出来）。
 *
 * 这个函数的前提：
 * - mazeSize 已经被设置（即迷宫尺寸已知）。
 * - mazeGoalCell 已经被设置（终点格子坐标已知）。
 *
 * @param {Object} data - 迷宫 JSON 数据（含 cells、walls 等信息）
 */
function buildGraphAndDistances (data) {
  if (!mazeSize) return
  const { nx, nz } = mazeSize

  // 初始化邻接表：mazeNeighbors[k][i] = []
  mazeNeighbors = Array.from({ length: nz }, () =>
    Array.from({ length: nx }, () => [])
  )

  // 遍历每一个格子，根据墙体信息确定可以走向哪里
  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const walls = cell.walls
      const neigh = mazeNeighbors[k][i]

      // 没有北侧墙且不在最上边 -> 可以连到 (i, k-1)
      if (!walls.N && k > 0) neigh.push({ i, k: k - 1 })
      // 没有南侧墙且不在最下边
      if (!walls.S && k < nz - 1) neigh.push({ i, k: k + 1 })
      // 没有西侧墙且不在最左边
      if (!walls.W && i > 0) neigh.push({ i: i - 1, k })
      // 没有东侧墙且不在最右边
      if (!walls.E && i < nx - 1) neigh.push({ i: i + 1, k })
    }
  }

  // 初始化距离场，默认值为 Infinity（不可达）
  mazeDistField = Array.from({ length: nz }, () =>
    Array(mazeSize.nx).fill(Infinity)
  )
  if (!mazeGoalCell) return

  // 从终点出发做 BFS（“反向最短路”）
  const q = []
  mazeDistField[mazeGoalCell.k][mazeGoalCell.i] = 0
  q.push({ i: mazeGoalCell.i, k: mazeGoalCell.k })

  while (q.length > 0) {
    const cur = q.shift()
    const curD = mazeDistField[cur.k][cur.i]
    const neigh = mazeNeighbors[cur.k][cur.i] || []

    for (const n of neigh) {
      const old = mazeDistField[n.k][n.i]
      // 如果找到更短的距离，则更新并继续 BFS
      if (curD + 1 < old) {
        mazeDistField[n.k][n.i] = curD + 1
        q.push({ i: n.i, k: n.k })
      }
    }
  }
}

/**
 * 生成一条“有一点绕路”的路径（格子序列）。
 *
 * 核心思路：
 * 1. 已有 mazeDistField（每个格子到终点的最短步数）。
 * 2. 正常情况下总是选距离最小的邻居 -> 得到最短路径（贪心策略）。
 * 3. 这里加入 exploreBias 参数，让 agent 有部分概率选择“稍微不那么优”的邻居，
 *    从而让路径变得更“绕一点”（增强探索）。
 *
 * @param {number} exploreBias - 探索概率 [0, 1]，越大越容易选择非最优邻居
 * @param {number} [maxFactor=4] - 允许路径长度最多是最短路径的多少倍
 * @returns {{i:number,k:number}[]|null} 返回格子路径数组，如果没能在限制步数内到达终点则返回 null
 */
function generatePathCells (exploreBias, maxFactor = 4) {
  if (!mazeStartCell || !mazeGoalCell || !mazeNeighbors || !mazeDistField) return null

  const keyOf = c => `${c.i},${c.k}`
  const goalKey = keyOf(mazeGoalCell)

  const shortestSteps = Math.max(shortestPathCellCount || 1, 1)
  // 限制最大步数，防止路径走得太离谱或陷入循环
  const maxSteps = Math.max(Math.floor(shortestSteps * maxFactor), shortestSteps + 2)

  let cur = { i: mazeStartCell.i, k: mazeStartCell.k }
  let prevKey = null
  let reachedGoal = false

  const path = [cur]
  const visited = new Set([keyOf(cur)])

  for (let steps = 0; steps < maxSteps; steps++) {
    const curKey = keyOf(cur)
    // 到达终点则停止
    if (curKey === goalKey) {
      reachedGoal = true
      break
    }

    const neigh = mazeNeighbors[cur.k][cur.i] || []
    if (neigh.length === 0) break

    const curDist = mazeDistField[cur.k][cur.i]
    // 过滤掉距离为 Infinity 的（不可达的）邻居
    const candidates = neigh.filter(n => mazeDistField[n.k][n.i] < Infinity)
    if (candidates.length === 0) break

    // 计算“最贪心”的邻居：到终点距离最小
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

    // exploreCandidates：允许探索的候选邻居（与当前格子距离差不太大）
    const exploreCandidates = candidates.filter(n => {
      const nk = keyOf(n)
      // 避免立即走回上一格（否则容易来回抖动）
      if (prevKey && nk === prevKey) return false
      const d = mazeDistField[n.k][n.i]
      // 距离不比当前大太多，就允许作为探索对象
      return d <= curDist + 1.5
    })

    // 根据随机数 + exploreBias 决定这一步选“探索”还是“贪心”
    let chosen
    const r = Math.random()
    if (exploreCandidates.length > 0 && r < exploreBias) {
      // 探索：在 exploreCandidates 中随机选一个
      chosen = exploreCandidates[Math.floor(Math.random() * exploreCandidates.length)]
    } else {
      // 贪心：优先从 greedy 中选，否则退回到所有 candidates
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

/* ------------------- 根据 JSON 构建迷宫 ------------------- */

/**
 * 根据 JSON 数据在 3D 场景中搭建迷宫。
 * 具体包含：
 * - 清除旧迷宫；
 * - 根据 size 信息设置 mazeSize；
 * - 创建墙体、陷阱、起点/终点标记；
 * - 从 data.shortestPath 映射出 world 坐标的路径点；
 * - 构建邻接表和距离场（buildGraphAndDistances）。
 *
 * @param {Object} data - 从 maze_*.json 加载的迷宫数据
 */
function buildMazeFromData (data) {
  // 先清除旧迷宫
  clearMaze()

  // 兼容多种 size 写法：nx/nz 或 width/height/w/h 等
  const size = data.size || {}
  const nx = size.nx ?? size.width ?? size.w
  const nz = size.nz ?? size.height ?? size.h
  const cellSize = size.cellSize ?? size.step ?? 1.0

  if (!nx || !nz) {
    console.error('[ArenaCore] 无法从 data.size 解析网格尺寸：', size)
    return
  }

  // 记录迷宫尺寸和元信息
  mazeSize = { nx, nz, cellSize }
  currentMazeMeta.id = data.id || 'unknown'
  currentMazeMeta.difficulty = data.difficulty || 'unknown'

  // 起点与终点（迷宫格子坐标）
  mazeStartCell = { i: data.start.i, k: data.start.k }
  mazeGoalCell = { i: data.goal.i, k: data.goal.k }

  // 最短路径的步数（以格子数为单位）
  shortestPathCellCount = (data.shortestPath && data.shortestPath.length) || 0

  // 初始化 trapMap，默认全部为 false（无陷阱）
  trapMap = Array.from({ length: nz }, () => Array(nx).fill(false))

  // 根据新尺寸重建地面与网格
  rebuildGround()

  // 新建一个 Group 用来装迷宫所有物体
  mazeGroup = new THREE.Group()
  scene.add(mazeGroup)

  const cs = mazeSize.cellSize
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4b5563 }) // 墙体材质
  const trapMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c }) // 陷阱材质（红色）

  // 遍历每个格子，根据 walls 和 trap 创建对应的 3D 对象
  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const { walls, trap } = cell
      const center = gridToWorld(i, k, WALL_HEIGHT / 2)

      // 如果此格子是陷阱，则创建一个薄薄的红色方块盖在地上
      if (trap) {
        trapMap[k][i] = true
        const trapGeo = new THREE.BoxGeometry(cs * 0.6, 0.05, cs * 0.6)
        const trapMesh = new THREE.Mesh(trapGeo, trapMat)
        const trapPos = gridToWorld(i, k, 0.03)
        trapMesh.position.copy(trapPos)
        mazeGroup.add(trapMesh)
      }

      // 根据 walls 决定是否绘制 N/S/W/E 四个方向的墙体
      if (walls.N) {
        const geo = new THREE.BoxGeometry(cs, WALL_HEIGHT, WALL_THICKNESS)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x, WALL_HEIGHT / 2, center.z - cs / 2)
        mazeGroup.add(mesh)
      }
      if (walls.S) {
        const geo = new THREE.BoxGeometry(cs, WALL_HEIGHT, WALL_THICKNESS)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x, WALL_HEIGHT / 2, center.z + cs / 2)
        mazeGroup.add(mesh)
      }
      if (walls.W) {
        const geo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, cs)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x - cs / 2, WALL_HEIGHT / 2, center.z)
        mazeGroup.add(mesh)
      }
      if (walls.E) {
        const geo = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, cs)
        const mesh = new THREE.Mesh(geo, wallMat)
        mesh.position.set(center.x + cs / 2, WALL_HEIGHT / 2, center.z)
        mazeGroup.add(mesh)
      }
    }
  }

  // 起点和终点的小球位置（稍微抬高一点）
  const startPos = gridToWorld(data.start.i, data.start.k, 0.25)
  const goalPos = gridToWorld(data.goal.i, data.goal.k, 0.25)

  const markerGeo = new THREE.SphereGeometry(0.25, 24, 16)
  const startMat = new THREE.MeshStandardMaterial({ color: 0x22c55e }) // 绿色起点
  const goalMat = new THREE.MeshStandardMaterial({ color: 0xf97316 })  // 橙色终点

  startMarker = new THREE.Mesh(markerGeo, startMat)
  goalMarker = new THREE.Mesh(markerGeo, goalMat)
  startMarker.position.copy(startPos)
  goalMarker.position.copy(goalPos)
  mazeGroup.add(startMarker, goalMarker)

  // 把 JSON 中给出的 shortestPath（格子序列）映射到 3D 世界坐标
  const sp = data.shortestPath || []
  mazePathPoints = sp.map(cell => gridToWorld(cell.i, cell.k, 0.3))

  // 构建邻接表与距离场
  buildGraphAndDistances(data)

  // 重置相机的观察中心
  controls.target.set(0, 0, 0)
  controls.update()
}

/**
 * 随机加载一张指定难度的迷宫（JSON 文件）。
 * 文件命名约定：
 *   mazes/maze_{difficulty}_{idx}.json
 *   例如：mazes/maze_easy_000.json
 *
 * @param {'easy'|'medium'|'hard'} difficulty - 难度级别
 */
async function loadRandomMaze (difficulty) {
  // 根据难度查可用迷宫数量，随机挑一个索引
  const count = MAZE_COUNTS[difficulty] || 1
  const idx = Math.floor(Math.random() * count)
  const filename = `mazes/maze_${difficulty}_${String(idx).padStart(3, '0')}.json`

  try {
    const res = await fetch(filename)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    buildMazeFromData(data)
    console.log(`[ArenaCore] Loaded maze: ${filename}`)
  } catch (err) {
    console.error('[ArenaCore] 迷宫加载失败', err)
    alert(`加载迷宫失败：${filename}\n请确认文件存在，且通过 maze_*.py 已生成。`)
  }
}

/* ------------------- AgentRunner：移动 + 探索/陷阱统计 ------------------- */

/**
 * AgentRunner 负责在 3D 场景中沿“路径点序列”移动一个 mesh，
 * 并且在移动过程中统计：
 * - 探索过多少新格子（exploredNewCells）
 * - 踩中了多少个不同的陷阱格子（trapsHit）
 * - 是否到达终点（reachedGoal）
 * - 是否被陷阱“杀死”（deadByTrap）
 *
 * 注意：
 * - AgentRunner 本身并不生成路径，只负责执行和统计，路径由外部传入。
 */
class AgentRunner {
  /**
   * @param {THREE.Mesh} mesh - 用来表示 Agent 的 3D 模型（例如一个小球）
   * @param {number} [speed=3.0] - 运动速度（世界单位/秒）
   */
  constructor (mesh, speed = 3.0) {
    // Agent 对应的 mesh
    this.mesh = mesh
    // 每秒移动的距离
    this.speed = speed

    // path: THREE.Vector3[]，世界坐标路径点
    this.path = null
    // 当前正在走的路径段索引（从 0 到 path.length-2）
    this.segIndex = 0
    // 是否处于“运行中”
    this.running = false
    // 是否已经完成（到达终点或被陷阱杀死）
    this.done = false

    // 统计数据部分 --------------------
    // visitedCells 存储已经访问过的格子 key（"i,k"）
    this.visitedCells = new Set()
    // 探索过多少个“新格子”
    this.exploredNewCells = 0
    // 踩中了多少个不同的陷阱格子
    this.trapsHit = 0
    // 用于去重的陷阱格子集合
    this._trapCells = new Set()
    // 上一次所在格子的 key，用于防止重复统计
    this._lastCellKey = null
    // 本帧是否刚踩中陷阱
    this.lastSteppedOnTrap = false
    // 是否到达终点
    this.reachedGoal = false
    // 是否因陷阱“死亡”
    this.deadByTrap = false
  }

  /**
   * 重置统计数据为默认值。
   * 在 resetWithPath() 中调用，以确保每次执行新路径时数据清零。
   * （该方法只影响统计，不改变路径和起始位置。）
   * @private
   */
  _resetStats () {
    this.visitedCells = new Set()
    this._trapCells = new Set()
    this.exploredNewCells = 0
    this.trapsHit = 0
    this._lastCellKey = null
    this.lastSteppedOnTrap = false
    this.reachedGoal = false
    this.deadByTrap = false
  }

  /**
   * 使用一条新的路径重置 Agent 的状态。
   * - 如果路径无效（为空或长度 < 2），则隐藏 mesh，并将 running/done = false。
   * - 否则复制一份路径点数组，将 mesh 放置到起点，并清空统计数据。
   *
   * @param {THREE.Vector3[]} path - 世界坐标路径点数组
   */
  resetWithPath (path) {
    if (!path || path.length < 2) {
      // 无有效路径 -> 不运行
      this.path = null
      this.running = false
      this.done = false
      this.mesh.visible = false
      this._resetStats()
      return
    }

    // 深拷贝路径点（避免外部数组被修改）
    this.path = path.map(p => (p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z)))
    this.segIndex = 0
    this.running = false
    this.done = false
    this.mesh.visible = false
    this._resetStats()

    // 将 Agent 放到路径起点
    this.mesh.position.copy(this.path[0])

    // 刚重置的时候，也更新一次格子统计
    this._updateCellMetrics()
  }

  /**
   * 启动 Agent 的运动。
   * - 如果路径非法或太短，则启动失败，返回 false。
   *
   * @returns {boolean} 是否成功开始
   */
  start () {
    if (!this.path || this.path.length < 2) return false
    this.running = true
    this.done = false
    this.mesh.visible = true
    return true
  }

  /**
   * 暂停 / 停止运动（不重置统计和路径）。
   */
  stop () {
    this.running = false
  }

  /**
   * 内部函数：根据当前 mesh.position 所在的格子，更新探索和陷阱统计。
   * - 使用 worldToCell() 把世界坐标转为格子坐标；
   * - visitedCells 用于统计探索的不同格子数量；
   * - trapMap 用于判断该格子是否为陷阱；
   * - lastSteppedOnTrap 用于告诉外部逻辑“本帧刚踩到陷阱”。
   *
   * @private
   */
  _updateCellMetrics () {
    if (!mazeSize) return

    const cell = worldToCell(this.mesh.position)
    if (!cell) return

    const key = `${cell.i},${cell.k}`

    // 默认认为本帧没有踩陷阱
    this.lastSteppedOnTrap = false

    // 如果与上一帧是同一格子，就不重复统计
    if (key === this._lastCellKey) return
    this._lastCellKey = key

    // 1. 统计“探索过的新格子数量”
    if (!this.visitedCells.has(key)) {
      this.visitedCells.add(key)
      this.exploredNewCells++
    }

    // 2. 统计“踩中陷阱的格子数量”（去重）
    if (trapMap && trapMap[cell.k] && trapMap[cell.k][cell.i]) {
      if (!this._trapCells.has(key)) {
        this._trapCells.add(key)
        this.trapsHit++
        this.lastSteppedOnTrap = true
      }
    }
  }

  /**
   * 每一帧调用一次，用于更新 Agent 的位置并检查终止条件。
   * - dt 是“时间步长”，通常由外部渲染循环传入（单位：秒）。
   * - 内部逻辑：
   *   1. 沿路径当前段 segIndex 做匀速直线运动；
   *   2. 如果离本段终点很近，切换到下一段；
   *   3. 如果走完最后一段，设置 reachedGoal = true，done = true；
   *   4. 每帧调用 _updateCellMetrics() 统计格子与陷阱；
   *   5. 如果踩中陷阱且尚未到达终点，则 deadByTrap = true，并立即停止。
   *
   * @param {number} dt - 距离上一帧的时间（秒）
   */
  update (dt) {
    if (!this.running || this.done || !this.path) return

    const pos = this.mesh.position
    let target = this.path[this.segIndex + 1]

    // 如果当前已经没有下一个目标点，则认为到达终点
    if (!target) {
      this.done = true
      this.running = false
      this.reachedGoal = true
      return
    }

    // 计算当前到目标点的方向向量与距离
    const dir = new THREE.Vector3().subVectors(target, pos)
    const dist = dir.length()

    // 如果离目标很近（< 0.05），则切换到下一段
    if (dist < 0.05) {
      this.segIndex++
      target = this.path[this.segIndex + 1]
      if (!target) {
        this.done = true
        this.running = false
        this.reachedGoal = true
        return
      }
    }

    // 按速度沿方向前进
    dir.normalize()
    pos.addScaledVector(dir, this.speed * dt)

    // 更新格子与陷阱统计
    this._updateCellMetrics()

    // 如果本帧刚踩中陷阱，并且还没到终点 -> 判定为“死亡”
    if (this.lastSteppedOnTrap && !this.reachedGoal) {
      this.deadByTrap = true
      this.done = true
      this.running = false
    }
  }

  /**
   * 返回当前路径的几何长度（调用 computePathLength）。
   * @returns {number}
   */
  getPathLength () {
    return computePathLength(this.path)
  }
}

/* ------------------- 渲染区自适应（render loop 在 arena_train.js 里） ------------------- */

/**
 * 根据容器大小（root.clientWidth / clientHeight）调整渲染器尺寸，
 * 并同步更新 camera.aspect，保证画面不拉伸。
 * 该函数在窗口尺寸变化时会被调用。
 */
function resizeRenderer () {
  const w = root.clientWidth || window.innerWidth
  const h = root.clientHeight || (window.innerHeight - 64)

  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// 监听浏览器窗口大小变化
window.addEventListener('resize', resizeRenderer)
// 初始化时先调用一次，设置初始尺寸
resizeRenderer()

/* ------------------- 导出给 arena_train.js 用 ------------------- */

// 导出核心 Three.js 对象与迷宫/路径构建函数
export {
  scene,
  camera,
  renderer,
  controls,
  loadRandomMaze,
  generatePathCells,
  computePathLength,
  AgentRunner,
  gridToWorld
}

/**
 * 获取当前迷宫尺寸信息。
 * - 若还未加载迷宫，则返回 null。
 * - 外部可以通过它来决定状态空间大小 / 可视化缩放等。
 *
 * @returns {{nx:number,nz:number,cellSize:number}|null}
 */
export function getMazeSize () { return mazeSize }

/**
 * 获取当前迷宫的元信息（给 RL / UI 使用）。
 * 内容包括：
 * - id, difficulty
 * - width, height（格子维度）
 * - start, end（起终点格子坐标）
 * - traps（所有陷阱格子坐标数组）
 * - blocks（暂留字段，目前为空数组）
 * - shortestPathLen（最短路径长度，以格子数计）
 */
export function getMazeMeta () {
  // 如果迷宫还没加载，只返回基础信息
  if (!mazeSize) {
    return {
      id: currentMazeMeta.id,
      difficulty: currentMazeMeta.difficulty,
      width: undefined,
      height: undefined,
      start: mazeStartCell,
      end: mazeGoalCell,
      traps: [],
      blocks: []
    }
  }

  // 从 trapMap 中扫一遍，把所有陷阱格子导出来
  const traps = []
  if (trapMap) {
    for (let k = 0; k < mazeSize.nz; k++) {
      for (let i = 0; i < mazeSize.nx; i++) {
        if (trapMap[k] && trapMap[k][i]) {
          traps.push({ i, k })
        }
      }
    }
  }

  return {
    id: currentMazeMeta.id,
    difficulty: currentMazeMeta.difficulty,
    width: mazeSize.nx,
    height: mazeSize.nz,
    start: mazeStartCell,
    end: mazeGoalCell,
    traps,
    // 暂时不做 block，RL 里默认只有越界是不可走
    blocks: [],
    shortestPathLen: shortestPathCellCount || 0
  }
}

/**
 * 获取预先计算好的“最短路径”的 3D 世界坐标点序列。
 * - 该数据来源于 JSON 文件中的 data.shortestPath。
 * - 主要用于可视化（例如在场景中画一条线）。
 *
 * @returns {THREE.Vector3[]|null}
 */
export function getMazePathPoints () { return mazePathPoints }

/**
 * 获取迷宫的邻接表（图结构）。
 * - mazeNeighbors[k][i] = [{i,k}, ...]
 * - 外部也可以基于该结构做自己的搜索 / 路径规划。
 *
 * @returns {Array<Array<Array<{i:number,k:number}>>>|null}
 */
export function getMazeNeighbors () {
  return mazeNeighbors
}
