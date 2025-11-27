# tools/maze_gen_core.py
"""
生成不同难度的 2D/3D 迷宫（用于 Three.js 场景）。
核心思路：
1. 用 DFS（Recursive Backtracker）生成“完美迷宫”（无环、唯一通路）:contentReference[oaicite:1]{index=1}
2. 随机挖掉部分额外墙体，制造环路 → 增加复杂度
3. 用 BFS 求 start→goal 的最短路径，保证一定可达
4. 在非最短路径的格子上随机打一些陷阱（trap）
5. 导出成统一 JSON 格式，方便前端加载
"""

import json
import os
import random
from collections import deque
from dataclasses import dataclass
from typing import List, Tuple, Dict, Set

# 方向 bitmask：四面墙
N, S, E, W = 1, 2, 4, 8

DIRS = {
    N: (0, -1),
    S: (0, 1),
    E: (1, 0),
    W: (-1, 0),
}

OPPOSITE = {
    N: S,
    S: N,
    E: W,
    W: E,
}


@dataclass
class MazeConfig:
    name: str
    nx: int
    nz: int
    extra_open_ratio: float  # 额外挖墙比例（越大环越多）
    trap_density: float      # 陷阱密度（非最短路径格子中的比例）
    cell_size: float = 1.0


DIFF_CONFIGS: Dict[str, MazeConfig] = {
    "easy": MazeConfig("easy",   nx=12, nz=12, extra_open_ratio=0.02, trap_density=0.00),
    "medium": MazeConfig("medium", nx=20, nz=20, extra_open_ratio=0.05, trap_density=0.03),
    "hard": MazeConfig("hard",  nx=28, nz=28, extra_open_ratio=0.10, trap_density=0.06),
}


def _in_bounds(x: int, z: int, nx: int, nz: int) -> bool:
    return 0 <= x < nx and 0 <= z < nz


def generate_perfect_maze(nx: int, nz: int, rng: random.Random) -> List[List[int]]:
    """
    通过随机深度优先（Recursive Backtracker）生成“完美迷宫”（无环）:contentReference[oaicite:2]{index=2}
    返回：walls[z][x]，每个格子一个 bitmask，表示四个方向哪些地方有墙。
    """
    # 初始化：四面墙全在
    walls = [[N | S | E | W for _ in range(nx)] for _ in range(nz)]
    visited = [[False] * nx for _ in range(nz)]

    # 从 (0,0) 开始，也可以改成随机起点
    stack: List[Tuple[int, int]] = [(0, 0)]
    visited[0][0] = True

    while stack:
        x, z = stack[-1]

        # 找所有未访问的邻居
        neighbors = []
        for d, (dx, dz) in DIRS.items():
            nx2, nz2 = x + dx, z + dz
            if _in_bounds(nx2, nz2, nx, nz) and not visited[nz2][nx2]:
                neighbors.append((d, nx2, nz2))

        if not neighbors:
            # 无新邻居，回退一步
            stack.pop()
            continue

        d, nx2, nz2 = rng.choice(neighbors)
        # 打通当前格子与选中的邻居
        walls[z][x] &= ~d
        walls[nz2][nx2] &= ~OPPOSITE[d]

        visited[nz2][nx2] = True
        stack.append((nx2, nz2))

    return walls


def add_loops(walls: List[List[int]], extra_open_ratio: float, rng: random.Random) -> None:
    """
    在完美迷宫基础上随机再挖一些墙，制造环路，增加复杂度。
    """
    nz = len(walls)
    nx = len(walls[0]) if nz > 0 else 0
    total_cells = nx * nz
    # 额外挖墙次数：和迷宫规模、难度有关
    num_extra = int(total_cells * extra_open_ratio)

    for _ in range(num_extra):
        x = rng.randrange(nx)
        z = rng.randrange(nz)
        # 随机方向尝试挖墙
        dirs = list(DIRS.keys())
        rng.shuffle(dirs)
        for d in dirs:
            dx, dz = DIRS[d]
            nx2, nz2 = x + dx, z + dz
            if not _in_bounds(nx2, nz2, nx, nz):
                continue
            # 如果当前方向还有墙，就挖掉它（不用再检查连通性，刻意引入环）
            if walls[z][x] & d:
                walls[z][x] &= ~d
                walls[nz2][nx2] &= ~OPPOSITE[d]
                break


def shortest_path(walls: List[List[int]],
                  start: Tuple[int, int],
                  goal: Tuple[int, int]) -> List[Tuple[int, int]]:
    """
    用 BFS 在格子图上求最短路径（按照格子数）。:contentReference[oaicite:3]{index=3}
    """
    from_x, from_z = start
    to_x, to_z = goal
    nz = len(walls)
    nx = len(walls[0]) if nz > 0 else 0

    q = deque()
    q.append((from_x, from_z))
    prev: Dict[Tuple[int, int], Tuple[int, int]] = {}
    seen: Set[Tuple[int, int]] = {(from_x, from_z)}

    while q:
        x, z = q.popleft()
        if (x, z) == (to_x, to_z):
            break

        for d, (dx, dz) in DIRS.items():
            # 如果该方向没有墙，则可以通行
            if walls[z][x] & d:
                # 有墙，不能走
                continue
            nx2, nz2 = x + dx, z + dz
            if not _in_bounds(nx2, nz2, nx, nz):
                continue
            if (nx2, nz2) in seen:
                continue
            seen.add((nx2, nz2))
            prev[(nx2, nz2)] = (x, z)
            q.append((nx2, nz2))

    # 回溯路径
    path: List[Tuple[int, int]] = []
    cur = (to_x, to_z)
    if cur not in prev and cur != (from_x, from_z):
        # 没有找到路径（理应不会发生，如果发生说明迷宫/参数有问题）
        return []

    while True:
        path.append(cur)
        if cur == (from_x, from_z):
            break
        cur = prev[cur]
    path.reverse()
    return path


def choose_traps(nx: int, nz: int,
                 path_cells: Set[Tuple[int, int]],
                 rng: random.Random,
                 trap_density: float) -> Set[Tuple[int, int]]:
    """
    从“非最短路径格子”中随机挑一些作为陷阱，避免把主路直接堵死。
    """
    candidates = [
        (x, z)
        for z in range(nz)
        for x in range(nx)
        if (x, z) not in path_cells and not (x == 0 and z == 0)
    ]
    if not candidates or trap_density <= 0:
        return set()

    num_traps = int(len(candidates) * trap_density)
    num_traps = max(0, num_traps)
    if num_traps == 0:
        return set()

    chosen = rng.sample(candidates, min(num_traps, len(candidates)))
    return set(chosen)


def build_maze_json(cfg: MazeConfig,
                    seed: int | None = None,
                    maze_id: str | None = None) -> dict:
    """
    生成完整迷宫 JSON 对象（尚未写入文件）。
    """
    rng = random.Random(seed)

    nx, nz = cfg.nx, cfg.nz
    walls = generate_perfect_maze(nx, nz, rng)
    if cfg.extra_open_ratio > 0:
        add_loops(walls, cfg.extra_open_ratio, rng)

    # 起点终点先用对角线两角
    start = (0, 0)
    goal = (nx - 1, nz - 1)

    path = shortest_path(walls, start, goal)
    if not path:
        # 极小概率事件：没找到路径，直接抛异常，方便调试
        raise RuntimeError("No path found from start to goal. Check maze generation parameters.")

    path_set = set(path)
    trap_set = choose_traps(nx, nz, path_set, rng, cfg.trap_density)

    if maze_id is None:
        maze_id = f"maze_{cfg.name}_{rng.randrange(1_000_000)}"

    cells: List[List[dict]] = []
    for z in range(nz):
        row: List[dict] = []
        for x in range(nx):
            wmask = walls[z][x]
            cell = {
                "i": x,
                "k": z,
                "walls": {
                    "N": bool(wmask & N),
                    "S": bool(wmask & S),
                    "E": bool(wmask & E),
                    "W": bool(wmask & W),
                },
                "trap": (x, z) in trap_set,
            }
            row.append(cell)
        cells.append(row)

    shortest_path_json = [{"i": x, "k": z} for (x, z) in path]

    data = {
        "id": maze_id,
        "difficulty": cfg.name,
        "size": {"nx": nx, "nz": nz, "cellSize": cfg.cell_size},
        "layers": 1,
        "start": {"layer": 0, "i": start[0], "k": start[1]},
        "goal": {"layer": 0, "i": goal[0], "k": goal[1]},
        "shortestPath": shortest_path_json,
        "cells": cells,
    }
    return data


def save_maze_json(data: dict, out_dir: str) -> str:
    """
    保存为 JSON 文件，返回保存路径。
    """
    os.makedirs(out_dir, exist_ok=True)
    maze_id = data.get("id", "maze")
    filename = f"{maze_id}.json"
    path = os.path.join(out_dir, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def generate_batch(difficulty: str,
                   count: int = 3,
                   out_dir: str = "./mazes",
                   seed: int | None = None) -> None:
    """
    批量生成某个难度的迷宫 JSON。
    """
    if difficulty not in DIFF_CONFIGS:
        raise ValueError(f"Unknown difficulty: {difficulty!r}, should be one of {list(DIFF_CONFIGS.keys())}")

    cfg = DIFF_CONFIGS[difficulty]
    base_seed = seed if seed is not None else random.randrange(1_000_000_000)

    print(f"[maze_gen_core] Generating {count} mazes, difficulty={difficulty}, base_seed={base_seed}")
    for i in range(count):
        maze_seed = base_seed + i
        maze_id = f"maze_{difficulty}_{i:03d}"
        data = build_maze_json(cfg, seed=maze_seed, maze_id=maze_id)
        path = save_maze_json(data, out_dir)
        print(f"  -> {path}")


if __name__ == "__main__":
    # 直接运行本文件：python maze_gen_core.py medium 5
    import sys
    diff = sys.argv[1] if len(sys.argv) > 1 else "easy"
    cnt = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    generate_batch(diff, cnt)
