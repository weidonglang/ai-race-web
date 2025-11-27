/*
 * Snake.js
 * The logic for the classic Snake game.
 */

const SnakeGame = {
  // --- Game Properties ---
  canvas: null,
  ctx: null,
  scoreElement: null,

  gridSize: 20, // 20px per square
  tileCount: 20, // 20 tiles in a 400px canvas (400 / 20)

  // Snake properties
  snake: [],
  direction: { x: 1, y: 0 }, // Start moving right
  nextDirection: { x: 1, y: 0 }, // Input buffer

  // Food properties
  food: { x: 15, y: 15 },

  // Game state
  score: 0,
  isGameOver: false,
  gameLoopTimeout: null,

  // --- Core Functions ---

  /**
   * Initializes the game.
   * Called by main.js when the player selects Snake.
   */
  init: function () {
    // Get elements from the DOM
    this.canvas = document.getElementById('snake-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.scoreElement = document.getElementById('snake-score');
    
    // Calculate tile count based on canvas size
    this.tileCount = this.canvas.width / this.gridSize;

    // Bind the keydown event listener
    // We store the bound function to be able to remove it later
    this.boundHandleInput = this.handleInput.bind(this);
    document.addEventListener('keydown', this.boundHandleInput);

    // Start the game
    this.reset();
  },

  /**
   * Resets the game to its initial state.
   */
  reset: function () {
    this.isGameOver = false;
    this.score = 0;
    this.scoreElement.textContent = this.score;

    // Initial snake
    this.snake = [{ x: 10, y: 10 }]; // Start in the middle

    // Initial direction
    this.direction = { x: 1, y: 0 };
    this.nextDirection = { x: 1, y: 0 };

    this.generateFood();

    // Clear any existing game loop
    if (this.gameLoopTimeout) {
      clearTimeout(this.gameLoopTimeout);
    }
    // Start the game loop
    this.mainLoop();
  },

  /**
   * Stops the game.
   * Called by main.js when the player goes back to the lobby.
   */
  stop: function () {
    // Stop the game loop
    if (this.gameLoopTimeout) {
      clearTimeout(this.gameLoopTimeout);
    }
    // Remove the event listener to prevent errors
    document.removeEventListener('keydown', this.boundHandleInput);
  },

  /**
   * The main game loop.
   * Runs at a fixed interval (100ms = 10 frames per second).
   */
  mainLoop: function () {
    if (this.isGameOver) {
      this.drawGameOver();
      return;
    }

    this.update();
    this.draw();

    // Schedule the next loop
    this.gameLoopTimeout = setTimeout(this.mainLoop.bind(this), 100);
  },

  /**
   * Updates the game state (snake movement, collisions, etc.).
   */
  update: function () {
    // --- 1. Update Direction (from input buffer) ---
    // This prevents 180-degree turns
    if (this.nextDirection.x !== -this.direction.x || this.snake.length === 1) {
      this.direction.x = this.nextDirection.x;
    }
    if (this.nextDirection.y !== -this.direction.y || this.snake.length === 1) {
      this.direction.y = this.nextDirection.y;
    }

    // --- 2. Calculate new head position ---
    const head = { x: this.snake[0].x + this.direction.x, y: this.snake[0].y + this.direction.y };

    // --- 3. Check for Wall Collisions ---
    if (head.x < 0 || head.x >= this.tileCount || head.y < 0 || head.y >= this.tileCount) {
      this.isGameOver = true;
      return;
    }

    // --- 4. Check for Self Collisions ---
    for (let i = 1; i < this.snake.length; i++) {
      if (head.x === this.snake[i].x && head.y === this.snake[i].y) {
        this.isGameOver = true;
        return;
      }
    }

    // --- 5. Add new head ---
    this.snake.unshift(head); // Add to the front

    // --- 6. Check for Food Collision ---
    if (head.x === this.food.x && head.y === this.food.y) {
      // Food eaten
      this.score++;
      this.scoreElement.textContent = this.score;
      this.generateFood();
      // Don't remove the tail, snake grows
    } else {
      // No food eaten, remove the tail
      this.snake.pop();
    }
  },

  /**
   * Draws the entire game state to the canvas.
   */
  draw: function () {
    // Clear canvas (black background)
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw food (red)
    this.ctx.fillStyle = '#e06c75'; // Red
    this.ctx.fillRect(
      this.food.x * this.gridSize,
      this.food.y * this.gridSize,
      this.gridSize,
      this.gridSize
    );

    // Draw snake (green)
    this.ctx.fillStyle = '#98c379'; // Green
    this.snake.forEach(segment => {
      this.ctx.fillRect(
        segment.x * this.gridSize,
        segment.y * this.gridSize,
        this.gridSize,
        this.gridSize
      );
    });

    // Draw snake head (brighter green)
    if (this.snake.length > 0) {
      this.ctx.fillStyle = '#b3e87d'; // Brighter Green
      this.ctx.fillRect(
        this.snake[0].x * this.gridSize,
        this.snake[0].y * this.gridSize,
        this.gridSize,
        this.gridSize
      );
    }
  },

  /**
   * Draws the "Game Over" message.
   */
  drawGameOver: function () {
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.fillStyle = '#fff';
    this.ctx.font = '40px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('游戏结束', this.canvas.width / 2, this.canvas.height / 2 - 20);
    
    this.ctx.font = '20px Arial';
    this.ctx.fillText(`得分：${this.score}`, this.canvas.width / 2, this.canvas.height / 2 + 20);

    this.ctx.font = '16px Arial';
    this.ctx.fillText('按 Enter 重新开始', this.canvas.width / 2, this.canvas.height / 2 + 60);
  },

  /**
   * Generates a new piece of food in a valid location.
   */
  generateFood: function () {
    let newFood;
    let isValid = false;

    // Loop until we find a spot that is NOT on the snake
    do {
      newFood = {
        x: Math.floor(Math.random() * this.tileCount),
        y: Math.floor(Math.random() * this.tileCount),
      };

      // Check if newFood is on the snake
      isValid = !this.snake.some(
        segment => segment.x === newFood.x && segment.y === newFood.y
      );
    } while (!isValid);

    this.food = newFood;
  },

  /**
   * Handles keyboard input.
   * Stores the next move in `nextDirection` (input buffer).
   */
  handleInput: function (e) {
    if (this.isGameOver) {
      if (e.key === 'Enter') {
        this.reset();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
      case 'w':
        // Only allow move if not currently moving down
        if (this.direction.y === 0) {
          this.nextDirection = { x: 0, y: -1 };
        }
        break;
      case 'ArrowDown':
      case 's':
        // Only allow move if not currently moving up
        if (this.direction.y === 0) {
          this.nextDirection = { x: 0, y: 1 };
        }
        break;
      case 'ArrowLeft':
      case 'a':
        // Only allow move if not currently moving right
        if (this.direction.x === 0) {
          this.nextDirection = { x: -1, y: 0 };
        }
        break;
      case 'ArrowRight':
      case 'd':
        // Only allow move if not currently moving left
        if (this.direction.x === 0) {
          this.nextDirection = { x: 1, y: 0 };
        }
        break;
    }
  },
};
