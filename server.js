// server.js - Updated Node.js backend for Shithead card game with Joker and 3 card rules
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public directory
app.use(express.static('public'));

// Game rooms storage
const rooms = new Map();

// Card game utilities
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    const deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({
                suit: suit,
                rank: rank,
                value: getRankValue(rank),
                color: (suit === '♥' || suit === '♦') ? 'red' : 'black'
            });
        }
    }
    
    // Add 2 jokers
    deck.push({
        suit: '🃏',
        rank: 'JOKER',
        value: 15, // Higher than Ace
        color: 'black'
    });
    deck.push({
        suit: '🃏',
        rank: 'JOKER',
        value: 15,
        color: 'red'
    });
    
    return shuffleDeck(deck);
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getRankValue(rank) {
    const values = {
        '2': 2, '3': 0, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, 
        '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'JOKER': 15
    };
    return values[rank];
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function canPlayCards(cards, topCard) {
    if (cards.length === 0) return false;
    if (!topCard) return true; // Can play any card on empty pile
    
    const firstCard = cards[0];
    
    // Special cards that can be played on anything
    if (firstCard.rank === '2' || firstCard.rank === '10' || firstCard.rank === '3' || firstCard.rank === 'JOKER') {
        return true;
    }
    
    // 7 rule: next card must be 7 or lower (unless it's a special card)
    if (topCard.rank === '7' && firstCard.value > 7) {
        return false;
    }
    
    // Normal rule: must be equal or higher
    return firstCard.value >= topCard.value;
}

function createRoom() {
    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        players: new Map(),
        gameState: {
            started: false,
            setupPhase: false,
            currentPlayer: 0,
            deck: [],
            discardPile: [],
            playerOrder: [],
            gameLog: [],
            direction: 1, // 1 for clockwise, -1 for counter-clockwise
            invisibleCard: null // Tracks the invisible 3 card effect
        },
        host: null
    };
    rooms.set(roomCode, room);
    return room;
}

function addPlayerToRoom(socket, roomCode, playerName) {
    const room = rooms.get(roomCode);
    if (!room) return null;
    
    const player = {
        id: socket.id,
        name: playerName,
        hand: [],
        faceUpCards: [],
        faceDownCards: [],
        setupComplete: false
    };
    
    room.players.set(socket.id, player);
    
    if (!room.host) {
        room.host = socket.id;
    }
    
    socket.join(roomCode);
    return room;
}

function removePlayerFromRoom(socket, roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.players.delete(socket.id);
    room.gameState.playerOrder = room.gameState.playerOrder.filter(id => id !== socket.id);
    
    // If host left, assign new host
    if (room.host === socket.id && room.players.size > 0) {
        room.host = room.players.keys().next().value;
    }
    
    // Delete room if empty
    if (room.players.size === 0) {
        rooms.delete(roomCode);
    }
    
    socket.leave(roomCode);
}

function startGame(room) {
    if (room.players.size < 2) return false;
    
    room.gameState.started = true;
    room.gameState.setupPhase = true;
    room.gameState.deck = createDeck();
    room.gameState.discardPile = [];
    room.gameState.playerOrder = Array.from(room.players.keys());
    room.gameState.currentPlayer = 0;
    room.gameState.direction = 1;
    room.gameState.invisibleCard = null;
    
    // Deal cards to all players
    room.players.forEach(player => {
        player.hand = [];
        player.faceUpCards = [];
        player.faceDownCards = [];
        player.setupComplete = false;
        
        // Deal 3 face-down cards
        for (let i = 0; i < 3; i++) {
            player.faceDownCards.push(room.gameState.deck.pop());
        }
        
        // Deal 6 cards to hand for setup
        for (let i = 0; i < 6; i++) {
            player.hand.push(room.gameState.deck.pop());
        }
    });
    
    room.gameState.gameLog.push('Game started! Players setting up face-up cards...');
    return true;
}

function nextTurn(room) {
    const playerCount = room.gameState.playerOrder.length;
    room.gameState.currentPlayer = (room.gameState.currentPlayer + room.gameState.direction + playerCount) % playerCount;
}

function processCardPlay(room, playerId, cardIndices) {
    const player = room.players.get(playerId);
    if (!player) return false;
    
    // Validate it's player's turn
    const currentPlayerId = room.gameState.playerOrder[room.gameState.currentPlayer];
    if (currentPlayerId !== playerId) return false;
    
    const cardsToPlay = cardIndices.map(cardData => {
        if (cardData.type === 'hand') {
            return player.hand[cardData.index];
        } else if (cardData.type === 'faceUp') {
            return player.faceUpCards[cardData.index];
        } else if (cardData.type === 'faceDown') {
            return player.faceDownCards[cardData.index];
        }
    }).filter(card => card); // Remove undefined cards
    
    if (cardsToPlay.length === 0) return false;
    
    const topCard = room.gameState.discardPile[room.gameState.discardPile.length - 1];
    
    // For face-down cards, allow playing but check after
    const isFaceDown = cardIndices.some(cardData => cardData.type === 'faceDown');
    
    if (!isFaceDown && !canPlayCards(cardsToPlay, topCard)) {
        return false;
    }
    
    // Remove cards from player's hand/piles
    cardIndices
        .sort((a, b) => b.index - a.index) // Sort in reverse order to avoid index shifting
        .forEach(cardData => {
            let card;
            if (cardData.type === 'hand') {
                card = player.hand.splice(cardData.index, 1)[0];
            } else if (cardData.type === 'faceUp') {
                card = player.faceUpCards.splice(cardData.index, 1)[0];
            } else if (cardData.type === 'faceDown') {
                card = player.faceDownCards.splice(cardData.index, 1)[0];
            }
            
            if (card) {
                if (card.rank === '3') {
                    // 3 is invisible - store it but don't add to discard pile visually
                    room.gameState.invisibleCard = card;
                    room.gameState.gameLog.push(`${player.name} played an invisible 3`);
                } else {
                    room.gameState.discardPile.push(card);
                }
            }
        });
    
    // Check if face-down card can actually be played
    if (isFaceDown) {
        const lastPlayedCard = cardsToPlay[cardsToPlay.length - 1];
        if (lastPlayedCard.rank !== '3' && !canPlayCards([lastPlayedCard], topCard)) {
            // Can't play face-down card, pick up pile
            player.hand.push(lastPlayedCard);
            player.hand.push(...room.gameState.discardPile);
            room.gameState.discardPile = [];
            room.gameState.invisibleCard = null;
            room.gameState.gameLog.push(`${player.name} played ${lastPlayedCard.rank}${lastPlayedCard.suit} face-down but had to pick up the pile`);
            nextTurn(room);
            return true;
        }
    }
    
    // Handle special cards
    const lastCard = cardsToPlay[cardsToPlay.length - 1];
    let skipNextTurn = false;
    
    if (lastCard.rank === '10') {
        room.gameState.discardPile = [];
        room.gameState.invisibleCard = null;
        room.gameState.gameLog.push(`${player.name} burned the pile with a 10!`);
        // Player gets another turn after burning
        skipNextTurn = true;
    } else if (lastCard.rank === '2') {
        room.gameState.gameLog.push(`${player.name} reset the pile with a 2!`);
    } else if (lastCard.rank === 'JOKER') {
        room.gameState.direction *= -1; // Flip direction
        const directionText = room.gameState.direction === 1 ? 'clockwise' : 'counter-clockwise';
        room.gameState.gameLog.push(`${player.name} played a Joker! Direction is now ${directionText}`);
    } else if (lastCard.rank === '3') {
        // 3 is invisible, effect handled above
        // The invisible card will affect the next player
    }
    
    // Apply invisible card effect to next player
    if (room.gameState.invisibleCard && !skipNextTurn) {
        const nextPlayerIndex = (room.gameState.currentPlayer + room.gameState.direction + room.gameState.playerOrder.length) % room.gameState.playerOrder.length;
        const nextPlayerId = room.gameState.playerOrder[nextPlayerIndex];
        const nextPlayer = room.players.get(nextPlayerId);
        
        if (nextPlayer) {
            // The invisible 3 acts on the next player - they must play as if the 3 was the top card
            room.gameState.gameLog.push(`${nextPlayer.name} must play as if there's a 3 on the pile (invisible card effect)`);
        }
    }
    
    // Refill hand from deck if needed and available
    while (player.hand.length < 3 && room.gameState.deck.length > 0) {
        player.hand.push(room.gameState.deck.pop());
    }
    
    const cardNames = cardsToPlay.filter(c => c.rank !== '3').map(c => c.rank + c.suit).join(', ');
    if (cardNames) {
        room.gameState.gameLog.push(`${player.name} played ${cardNames}`);
    }
    
    // Check win condition
    const totalCards = player.hand.length + player.faceUpCards.length + player.faceDownCards.length;
    if (totalCards === 0) {
        room.gameState.gameLog.push(`${player.name} wins!`);
        room.gameState.started = false;
        return true;
    }
    
    if (!skipNextTurn) {
        nextTurn(room);
    }
    return true;
}

function pickUpPile(room, playerId) {
    const player = room.players.get(playerId);
    if (!player) return false;
    
    const currentPlayerId = room.gameState.playerOrder[room.gameState.currentPlayer];
    if (currentPlayerId !== playerId) return false;
    
    // Add invisible card to hand if it exists
    if (room.gameState.invisibleCard) {
        player.hand.push(room.gameState.invisibleCard);
        room.gameState.invisibleCard = null;
    }
    
    player.hand.push(...room.gameState.discardPile);
    room.gameState.discardPile = [];
    room.gameState.gameLog.push(`${player.name} picked up the pile`);
    
    nextTurn(room);
    return true;
}

function completeSetup(room, playerId, selectedCards) {
    const player = room.players.get(playerId);
    if (!player || player.setupComplete) return false;
    
    if (selectedCards.length !== 3) return false;
    
    // Move selected cards to face-up cards
    selectedCards
        .sort((a, b) => b.index - a.index)
        .forEach(selected => {
            const card = player.hand.splice(selected.index, 1)[0];
            player.faceUpCards.push(card);
        });
    
    player.setupComplete = true;
    
    // Check if all players completed setup
    const allComplete = Array.from(room.players.values()).every(p => p.setupComplete);
    if (allComplete) {
        // Fill hands back to 3 cards
        room.players.forEach(player => {
            while (player.hand.length < 3 && room.gameState.deck.length > 0) {
                player.hand.push(room.gameState.deck.pop());
            }
        });
        
        room.gameState.setupPhase = false;
        room.gameState.gameLog.push('Setup complete! Game begins!');
        room.gameState.gameLog.push('Special rules: Jokers flip direction, 3s are invisible and affect the next player');
    }
    
    return true;
}

// Enhanced card validation for client
function getEffectiveTopCard(room) {
    // If there's an invisible 3 affecting the current player, return a 3
    if (room.gameState.invisibleCard) {
        return { rank: '3', value: 0 };
    }
    
    // Otherwise return the actual top card
    if (room.gameState.discardPile.length > 0) {
        return room.gameState.discardPile[room.gameState.discardPile.length - 1];
    }
    
    return null;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    socket.on('createRoom', (playerName) => {
        const room = createRoom();
        addPlayerToRoom(socket, room.code, playerName);
        
        socket.emit('roomCreated', {
            roomCode: room.code,
            isHost: true
        });
        
        io.to(room.code).emit('gameStateUpdate', {
            players: Array.from(room.players.values()),
            gameState: room.gameState,
            isHost: socket.id === room.host,
            effectiveTopCard: getEffectiveTopCard(room)
        });
    });
    
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = addPlayerToRoom(socket, roomCode, playerName);
        
        if (room) {
            socket.emit('roomJoined', {
                roomCode: roomCode,
                isHost: socket.id === room.host
            });
            
            io.to(roomCode).emit('gameStateUpdate', {
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                isHost: socket.id === room.host,
                effectiveTopCard: getEffectiveTopCard(room)
            });
        } else {
            socket.emit('error', 'Room not found');
        }
    });
    
    socket.on('startGame', (roomCode) => {
        const room = rooms.get(roomCode);
        if (room && room.host === socket.id) {
            if (startGame(room)) {
                io.to(roomCode).emit('gameStateUpdate', {
                    players: Array.from(room.players.values()),
                    gameState: room.gameState,
                    isHost: socket.id === room.host,
                    effectiveTopCard: getEffectiveTopCard(room)
                });
            }
        }
    });
    
    socket.on('completeSetup', (data) => {
        const { roomCode, selectedCards } = data;
        const room = rooms.get(roomCode);
        
        if (room && completeSetup(room, socket.id, selectedCards)) {
            io.to(roomCode).emit('gameStateUpdate', {
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                isHost: socket.id === room.host,
                effectiveTopCard: getEffectiveTopCard(room)
            });
        }
    });
    
    socket.on('playCards', (data) => {
        const { roomCode, cardIndices } = data;
        const room = rooms.get(roomCode);
        
        if (room && processCardPlay(room, socket.id, cardIndices)) {
            io.to(roomCode).emit('gameStateUpdate', {
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                isHost: socket.id === room.host,
                effectiveTopCard: getEffectiveTopCard(room)
            });
        } else {
            socket.emit('error', 'Invalid card play');
        }
    });
    
    socket.on('pickUpPile', (roomCode) => {
        const room = rooms.get(roomCode);
        
        if (room && pickUpPile(room, socket.id)) {
            io.to(roomCode).emit('gameStateUpdate', {
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                isHost: socket.id === room.host,
                effectiveTopCard: getEffectiveTopCard(room)
            });
        }
    });
    
    socket.on('leaveRoom', (roomCode) => {
        removePlayerFromRoom(socket, roomCode);
        
        const room = rooms.get(roomCode);
        if (room) {
            io.to(roomCode).emit('gameStateUpdate', {
                players: Array.from(room.players.values()),
                gameState: room.gameState,
                isHost: socket.id === room.host,
                effectiveTopCard: getEffectiveTopCard(room)
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        // Remove player from all rooms they might be in
        rooms.forEach((room, roomCode) => {
            if (room.players.has(socket.id)) {
                removePlayerFromRoom(socket, roomCode);
                
                if (room.players.size > 0) {
                    io.to(roomCode).emit('gameStateUpdate', {
                        players: Array.from(room.players.values()),
                        gameState: room.gameState,
                        isHost: false,
                        effectiveTopCard: getEffectiveTopCard(room)
                    });
                }
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Shithead server running on port ${PORT}`);
});