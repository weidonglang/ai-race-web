// src/arena_core.js
// 三维场景 + 迷宫构建 + 路径生成 + AgentRunner 基础引擎

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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

const hemi = new THREE.HemisphereLight(0xffffff, 0x111827, 0.8)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(8, 12, 6)
scene.add(dir)

/* ------------------- 迷宫数据 & 图结构 ------------------- */

let mazeSize = null            // { nx, nz, cellSize }
let mazeGroup = null
let ground = null
let grid = null
let mazePathPoints = null      // THREE.Vector3[] 最短路径（世界坐标）
let trapMap = null             // [k][i] 是否为陷阱

let currentMazeMeta = { id: null, difficulty: null }

let mazeStartCell = null       // { i, k }
let mazeGoalCell = null        // { i, k }
let mazeNeighbors = null       // [k][i] -> [{i,k}, ...]
let mazeDistField = null       // 距离场（到终点的 BFS 步数）
let shortestPathCellCount = 0  // 最短路径步数（格子数）

// 你可以按需要调整数量
const MAZE_COUNTS = {
  easy: 5,
  medium: 5,
  hard: 5
}

const WALL_HEIGHT = 1.6
const WALL_THICKNESS = 0.16

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
  if (ground) {
    scene.remove(ground)
    disposeMesh(ground)
    ground = null
  }
  if (grid) {
    scene.remove(grid)
    grid = null
  }

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

function rebuildGround () {
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

/** 将格子坐标 (i,k) 转为世界坐标 */
function gridToWorld (i, k, y = 0.3) {
  if (!mazeSize) return new THREE.Vector3()
  const cs = mazeSize.cellSize
  const width = mazeSize.nx * cs
  const depth = mazeSize.nz * cs
  const originX = -width / 2 + cs / 2
  const originZ = -depth / 2 + cs / 2
  return new THREE.Vector3(originX + i * cs, y, originZ + k * cs)
}

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

function computePathLength (points) {
  if (!points || points.length < 2) return 0
  let L = 0
  for (let i = 0; i < points.length - 1; i++) {
    L += points[i].distanceTo(points[i + 1])
  }
  return L
}

/* ------------------- 图结构 & 距离场 ------------------- */

function buildGraphAndDistances (data) {
  if (!mazeSize) return
  const { nx, nz } = mazeSize

  mazeNeighbors = Array.from({ length: nz }, () =>
    Array.from({ length: nx }, () => [])
  )

  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const walls = cell.walls
      const neigh = mazeNeighbors[k][i]

      if (!walls.N && k > 0) neigh.push({ i, k: k - 1 })
      if (!walls.S && k < nz - 1) neigh.push({ i, k: k + 1 })
      if (!walls.W && i > 0) neigh.push({ i: i - 1, k })
      if (!walls.E && i < nx - 1) neigh.push({ i: i + 1, k })
    }
  }

  mazeDistField = Array.from({ length: nz }, () => Array(mazeSize.nx).fill(Infinity))
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
 * 生成一条“有一点绕路”的路径（格子序列）
 * - exploreBias 越大，越喜欢选不是最优的邻居（更多探索）
 * - maxFactor 控制允许的最大步数（相对最短路径）
 */
function generatePathCells (exploreBias, maxFactor = 4) {
  if (!mazeStartCell || !mazeGoalCell || !mazeNeighbors || !mazeDistField) return null

  const keyOf = c => `${c.i},${c.k}`
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
    const candidates = neigh.filter(n => mazeDistField[n.k][n.i] < Infinity)
    if (candidates.length === 0) break

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

    const exploreCandidates = candidates.filter(n => {
      const nk = keyOf(n)
      if (prevKey && nk === prevKey) return false
      const d = mazeDistField[n.k][n.i]
      return d <= curDist + 1.5
    })

    let chosen
    const r = Math.random()
    if (exploreCandidates.length > 0 && r < exploreBias) {
      chosen = exploreCandidates[Math.floor(Math.random() * exploreCandidates.length)]
    } else {
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

function buildMazeFromData (data) {
  clearMaze()

  // 兼容多种 size 写法：nx/nz 或 width/height
  const size = data.size || {}
  const nx = size.nx ?? size.width ?? size.w
  const nz = size.nz ?? size.height ?? size.h
  const cellSize = size.cellSize ?? size.step ?? 1.0

  if (!nx || !nz) {
    console.error('[ArenaCore] 无法从 data.size 解析网格尺寸：', size)
    return
  }

  mazeSize = { nx, nz, cellSize }
  currentMazeMeta.id = data.id || 'unknown'
  currentMazeMeta.difficulty = data.difficulty || 'unknown'

  mazeStartCell = { i: data.start.i, k: data.start.k }
  mazeGoalCell = { i: data.goal.i, k: data.goal.k }
  shortestPathCellCount = (data.shortestPath && data.shortestPath.length) || 0

  // 根据新 nx / nz 初始化 trapMap
  trapMap = Array.from({ length: nz }, () => Array(nx).fill(false))

  rebuildGround()

  mazeGroup = new THREE.Group()
  scene.add(mazeGroup)

  const cs = mazeSize.cellSize
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4b5563 })
  const trapMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c })

  for (let k = 0; k < nz; k++) {
    const row = data.cells[k]
    for (let i = 0; i < nx; i++) {
      const cell = row[i]
      const { walls, trap } = cell
      const center = gridToWorld(i, k, WALL_HEIGHT / 2)

      if (trap) {
        trapMap[k][i] = true
        const trapGeo = new THREE.BoxGeometry(cs * 0.6, 0.05, cs * 0.6)
        const trapMesh = new THREE.Mesh(trapGeo, trapMat)
        const trapPos = gridToWorld(i, k, 0.03)
        trapMesh.position.copy(trapPos)
        mazeGroup.add(trapMesh)
      }

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

  const sp = data.shortestPath || []
  mazePathPoints = sp.map(cell => gridToWorld(cell.i, cell.k, 0.3))

  buildGraphAndDistances(data)

  controls.target.set(0, 0, 0)
  controls.update()
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
    console.log(`[ArenaCore] Loaded maze: ${filename}`)
  } catch (err) {
    console.error('[ArenaCore] 迷宫加载失败', err)
    alert(`加载迷宫失败：${filename}\n请确认文件存在，且通过 maze_*.py 已生成。`)
  }
}

/* ------------------- AgentRunner：移动 + 探索/陷阱统计 ------------------- */

class AgentRunner {
  constructor (mesh, speed = 3.0) {
    this.mesh = mesh
    this.speed = speed
    this.path = null
    this.segIndex = 0
    this.running = false
    this.done = false

    this.visitedCells = new Set()
    this.exploredNewCells = 0
    this.trapsHit = 0
    this._trapCells = new Set()
    this._lastCellKey = null
    this.lastSteppedOnTrap = false
    this.reachedGoal = false
    this.deadByTrap = false
  }

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

  resetWithPath (path) {
    if (!path || path.length < 2) {
      this.path = null
      this.running = false
      this.done = false
      this.mesh.visible = false
      this._resetStats()
      return
    }
    this.path = path.map(p => p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))
    this.segIndex = 0
    this.running = false
    this.done = false
    this.mesh.visible = false
    this._resetStats()
    this.mesh.position.copy(this.path[0])
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

    this.lastSteppedOnTrap = false
    if (key === this._lastCellKey) return
    this._lastCellKey = key

    if (!this.visitedCells.has(key)) {
      this.visitedCells.add(key)
      this.exploredNewCells++
    }

    if (trapMap && trapMap[cell.k] && trapMap[cell.k][cell.i]) {
      if (!this._trapCells.has(key)) {
        this._trapCells.add(key)
        this.trapsHit++
        this.lastSteppedOnTrap = true
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
      this.reachedGoal = true
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
        this.reachedGoal = true
        return
      }
    }
    dir.normalize()
    pos.addScaledVector(dir, this.speed * dt)

    this._updateCellMetrics()
    if (this.lastSteppedOnTrap && !this.reachedGoal) {
      this.deadByTrap = true
      this.done = true
      this.running = false
    }
  }

  getPathLength () {
    return computePathLength(this.path)
  }
}

/* ------------------- 渲染区自适应（render loop 在 arena_train.js 里） ------------------- */

function resizeRenderer () {
  const w = root.clientWidth || window.innerWidth
  const h = root.clientHeight || (window.innerHeight - 64)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

window.addEventListener('resize', resizeRenderer)
resizeRenderer()

/* ------------------- 导出给 arena_train.js 用 ------------------- */

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

export function getMazeSize () { return mazeSize }
export function getMazeMeta () {
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
    blocks: [] // 暂时不做 block，RL 里默认只有越界是不可走
  }
}
export function getMazePathPoints () { return mazePathPoints }
