/*
 * Sudoku.js
 * The logic for the Sudoku game.
 */

const SudokuGame = {
  // --- Game Properties ---
  boardElement: null,
  messageElement: null,
  
  // 9x9 2D arrays
  solution: [],
  puzzle: [],
  playerBoard: [],

  // --- Puzzle Database ---
  // (0 represents a blank cell)
  puzzles: [
    {
      puzzle: [
        [5,3,0,0,7,0,0,0,0],
        [6,0,0,1,9,5,0,0,0],
        [0,9,8,0,0,0,0,6,0],
        [8,0,0,0,6,0,0,0,3],
        [4,0,0,8,0,3,0,0,1],
        [7,0,0,0,2,0,0,0,6],
        [0,6,0,0,0,0,2,8,0],
        [0,0,0,4,1,9,0,0,5],
        [0,0,0,0,8,0,0,7,9]
      ],
      solution: [
        [5,3,4,6,7,8,9,1,2],
        [6,7,2,1,9,5,3,4,8],
        [1,9,8,3,4,2,5,6,7],
        [8,5,9,7,6,1,4,2,3],
        [4,2,6,8,5,3,7,9,1],
        [7,1,3,9,2,4,8,5,6],
        [9,6,1,5,3,7,2,8,4],
        [2,8,7,4,1,9,6,3,5],
        [3,4,5,2,8,6,1,7,9]
      ]
    },
    {
      puzzle: [
        [0,0,0,2,6,0,7,0,1],
        [6,8,0,0,7,0,0,9,0],
        [1,9,0,0,0,4,5,0,0],
        [8,2,0,1,0,0,0,4,0],
        [0,0,4,6,0,2,9,0,0],
        [0,5,0,0,0,3,0,2,8],
        [0,0,9,3,0,0,0,7,4],
        [0,4,0,0,5,0,0,3,6],
        [7,0,3,0,1,8,0,0,0]
      ],
      solution: [
        [4,3,5,2,6,9,7,8,1],
        [6,8,2,5,7,1,4,9,3],
        [1,9,7,8,3,4,5,6,2],
        [8,2,6,1,9,5,3,4,7],
        [3,7,4,6,8,2,9,1,5],
        [9,5,1,7,4,3,6,2,8],
        [5,1,9,3,2,6,8,7,4],
        [2,4,8,9,5,7,1,3,6],
        [7,6,3,4,1,8,2,5,9]
      ]
    },
    {
      puzzle: [
        [0,2,0,6,0,8,0,0,0],
        [5,8,0,0,0,9,7,0,0],
        [0,0,0,0,4,0,0,0,0],
        [3,7,0,0,0,0,5,0,0],
        [6,0,0,0,0,0,0,0,4],
        [0,0,8,0,0,0,0,1,3],
        [0,0,0,0,2,0,0,0,0],
        [0,0,9,8,0,0,0,3,6],
        [0,0,0,3,0,6,0,9,0]
      ],
      solution: [
        [1,2,3,6,7,8,9,4,5],
        [5,8,4,2,3,9,7,6,1],
        [9,6,7,1,4,5,3,2,8],
        [3,7,2,4,6,1,5,8,9],
        [6,9,1,5,8,3,2,7,4],
        [4,5,8,7,9,2,6,1,3],
        [8,3,6,9,2,4,1,5,7],
        [2,1,9,8,5,7,4,3,6],
        [7,4,5,3,1,6,8,9,2]
      ]
    }
  ],

  // --- Core Functions ---

  init: function () {
    this.boardElement = document.getElementById('sudoku-board');
    this.messageElement = document.getElementById('sudoku-message');
    document.getElementById('sudoku-new-game').addEventListener('click', this.reset.bind(this));
    
    this.boundHandleInput = this.handleInput.bind(this);
    this.reset();
  },

  stop: function () {
    // No game loop to stop, but we can clear the board
    this.boardElement.innerHTML = '';
    this.messageElement.style.display = 'none';
  },

  reset: function () {
    // Select a random puzzle
    const puzzleData = this.puzzles[Math.floor(Math.random() * this.puzzles.length)];
    
    // Deep copy the arrays to prevent modification of the originals
    this.puzzle = puzzleData.puzzle.map(row => [...row]);
    this.solution = puzzleData.solution.map(row => [...row]);
    this.playerBoard = puzzleData.puzzle.map(row => [...row]);

    this.messageElement.style.display = 'none';
    this.createBoard();
  },
  
  /**
   * Generates the 81 input elements for the grid.
   */
  createBoard: function () {
    this.boardElement.innerHTML = ''; // Clear old board

    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const cell = document.createElement('input');
        cell.type = 'text';
        cell.className = 'sudoku-cell';
        cell.maxLength = 1;
        cell.dataset.x = x;
        cell.dataset.y = y;

        // Add classes for styling 3x3 box borders
        if (x === 2 || x === 5) cell.classList.add('border-right');
        if (y === 2 || y === 5) cell.classList.add('border-bottom');
        
        const cellValue = this.puzzle[y][x];
        
        if (cellValue !== 0) {
          // It's a pre-filled "clue" cell
          cell.value = cellValue;
          cell.disabled = true;
          cell.classList.add('clue');
        } else {
          // It's an empty cell for the player
          cell.addEventListener('input', this.boundHandleInput);
        }
        
        this.boardElement.appendChild(cell);
      }
    }
  },
  
  /**
   * Handles user input into any of the cells.
   */
  handleInput: function (e) {
    const input = e.target;
    let value = input.value;
    
    // Get coordinates
    const x = parseInt(input.dataset.x);
    const y = parseInt(input.dataset.y);

    // --- 1. Validate Input ---
    // Allow only numbers 1-9
    if (!/^[1-9]$/.test(value)) {
      if (value !== '') { // Allow blanking the cell
        input.value = this.playerBoard[y][x] || '';
      }
      value = '';
    }
    
    // --- 2. Update Player Board ---
    this.playerBoard[y][x] = value ? parseInt(value) : 0;
    
    // --- 3. Check for Conflicts ---
    this.validateBoard();
    
    // --- 4. Check for Win ---
    this.checkWinCondition();
  },
  
  /**
   * Checks the entire board for conflicts and adds/removes 'error' class.
   */
  validateBoard: function() {
    // Clear all previous errors
    this.boardElement.querySelectorAll('.sudoku-cell').forEach(cell => {
      cell.classList.remove('error');
    });
    
    let hasConflict = false;
    
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const value = this.playerBoard[y][x];
        if (value === 0) continue; // Skip empty cells
        
        // Check for conflicts
        if (!this.isValid(x, y, value)) {
          hasConflict = true;
          // Add error class to the specific input
          this.getCellElement(x, y).classList.add('error');
        }
      }
    }
    return !hasConflict;
  },
  
  /**
   * Checks if placing `value` at `(x, y)` is valid (no conflicts).
   */
  isValid: function(x, y, value) {
    // Check Row
    for (let i = 0; i < 9; i++) {
      if (i !== x && this.playerBoard[y][i] === value) return false;
    }
    
    // Check Column
    for (let i = 0; i < 9; i++) {
      if (i !== y && this.playerBoard[i][x] === value) return false;
    }
    
    // Check 3x3 Box
    const startX = Math.floor(x / 3) * 3;
    const startY = Math.floor(y / 3) * 3;
    
    for (let by = startY; by < startY + 3; by++) {
      for (let bx = startX; bx < startX + 3; bx++) {
        if (bx !== x || by !== y) {
          if (this.playerBoard[by][bx] === value) return false;
        }
      }
    }
    
    return true; // No conflicts found
  },
  
  /**
   * Checks if the board is full and correct.
   */
  checkWinCondition: function() {
    let isFull = true;
    
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        if (this.playerBoard[y][x] === 0) {
          isFull = false;
          break;
        }
      }
      if (!isFull) break;
    }
    
    if (isFull && this.validateBoard()) {
      // Board is full and has no conflicts!
      this.messageElement.textContent = '你赢了！';
      this.messageElement.className = 'game-message win';
      this.messageElement.style.display = 'block';
      // Disable all inputs
      this.boardElement.querySelectorAll('input').forEach(cell => cell.disabled = true);
    }
  },
  
  /**
   * Helper function to get the DOM element at (x, y).
   */
  getCellElement: function(x, y) {
    return this.boardElement.querySelector(`input[data-x="${x}"][data-y="${y}"]`);
  }
};
