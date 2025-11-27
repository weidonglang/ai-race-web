/*
 * Tetris.js
 * The logic for the Tetris game.
 */

const TetrisGame = {
  // --- Game Constants ---
  COLS: 10,
  ROWS: 20,
  BLOCK_SIZE: 20, // Canvas width = 10*20=200, height = 20*20=400
  
  // Colors for the pieces
  COLORS: [
    null,      // 0: Empty
    '#e06c75', // 1: I (Red)
    '#61afef', // 2: O (Blue)
    '#c678dd', // 3: T (Purple)
    '#98c379', // 4: S (Green)
    '#e5c07b', // 5: Z (Yellow)
    '#56b6c2', // 6: J (Cyan)
    '#abb2bf', // 7: L (Gray)
  ],

  // All 7 pieces and their 4 rotations
  PIECES: {
    'I': [
      [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]],
      [[0,1,0,0], [0,1,0,0], [0,1,0,0], [0,1,0,0]],
      [[0,0,0,0], [0,0,0,0], [1,1,1,1], [0,0,0,0]],
      [[0,0,1,0], [0,0,1,0], [0,0,1,0], [0,0,1,0]]
    ],
    'O': [
      [[2,2], [2,2]],
      [[2,2], [2,2]],
      [[2,2], [2,2]],
      [[2,2], [2,2]]
    ],
    'T': [
      [[0,3,0], [3,3,3], [0,0,0]],
      [[0,3,0], [0,3,3], [0,3,0]],
      [[0,0,0], [3,3,3], [0,3,0]],
      [[0,3,0], [3,3,0], [0,3,0]]
    ],
    'S': [
      [[0,4,4], [4,4,0], [0,0,0]],
      [[0,4,0], [0,4,4], [0,0,4]],
      [[0,0,0], [0,4,4], [4,4,0]],
      [[4,0,0], [4,4,0], [0,4,0]]
    ],
    'Z': [
      [[5,5,0], [0,5,5], [0,0,0]],
      [[0,0,5], [0,5,5], [0,5,0]],
      [[0,0,0], [5,5,0], [0,5,5]],
      [[0,5,0], [5,5,0], [5,0,0]]
    ],
    'J': [
      [[6,0,0], [6,6,6], [0,0,0]],
      [[0,6,6], [0,6,0], [0,6,0]],
      [[0,0,0], [6,6,6], [0,0,6]],
      [[0,6,0], [0,6,0], [6,6,0]]
    ],
    'L': [
      [[0,0,7], [7,7,7], [0,0,0]],
      [[0,7,0], [0,7,0], [0,7,7]],
      [[0,0,0], [7,7,7], [7,0,0]],
      [[7,7,0], [0,7,0], [0,7,0]]
    ]
  },
  
  // Scoring
  SCORE_VALUES: {
    1: 100, // 1 line
    2: 300, // 2 lines
    3: 500, // 3 lines
    4: 800  // 4 lines (Tetris)
  },

  // --- Game Properties ---
  canvas: null,
  ctx: null,
  nextCanvas: null,
  nextCtx: null,
  scoreElement: null,
  linesElement: null,
  messageElement: null,

  board: [],
  activePiece: null,
  nextPieceName: null,
  
  bag: [], // For 7-Bag randomizer
  
  score: 0,
  lines: 0,
  isGameOver: false,
  
  // Game loop properties
  lastTime: 0,
  dropCounter: 0,
  dropInterval: 1000, // Milliseconds (1 second)
  gameLoopId: null,

  boundHandleInput: null,

  // --- Core Functions ---
  init: function () {
    this.canvas = document.getElementById('tetris-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.nextCanvas = document.getElementById('next-piece-canvas');
    this.nextCtx = this.nextCanvas.getContext('2d');
    
    this.scoreElement = document.getElementById('tetris-score');
    this.linesElement = document.getElementById('tetris-lines');
    this.messageElement = document.getElementById('tetris-message');
    
    // Scale the context for block size
    this.ctx.scale(this.BLOCK_SIZE, this.BLOCK_SIZE);
    
    this.boundHandleInput = this.handleInput.bind(this);
    document.addEventListener('keydown', this.boundHandleInput);
    
    this.reset();
  },

  stop: function () {
    document.removeEventListener('keydown', this.boundHandleInput);
    if (this.gameLoopId) {
      cancelAnimationFrame(this.gameLoopId);
      this.gameLoopId = null;
    }
  },

  reset: function () {
    this.isGameOver = false;
    this.messageElement.style.display = 'none';
    
    // Create empty board
    this.board = Array.from({ length: this.ROWS }, () => Array(this.COLS).fill(0));
    
    this.score = 0;
    this.lines = 0;
    this.updateUI();
    
    this.bag = [];
    this.fillBag();
    this.spawnPiece();
    
    this.lastTime = 0;
    this.dropCounter = 0;
    this.dropInterval = 1000;
    
    if (this.gameLoopId) {
      cancelAnimationFrame(this.gameLoopId);
    }
    this.mainLoop(0);
  },
  
  /**
   * Main game loop using requestAnimationFrame
   */
  mainLoop: function (time = 0) {
    if (this.isGameOver) {
      this.drawGameOver();
      return;
    }
    
    const deltaTime = time - this.lastTime;
    this.lastTime = time;
    
    this.dropCounter += deltaTime;
    if (this.dropCounter > this.dropInterval) {
      this.pieceDrop();
    }
    
    this.draw();
    
    this.gameLoopId = requestAnimationFrame(this.mainLoop.bind(this));
  },
  
  /**
   * Fills the "7-Bag" with one of each piece, shuffled.
   */
  fillBag: function() {
    const pieces = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    // Fisher-Yates shuffle
    for (let i = pieces.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    this.bag = pieces;
  },
  
  /**
   * Spawns a new piece at the top of the board.
   */
  spawnPiece: function () {
    if (this.bag.length === 0) {
      this.fillBag();
    }
    const name = this.bag.pop();
    
    if (this.nextPieceName === null) {
      // On first spawn, fill next piece too
      if (this.bag.length === 0) this.fillBag();
      this.nextPieceName = this.bag.pop();
    }

    const color = this.COLORS[this.PIECES[name][0][0].find(c => c > 0) || this.PIECES[name][0][1].find(c => c > 0)];

    this.activePiece = {
      name: name,
      shape: this.PIECES[name][0],
      rotation: 0,
      x: Math.floor(this.COLS / 2) - 1,
      y: 0,
      color: color
    };
    
    // Set next piece
    const nextName = this.nextPieceName;
    const nextColor = this.COLORS[this.PIECES[nextName][0][0].find(c => c > 0) || this.PIECES[nextName][0][1].find(c => c > 0)];
    this.activePiece.next = {
      name: nextName,
      shape: this.PIECES[nextName][0],
      color: nextColor
    }
    
    // Get the *next* next piece
    if (this.bag.length === 0) this.fillBag();
    this.nextPieceName = this.bag.pop();
    this.drawNextPiece();

    // Check for game over
    if (!this.isValidMove(this.activePiece.shape, this.activePiece.x, this.activePiece.y)) {
      this.isGameOver = true;
    }
  },

  /**
   * Checks if a move is valid (no collisions with walls or board).
   */
  isValidMove: function (shape, x, y) {
    for (let py = 0; py < shape.length; py++) {
      for (let px = 0; px < shape[py].length; px++) {
        if (shape[py][px] > 0) {
          const boardX = x + px;
          const boardY = y + py;
          
          // Check wall collision
          if (boardX < 0 || boardX >= this.COLS || boardY >= this.ROWS) {
            return false;
          }
          // Check board collision
          if (this.board[boardY] && this.board[boardY][boardX] > 0) {
            return false;
          }
        }
      }
    }
    return true;
  },
  
  /**
   * Attempts to move the piece. Returns true if successful.
   */
  movePiece: function (dx, dy) {
    const newX = this.activePiece.x + dx;
    const newY = this.activePiece.y + dy;
    
    if (this.isValidMove(this.activePiece.shape, newX, newY)) {
      this.activePiece.x = newX;
      this.activePiece.y = newY;
      return true;
    }
    return false;
  },
  
  /**
   * Attempts to rotate the piece.
   */
  rotatePiece: function() {
    const newRotation = (this.activePiece.rotation + 1) % 4;
    const newShape = this.PIECES[this.activePiece.name][newRotation];
    
    // Test 1: Original position
    if (this.isValidMove(newShape, this.activePiece.x, this.activePiece.y)) {
      this.activePiece.shape = newShape;
      this.activePiece.rotation = newRotation;
      return;
    }
    
    // Test 2: Wall kick 1 unit left
    if (this.isValidMove(newShape, this.activePiece.x - 1, this.activePiece.y)) {
      this.activePiece.shape = newShape;
      this.activePiece.rotation = newRotation;
      this.activePiece.x -= 1;
      return;
    }
    
    // Test 3: Wall kick 1 unit right
    if (this.isValidMove(newShape, this.activePiece.x + 1, this.activePiece.y)) {
      this.activePiece.shape = newShape;
      this.activePiece.rotation = newRotation;
      this.activePiece.x += 1;
      return;
    }
  },
  
  /**
   * Forces the piece down one step (player input).
   */
  pieceDrop: function () {
    if (!this.movePiece(0, 1)) {
      // Can't move down, so lock it
      this.lockPiece();
    }
    this.dropCounter = 0;
  },
  
  /**
   * Hard drops the piece to the bottom.
   */
  hardDrop: function() {
    while(this.movePiece(0, 1)) {
      // Keep moving down
    }
    this.lockPiece();
  },
  
  /**
   * Locks the active piece into the board.
   */
  lockPiece: function () {
    const shape = this.activePiece.shape;
    const x = this.activePiece.x;
    const y = this.activePiece.y;
    
    for (let py = 0; py < shape.length; py++) {
      for (let px = 0; px < shape[py].length; px++) {
        if (shape[py][px] > 0) {
          const boardX = x + px;
          const boardY = y + py;
          if (boardY >= 0) { // Only lock blocks on the board
            this.board[boardY][boardX] = shape[py][px];
          }
        }
      }
    }
    
    this.clearLines();
    this.spawnPiece();
  },
  
  /**
   * Checks for and clears any completed lines.
   */
  clearLines: function () {
    let linesCleared = 0;
    
    for (let y = this.ROWS - 1; y >= 0; y--) {
      // Check if row is full
      if (this.board[y].every(cell => cell > 0)) {
        // Row is full
        linesCleared++;
        // Remove row
        this.board.splice(y, 1);
        // Add new empty row at top
        this.board.unshift(Array(this.COLS).fill(0));
        // We need to re-check this row index
        y++;
      }
    }
    
    if (linesCleared > 0) {
      this.updateScore(linesCleared);
    }
  },
  
  /**
   * Updates score and lines based on lines cleared.
   */
  updateScore: function(linesCleared) {
    this.score += this.SCORE_VALUES[linesCleared];
    this.lines += linesCleared;
    this.updateUI();
    
    // Increase speed (simple version)
    this.dropInterval = Math.max(200, 1000 - (this.lines * 10));
  },
  
  updateUI: function() {
    this.scoreElement.textContent = this.score;
    this.linesElement.textContent = this.lines;
  },

  // --- Drawing Functions ---
  
  draw: function () {
    // Clear canvas (scale handles block size)
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.COLS, this.ROWS);
    
    this.drawBoard();
    this.drawPiece(this.activePiece);
  },
  
  drawBoard: function() {
    for (let y = 0; y < this.ROWS; y++) {
      for (let x = 0; x < this.COLS; x++) {
        if (this.board[y][x] > 0) {
          this.ctx.fillStyle = this.COLORS[this.board[y][x]];
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  },
  
  drawPiece: function(piece) {
    this.ctx.fillStyle = piece.color;
    const shape = piece.shape;
    
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x] > 0) {
          this.ctx.fillRect(piece.x + x, piece.y + y, 1, 1);
        }
      }
    }
  },
  
  drawNextPiece: function() {
    this.nextCtx.fillStyle = '#000';
    this.nextCtx.fillRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
    
    const name = this.nextPieceName;
    const shape = this.PIECES[name][0];
    const color = this.COLORS[this.PIECES[name][0][0].find(c => c > 0) || this.PIECES[name][0][1].find(c => c > 0)];
    
    this.nextCtx.fillStyle = color;
    
    // Center the piece
    const b = this.BLOCK_SIZE;
    const canvasSize = this.nextCanvas.width / b; // 4
    const shapeSize = shape.length; // 2, 3, or 4
    const offset = (canvasSize - shapeSize) / 2;
    
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x] > 0) {
          this.nextCtx.fillRect((offset + x) * b, (offset + y) * b, b, b);
        }
      }
    }
  },
  
  drawGameOver: function() {
    this.messageElement.style.display = 'block';
    this.messageElement.textContent = `游戏结束！得分：${this.score}。点击重新开始。`;
    this.messageElement.onclick = () => this.reset();
  },

  // --- Input Handling ---
  
  handleInput: function (e) {
    if (this.isGameOver) {
      return;
    }
    
    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
        this.movePiece(-1, 0);
        break;
      case 'ArrowRight':
      case 'd':
        this.movePiece(1, 0);
        break;
      case 'ArrowDown':
      case 's':
        this.pieceDrop();
        break;
      case 'ArrowUp':
      case 'w':
        this.rotatePiece();
        break;
      case ' ': // Spacebar
        e.preventDefault(); // Stop page from scrolling
        this.hardDrop();
        break;
    }
    
    // Draw immediately after input for responsiveness
    this.draw();
  },
};
