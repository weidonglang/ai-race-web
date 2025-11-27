/*
 * Minesweeper.js
 * The logic for the Minesweeper game.
 */

const MinesweeperGame = {
  // --- Game Properties ---
  boardElement: null,
  minesLeftElement: null,
  messageElement: null,

  gridSize: 16,
  mineCount: 40,

  board: [], // 2D array of tile objects
  minesLeft: 0,
  isGameOver: false,
  isFirstClick: true,

  // Storing bound functions for easy add/remove of listeners
  boundLeftClick: null,
  boundRightClick: null,

  // --- Core Functions ---

  /**
   * Initializes the game.
   * Called by main.js when the player selects Minesweeper.
   */
  init: function () {
    // Get elements from the DOM
    this.boardElement = document.getElementById('minesweeper-board');
    this.minesLeftElement = document.getElementById('mines-left');
    this.messageElement = document.getElementById('minesweeper-message');

    // Set board CSS grid properties
    this.boardElement.style.gridTemplateColumns = `repeat(${this.gridSize}, 1fr)`;

    // Bind event handlers
    this.boundLeftClick = this.handleLeftClick.bind(this);
    this.boundRightClick = this.handleRightClick.bind(this);
    
    // Use event delegation on the board
    this.boardElement.addEventListener('click', this.boundLeftClick);
    this.boardElement.addEventListener('contextmenu', this.boundRightClick); // contextmenu = right click

    this.reset();
  },

  /**
   * Resets the game to its initial state.
   */
  reset: function () {
    this.isGameOver = false;
    this.isFirstClick = true;
    this.minesLeft = this.mineCount;
    this.board = [];

    this.minesLeftElement.textContent = this.minesLeft;
    this.messageElement.textContent = '';
    this.messageElement.style.display = 'none';
    this.boardElement.innerHTML = ''; // Clear old board

    this.createBoard();
  },

  /**
   * Stops the game and cleans up listeners.
   * Called by main.js when the player goes back to the lobby.
   */
  stop: function () {
    // Remove event listeners
    this.boardElement.removeEventListener('click', this.boundLeftClick);
    this.boardElement.removeEventListener('contextmenu', this.boundRightClick);
  },

  /**
   * Creates the 2D board array and the corresponding DOM elements.
   */
  createBoard: function () {
    for (let y = 0; y < this.gridSize; y++) {
      const row = [];
      for (let x = 0; x < this.gridSize; x++) {
        const tileElement = document.createElement('div');
        tileElement.className = 'minesweeper-tile';
        tileElement.dataset.x = x;
        tileElement.dataset.y = y;

        const tile = {
          x,
          y,
          isMine: false,
          isRevealed: false,
          isFlagged: false,
          adjacentCount: 0,
          element: tileElement,
        };

        row.push(tile);
        this.boardElement.appendChild(tileElement);
      }
      this.board.push(row);
    }
  },

  /**
   * Places mines on the board, ensuring first-click safety.
   * @param {number} clickedX - The x-coordinate of the first click.
   * @param {number} clickedY - The y-coordinate of the first click.
   */
  placeMines: function (clickedX, clickedY) {
    let minesPlaced = 0;
    while (minesPlaced < this.mineCount) {
      const x = Math.floor(Math.random() * this.gridSize);
      const y = Math.floor(Math.random() * this.gridSize);
      const tile = this.board[y][x];

      // First-Click Safety: Don't place a mine on the clicked tile or its neighbors
      const isSafeClick = Math.abs(x - clickedX) <= 1 && Math.abs(y - clickedY) <= 1;

      if (!tile.isMine && !isSafeClick) {
        tile.isMine = true;
        minesPlaced++;
      }
    }

    // After placing mines, calculate adjacent counts for all tiles
    this.calculateAdjacentCounts();
  },

  /**
   * Calculates the `adjacentCount` for every tile on the board.
   */
  calculateAdjacentCounts: function () {
    for (let y = 0; y < this.gridSize; y++) {
      for (let x = 0; x < this.gridSize; x++) {
        if (this.board[y][x].isMine) continue;

        const neighbors = this.getNeighbors(x, y);
        let count = 0;
        for (const neighbor of neighbors) {
          if (neighbor.isMine) {
            count++;
          }
        }
        this.board[y][x].adjacentCount = count;
      }
    }
  },

  /**
   * Gets all 8 valid neighbors for a given tile.
   * @param {number} x - The x-coordinate of the tile.
   * @param {number} y - The y-coordinate of the tile.
   * @returns {Array} An array of neighbor tile objects.
   */
  getNeighbors: function (x, y) {
    const neighbors = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        if (a === 0 && b === 0) continue; // Skip self

        const newX = x + a;
        const newY = y + b;

        // Check if neighbor is within bounds
        if (newX >= 0 && newX < this.gridSize && newY >= 0 && newY < this.gridSize) {
          neighbors.push(this.board[newY][newX]);
        }
      }
    }
    return neighbors;
  },

  /**
   * Handles all left-clicks on the board.
   */
  handleLeftClick: function (e) {
    const tileElement = e.target;
    if (!tileElement.classList.contains('minesweeper-tile')) return; // Clicked on grid gap

    const x = parseInt(tileElement.dataset.x);
    const y = parseInt(tileElement.dataset.y);
    const tile = this.board[y][x];

    if (this.isGameOver || tile.isFlagged || tile.isRevealed) {
      return;
    }

    // --- First-Click Safety ---
    if (this.isFirstClick) {
      this.placeMines(x, y);
      this.isFirstClick = false;
    }

    this.revealTile(tile);
    this.checkWinCondition();
  },

  /**
   * Handles all right-clicks on the board (flagging).
   */
  handleRightClick: function (e) {
    e.preventDefault(); // Stop the browser context menu
    if (this.isGameOver) return;

    const tileElement = e.target;
    if (!tileElement.classList.contains('minesweeper-tile')) return;

    const x = parseInt(tileElement.dataset.x);
    const y = parseInt(tileElement.dataset.y);
    const tile = this.board[y][x];

    if (tile.isRevealed) return;

    // Toggle flag
    tile.isFlagged = !tile.isFlagged;
    if (tile.isFlagged) {
      tile.element.classList.add('flagged');
      tile.element.textContent = '🚩'; // Flag emoji
      this.minesLeft--;
    } else {
      tile.element.classList.remove('flagged');
      tile.element.textContent = '';
      this.minesLeft++;
    }
    this.minesLeftElement.textContent = this.minesLeft;
  },

  /**
   * Recursively reveals a tile and its neighbors (if it's a '0').
   * @param {object} tile - The tile object to reveal.
   */
  revealTile: function (tile) {
    // Base case: Stop recursion if already revealed or flagged
    if (tile.isRevealed || tile.isFlagged) {
      return;
    }

    tile.isRevealed = true;
    tile.element.classList.add('revealed');

    if (tile.isMine) {
      // Game Over - Hit a mine
      tile.element.classList.add('mine');
      tile.element.textContent = '💥'; // Explosion emoji
      this.gameOver(false);
      return;
    }

    if (tile.adjacentCount > 0) {
      // It's a number tile, show the number and stop recursion
      tile.element.textContent = tile.adjacentCount;
      tile.element.classList.add(`c-${tile.adjacentCount}`); // For color styling
    } else {
      // It's a '0' tile, flood-fill (recurse)
      const neighbors = this.getNeighbors(tile.x, tile.y);
      for (const neighbor of neighbors) {
        this.revealTile(neighbor); // Recursive call
      }
    }
  },

  /**
   * Checks if the player has won the game.
   */
  checkWinCondition: function () {
    if (this.isGameOver) return;

    for (let y = 0; y < this.gridSize; y++) {
      for (let x = 0; x < this.gridSize; x++) {
        const tile = this.board[y][x];
        // If there's a non-mine tile that is NOT revealed, game is not over
        if (!tile.isMine && !tile.isRevealed) {
          return;
        }
      }
    }
    // If loop completes, all non-mines are revealed
    this.gameOver(true);
  },

  /**
   * Ends the game, showing a win/lose message.
   * @param {boolean} didWin - True if the player won.
   */
  gameOver: function (didWin) {
    this.isGameOver = true;

    // Show message
    this.messageElement.style.display = 'block';
    if (didWin) {
      this.messageElement.textContent = '你赢了！点击此处重新开始。';
      this.messageElement.className = 'game-message win';
    } else {
      this.messageElement.textContent = '游戏结束！点击此处重新开始。';
      this.messageElement.className = 'game-message lose';
      // Reveal all other mines
      this.revealAllMines();
    }
    
    // Make message clickable to restart
    this.messageElement.onclick = () => this.reset();
  },

  /**
   * Reveals all mines on the board when the player loses.
   */
  revealAllMines: function () {
    for (let y = 0; y < this.gridSize; y++) {
      for (let x = 0; x < this.gridSize; x++) {
        const tile = this.board[y][x];
        if (tile.isMine) {
          if (!tile.isRevealed) {
            tile.element.classList.add('revealed', 'mine-unhit');
            tile.element.textContent = '💣'; // Bomb emoji
          }
          if (tile.isFlagged) {
            tile.element.classList.add('mine-flagged');
          }
        }
      }
    }
  },
};
