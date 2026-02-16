# 🎭 Mafia Game

A real-time multiplayer implementation of the classic Mafia party game built with Node.js, Express, and Socket.IO.

## Features

- **Real-time Multiplayer**: Play with friends on the same network
- **Role-Based Gameplay**: Doctor, Detective, Mafia, and Villagers
- **Host (God) Controls**: One player acts as the game moderator
- **Night & Day Phases**: Strategic elimination and voting rounds
- **Voting System**: Tentative voting, final voting, and tie revotes
- **Player Reconnection**: Rejoin the game if disconnected
- **Host Transfer**: Transfer host control to another player
- **Game History**: Track all game events chronologically
- **Draw Detection**: Automatic draw when 1v1 (Mafia vs Villager)

## Game Rules

- **Host (God)**: Controls the game, doesn't play
- **Doctor** (1 player): Saves one person each night (cannot save same person twice)
- **Detective** (1 player): Investigates one person each night
- **Mafia** (20% of players): Try to eliminate villagers
- **Villager** (remaining players): Find the mafia through voting!

**Minimum**: 5 people total (1 host + 4 players)

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd mafia-game
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

4. Open your browser and navigate to:
- Local: `http://localhost:3000`
- Network: `http://<your-local-ip>:3000`

The server will display the network URL when it starts. Share this URL with friends on the same network to play together!

## How to Play

1. **Join**: All players enter their names to join the lobby
2. **Start**: Host starts the game when everyone is ready (min 5 people)
3. **Roles**: Each player receives a secret role
4. **Night Phase**:
   - Host wakes Mafia to select a target
   - Host wakes Doctor to save someone
   - Host wakes Detective to investigate someone
5. **Day Phase**:
   - Players discuss and vote to eliminate suspects
   - Majority vote eliminates a player
6. **Win Conditions**:
   - Villagers win if all Mafia are eliminated
   - Mafia wins if they equal or outnumber Villagers
   - Draw if 1 Mafia vs 1 Villager (no majority possible)

## Technology Stack

- **Backend**: Node.js, Express
- **Real-time Communication**: Socket.IO
- **Frontend**: Vanilla JavaScript, HTML5, CSS3

## Version

**v1.0.0** - Initial Release

## License

MIT License - Feel free to use and modify for your own games!

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.
