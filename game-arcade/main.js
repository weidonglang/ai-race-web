document.addEventListener('DOMContentLoaded', () => {
  // Get all the main elements
  const lobby = document.getElementById('lobby');
  const gameContainers = document.querySelectorAll('.game-container');
  const gameButtons = document.querySelectorAll('.game-btn');
  const backButtons = document.querySelectorAll('.back-btn');

  let activeGame = null;
  let activeGameName = null;

  // Function to switch to a game
  function showGame(gameName) {
    // Hide the lobby
    lobby.style.display = 'none';

    // Hide all other game containers
    gameContainers.forEach(container => {
      container.style.display = 'none';
    });

    // Show the selected game container
    const gameId = `game-${gameName}`;
    document.getElementById(gameId).style.display = 'block';

    // Start the specific game's logic
    startGame(gameName);
  }

  // Function to return to the lobby
  function showLobby() {
    // Stop any active game
    stopGame();

    // Hide all game containers
    gameContainers.forEach(container => {
      container.style.display = 'none';
    });

    // Show the lobby
    lobby.style.display = 'block';
  }

  // Add click listeners to all game buttons
  gameButtons.forEach(button => {
    button.addEventListener('click', () => {
      const gameName = button.dataset.game;
      showGame(gameName);
    });
  });

  // Add click listeners to all "Back to Lobby" buttons
  backButtons.forEach(button => {
    button.addEventListener('click', showLobby);
  });

  // --- Game Start/Stop Logic ---

  function startGame(gameName) {
    activeGameName = gameName;
    console.log(`Starting ${gameName}...`);
    
    // We use a switch statement to find the correct game object to initialize
    switch (gameName) {
      case 'snake':
        activeGame = SnakeGame;
        break;
      case 'minesweeper':
        activeGame = MinesweeperGame;
        break;
      case 'tetris':
        activeGame = TetrisGame;
        break;
      case 'sudoku':
        activeGame = SudokuGame;
        break;
      default:
        console.error("Unknown game:", gameName);
        return;
    }
    
    // Call the init() function on the active game object
    if (activeGame && typeof activeGame.init === 'function') {
      activeGame.init();
    }
  }

  function stopGame() {
    if (activeGame && typeof activeGame.stop === 'function') {
      console.log(`Stopping ${activeGameName}...`);
      activeGame.stop();
    }
    activeGame = null;
    activeGameName = null;
  }

  // Initially, make sure the lobby is visible
  showLobby();
});