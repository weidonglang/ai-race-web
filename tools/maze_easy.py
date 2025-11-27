from maze_gen_core import generate_batch

if __name__ == "__main__":
    # 生成 5 个简单迷宫
    generate_batch("easy", count=50, out_dir="./mazes")
