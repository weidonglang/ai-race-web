from maze_gen_core import generate_batch

if __name__ == "__main__":
    # 生成 5 个中等迷宫
    generate_batch("medium", count=5, out_dir="./mazes")
