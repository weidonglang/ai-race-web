// src/editor.js
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { init as initRecast, NavMeshQuery, statusToReadableString } from 'recast-navigation'
import { generateSoloNavMesh } from 'recast-navigation/generators'
import { NavMeshHelper } from '@recast-navigation/three'

// ---------- 基础 three.js ----------
const root = document.getElementById('viewport')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(root.clientWidth, root.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, root.clientWidth / root.clientHeight, 0.1, 1000)
camera.position.set(10, 12, 18)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.7)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(6, 10, 6)
scene.add(dir)

// 地面 + 网格
const FLOOR_SIZE = 30
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1)
floorGeo.rotateX(-Math.PI / 2)
const floorMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, metalness: 0.0, roughness: 1.0 })
const floor = new THREE.Mesh(floorGeo, floorMat)
floor.receiveShadow = true
floor.name = 'Floor'
scene.add(floor)

const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x444a57, 0x303543)
grid.position.y = 0.01
scene.add(grid)

// ---------- 交互与状态 ----------
const raycaster = new THREE.Raycaster()
const mouseNDC = new THREE.Vector2()
let placingMode = null        // 'box' | 'start' | 'end' | null
const obstacles = []          // THREE.Mesh[]
let startMarker = null        // THREE.Mesh
let endMarker = null          // THREE.Mesh
let navQuery = null           // NavMeshQuery
let navHelper = null          // NavMeshHelper
let pathLine = null           // THREE.Line
let downPos = null            // pointerdown 位置，用于区分拖动/点击

const updateCursor = () => {
  renderer.domElement.style.cursor = placingMode ? 'crosshair' : 'default'
}

// 标记/障碍
function makeMarker(color) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 24, 16),
    new THREE.MeshStandardMaterial({ color })
  )
}
function addObstacleAt(point) {
  const geo = new THREE.BoxGeometry(2, 2, 2)
  const mat = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.2, roughness: 0.8 })
  const box = new THREE.Mesh(geo, mat)
  box.position.copy(point).y = 1.0
  box.castShadow = true
  box.receiveShadow = true
  box.name = 'Obstacle'
  scene.add(box)
  obstacles.push(box)
}

// 拾取地面
function pickOnFloor(ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObject(floor, false)[0]
  return hit ? hit.point : null
}

// ---------- 输入几何转换（地面 + 障碍） ----------
function getPositionsAndIndicesFromMeshes(meshes) {
  const positions = []
  const indices = []
  let indexOffset = 0

  for (const mesh of meshes) {
    const geom = mesh.geometry.clone()
    geom.applyMatrix4(mesh.matrixWorld)
    const nonIdx = geom.index ? geom.toNonIndexed() : geom
    const arr = nonIdx.getAttribute('position').array

    for (let i = 0; i < arr.length; i += 3) {
      positions.push(arr[i], arr[i + 1], arr[i + 2])
    }
    const triCount = arr.length / 9
    for (let t = 0; t < triCount; t++) {
      indices.push(indexOffset + t * 3 + 0)
      indices.push(indexOffset + t * 3 + 1)
      indices.push(indexOffset + t * 3 + 2)
    }
    indexOffset += triCount * 3
  }
  return [positions, indices]
}

// ---------- NavMesh 烘焙 ----------
async function bakeNavMesh() {
  if (navHelper) { scene.remove(navHelper); navHelper = null }
  if (pathLine) { scene.remove(pathLine); pathLine = null }

  const inputMeshes = [floor, ...obstacles]   // ✅ 注意是 ...obstacles
  const [positions, indices] = getPositionsAndIndicesFromMeshes(inputMeshes)

  await initRecast() // wasm 初始化（幂等）

  const cfg = {
    cs: 0.25, ch: 0.2,
    walkableHeight: 1.8,
    walkableRadius: 0.4,
    walkableClimb: 0.4,
    walkableSlopeAngle: 45
  }

  const { success, navMesh } = generateSoloNavMesh(positions, indices, cfg)
  if (!success) {
    alert('NavMesh 生成失败，请调整参数或几何！')
    return
  }

  navQuery = new NavMeshQuery(navMesh)

  navHelper = new NavMeshHelper(navMesh)
  scene.add(navHelper)
}

// ---------- 寻路（高层 API：computePath） ----------
function findPathAndDraw() {
  if (!navQuery || !startMarker || !endMarker) {
    alert('请先设置起点/终点并烘焙 NavMesh')
    return
  }

  const { success, path, error } = navQuery.computePath(
    { x: startMarker.position.x, y: startMarker.position.y, z: startMarker.position.z },
    { x: endMarker.position.x,   y: endMarker.position.y,   z: endMarker.position.z }
  )

  if (!success || !path || path.length < 2) {
    console.warn('computePath 失败：', error)
    alert('寻路失败：起点/终点可能不在可走区域附近，或区域不连通')
    return
  }

  const pts = path.map(p => new THREE.Vector3(p.x, p.y + 0.05, p.z))
  const g = new THREE.BufferGeometry().setFromPoints(pts)
  const m = new THREE.LineBasicMaterial({ linewidth: 2, color: 0x00e5ff })
  if (pathLine) scene.remove(pathLine)
  pathLine = new THREE.Line(g, m)
  scene.add(pathLine)
}

// ---------- 事件：放置逻辑（一次性起/终点，拖动不误触） ----------
renderer.domElement.addEventListener('pointerdown', (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY }
})

renderer.domElement.addEventListener('click', (ev) => {
  if (ev.button !== 0) return
  if (!placingMode) return

  if (downPos) {
    const dx = ev.clientX - downPos.x
    const dy = ev.clientY - downPos.y
    if (Math.hypot(dx, dy) > 5) return // 视为拖动，不放置
  }

  const p = pickOnFloor(ev)
  if (!p) return

  if (placingMode === 'box') {
    addObstacleAt(p) // 盒子可连续放置；再次点击按钮可退出
  } else if (placingMode === 'start') {
    if (!startMarker) { startMarker = makeMarker(0x22cc88); scene.add(startMarker) }
    startMarker.position.copy(p).y = 0.25
    placingMode = null
    updateCursor()
  } else if (placingMode === 'end') {
    if (!endMarker) { endMarker = makeMarker(0xff5555); scene.add(endMarker) }
    endMarker.position.copy(p).y = 0.25
    placingMode = null
    updateCursor()
  }
})

// Esc 取消放置
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    placingMode = null
    updateCursor()
  }
})

// ---------- UI 绑定（按钮切换模式 + 光标反馈） ----------
document.getElementById('btnAddBox').onclick = () => {
  placingMode = (placingMode === 'box') ? null : 'box'
  updateCursor()
}
document.getElementById('btnSetStart').onclick = () => {
  placingMode = (placingMode === 'start') ? null : 'start'
  updateCursor()
}
document.getElementById('btnSetEnd').onclick = () => {
  placingMode = (placingMode === 'end') ? null : 'end'
  updateCursor()
}
document.getElementById('btnBake').onclick = () => bakeNavMesh()
document.getElementById('btnFind').onclick = () => findPathAndDraw()
document.getElementById('btnClear').onclick = () => {
  placingMode = null
  updateCursor()
  obstacles.forEach(m => scene.remove(m)); obstacles.length = 0
  if (startMarker) scene.remove(startMarker), startMarker = null
  if (endMarker) scene.remove(endMarker), endMarker = null
  if (pathLine) scene.remove(pathLine), pathLine = null
  if (navHelper) scene.remove(navHelper), navHelper = null
  navQuery = null
}

// ---------- 渲染循环 ----------
function onResize() {
  const w = root.clientWidth, h = root.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
window.addEventListener('resize', onResize)

;(function animate() {
  requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
})()
