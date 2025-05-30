console.log('Starting server...');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const publicDir = __dirname + '/public';
app.use(express.static(publicDir, { index: 'root.html' }));

server.listen(3000, '0.0.0.0', () => {
  console.log('Server running on http://localhost:3000');
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unresolved Promise rejection:', reason);
});

const onlinePlayers = new Map();
const activeRooms = new Map();
const socketRoomMap = new Map();
const connectedPlayers = new Map();
const RECONNECT_TIMEOUT = 300000;
const ROOM_EXPIRATION_TIME = 10 * 60 * 1000;
const RESULT_DISPLAY_TIME = 5000;

const matchIdRoomMap = new Map();
const matchResults = new Map();

function createRoom(roomId, players) {
    const room = {
        players,
        gameStarted: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + ROOM_EXPIRATION_TIME,
        offlinePlayers: [],
        currentQuestion: 0,
        scores: players.reduce((acc, player) => ({ ...acc, [player]: 0 }), {}),
        answers: {},
        lastAnswerTime: null,
        questionLocked: false,
        roundComplete: false
    };
    activeRooms.set(roomId, room);
    setTimeout(() => {
        if (activeRooms.has(roomId) && (!room.gameStarted || room.offlinePlayers.length === room.players.length)) {
            activeRooms.delete(roomId);
        }
    }, ROOM_EXPIRATION_TIME);

    const match_id = generateMatchId();
    matchIdRoomMap.set(match_id, roomId);
    console.log(`[MATCH] Created match_id: ${match_id} for room: ${roomId}`);

    return { roomId, match_id };
}

function generateMatchId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

io.on('connection', (socket) => {
  socket.on('playerConnect', (playerData) => {
    connectedPlayers.set(socket.id, {
      ...playerData,
      socketId: socket.id
    });
    console.log(`[DATA] Received playerConnect from ${playerData.name}`);
  });

  socket.on('requestRoom', (playerData) => {
    console.log(`[DATA] Received requestRoom from ${playerData.name}`);
    const roomId = generateUniqueRoomId();
    const { roomId: createdRoomId, match_id } = createRoom(roomId, [playerData.name]);
    socket.join(createdRoomId);
    socket.emit('joinRoom', { roomId: createdRoomId, match_id });
    socketRoomMap.set(socket.id, createdRoomId);
    console.log(`[MATCH] Assigned match_id: ${match_id} to player: ${playerData.name}`);
  });

  socket.on('playerOnline', (playerData) => {
    onlinePlayers.set(socket.id, { 
      ...playerData, 
      socketId: socket.id,
      socket: socket 
    });
    console.log(`Player ${playerData.name} (Socket ID: ${socket.id}) has connected.`);
    io.emit('updatePlayerList', Array.from(onlinePlayers.values()).map(p => ({
      name: p.name,
      avatar: p.avatar,
      desc: p.desc
    })));
  });

  socket.on('disconnect', (reason) => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData) return;
    console.log(`Player ${playerData.name} (Socket ID: ${socket.id}) has gone offline. Reason: ${reason}`);
    
    const roomId = socketRoomMap.get(socket.id);
    if (roomId) {
        const room = activeRooms.get(roomId);
        if (room) {
            room.offlinePlayers = room.offlinePlayers || [];
            room.offlinePlayers.push(playerData.name);
            
            const otherPlayers = room.players.filter(p => p !== playerData.name);
            otherPlayers.forEach(otherPlayer => {
                const otherPlayerSocketId = Array.from(onlinePlayers.entries())
                   .find(([id, data]) => data.name === otherPlayer)?.[0];
                if (otherPlayerSocketId) {
                    io.to(otherPlayerSocketId).emit('opponentDisconnected', {
                        name: playerData.name,
                        reconnecting: true
                    });
                }
            });
            
            if (!room.reconnectTimeout) {
                room.reconnectTimeout = setTimeout(() => {
                    if (activeRooms.has(roomId)) {
                        activeRooms.delete(roomId);
                        room.players.forEach(player => {
                            const socketId = Array.from(onlinePlayers.entries())
                               .find(([id, data]) => data.name === player)?.[0];
                            if (socketId) {
                                io.to(socketId).emit('roomClosed', { 
                                    reason: 'reconnectTimeout',
                                    opponentLeft: playerData.name 
                                });
                                socketRoomMap.delete(socketId);
                            }
                        });
                    }
                }, 5 * 60 * 1000);
            }
        }
    }
  
    onlinePlayers.delete(socket.id);
    socketRoomMap.delete(socket.id);
  });

  socket.on('rejoinRoom', (data) => {
    const { match_id, playerName } = data;
    console.log(`[DATA] Received rejoinRoom - match_id: ${match_id}, playerName: ${playerName}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData) {
        console.log(`[ERROR] Match ${match_id} not found for rejoin`);
        socket.emit('rejoinFailed', {
            reason: 'matchNotFound',
            message: 'Match not found or has expired'
        });
        return;
    }
    
    if (!matchData.players.includes(playerName)) {
        console.log(`[ERROR] Player ${playerName} not part of match ${match_id}. Players in match:`, matchData.players);

        for (const [mid, match] of matchResults.entries()) {
            if (match.players.includes(playerName)) {
                console.log(`[INFO] Found player ${playerName} in match ${mid}`);
                socket.emit('rejoinFailed', {
                    reason: 'wrongMatch',
                    message: 'You are part of a different match',
                    correctMatchId: mid
                });
                return;
            }
        }
        socket.emit('rejoinFailed', {
            reason: 'playerNotFound',
            message: 'You are not part of this match'
        });
        return;
    }
    
    onlinePlayers.set(socket.id, {
        name: playerName,
        socketId: socket.id,
        socket: socket
    });
    
    const opponentName = matchData.players.find(p => p !== playerName);
    
    console.log(`[DEBUG] Player ${playerName} rejoined match ${match_id}. Opponent: ${opponentName}`);
    
    socket.emit('rejoinSuccess', {
        match_id,
        opponentName,
        gameStarted: true,
        currentQuestion: matchData.currentQuestion || 0,
        scores: matchData.scores,
        answers: matchData.answers[playerName] || []
    });

    const opponentSocket = Array.from(onlinePlayers.entries())
        .find(([_, data]) => data.name === opponentName)?.[1]?.socket;
    if (opponentSocket) {
        opponentSocket.emit('opponentReconnected', { name: playerName });
    }
  });

  socket.on('challenge', (targetPlayerName) => {
    console.log(`[DATA] Received challenge - challenger: ${onlinePlayers.get(socket.id)?.name}, target: ${targetPlayerName}`);
    const challenger = onlinePlayers.get(socket.id);
    const targetPlayer = Array.from(onlinePlayers.values()).find(p => p.name === targetPlayerName);
    if (targetPlayer) {
      if (io.sockets.sockets.has(targetPlayer.socketId)) {
        targetPlayer.socket.emit('challengeReceived', challenger.name);
      } else {
        socket.emit('error', 'The target player has gone offline.');
      }
    } else {
      socket.emit('error', 'The target player does not exist or is offline.');
    }
  });

  socket.on('challengeResponse', (response, challengerName) => {
    console.log(`[DATA] Received challengeResponse - response: ${response}, challenger: ${challengerName}`);
    if (response === 'accept') {
        const challenger = Array.from(onlinePlayers.values()).find((player) => player.name === challengerName);
        if (!challenger) {
            socket.emit('error', { message: 'The challenger does not exist or is offline.' });
            return;
        }
        const challengerSocket = challenger.socket;
        if (!io.sockets.sockets.has(challengerSocket.id)) {
            socket.emit('error', 'The challenger has gone offline.');
            return;
        }
        
        const responderName = onlinePlayers.get(socket.id).name;
        const match_id = generateMatchId();
        const players = [challengerName, responderName];
        
        console.log(`[MATCH] Creating new match with players:`, players);
        
        // Create match data
        matchResults.set(match_id, {
            players,
            answers: {},
            scores: players.reduce((acc, player) => ({ ...acc, [player]: 0 }), {}),
            gameComplete: false,
            createdAt: Date.now()
        });
        
        console.log(`[MATCH] New match created - match_id: ${match_id}, players: ${players.join(', ')}`);
        
        // Send match success to both players
        challengerSocket.emit('matchSuccess', { 
            match_id,
            opponent: responderName,
            isChallenger: true
        });
        socket.emit('matchSuccess', { 
            match_id,
            opponent: challengerName,
            isChallenger: false
        });
        
        // Set match expiration
        setTimeout(() => {
            const match = matchResults.get(match_id);
            if (match && !match.gameComplete) {
                console.log(`[MATCH] Match ${match_id} expired`);
                matchResults.delete(match_id);
            }
        }, 10 * 60 * 1000); // 10 minutes
    } else {
        const challengerSocketId = Array.from(onlinePlayers.entries())
            .find(([id, data]) => data.name === challengerName)?.[0];
        if (challengerSocketId) {
            io.to(challengerSocketId).emit('challengeRejected', onlinePlayers.get(socket.id).name);
        }
    }
  });

  socket.on('submitAnswer', (data) => {
    const { match_id, questionIndex, answer, playerName, time } = data;
    console.log(`[DATA] Received submitAnswer - match_id: ${match_id}, player: ${playerName}, question: ${questionIndex}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData) {
        console.log(`[ERROR] Match ${match_id} not found for answer submission`);
        socket.emit('error', 'Match not found or has expired');
        return;
    }
    
    if (!matchData.players.includes(playerName)) {
        console.log(`[ERROR] Player ${playerName} not part of match ${match_id}`);
        socket.emit('error', 'You are not part of this match');
        return;
    }
    
    // init
    if (!matchData.answers[playerName]) {
        matchData.answers[playerName] = [];
    }
    
    // record answers
    const question = questions[questionIndex];
    const isCorrect = answer === question.answer;
    
    // check
    const existingAnswer = matchData.answers[playerName].find(a => a.questionIndex === questionIndex);
    if (existingAnswer) {
        console.log(`[WARN] Player ${playerName} already submitted answer for question ${questionIndex}`);
        return;
    }
    
    matchData.answers[playerName].push({
        questionIndex,
        answer,
        time,
        isCorrect
    });
    
    matchData.currentQuestion = Math.max(matchData.currentQuestion || 0, questionIndex);
    matchData.lastAnswerTime = Date.now();
    
    // check
    const allPlayersAnswered = matchData.players.every(player => {
        const playerAnswers = matchData.answers[player] || [];
        return playerAnswers.some(a => a.questionIndex === questionIndex);
    });
    
    if (allPlayersAnswered) {
        updateMatchScores(matchData);
        
        matchData.players.forEach(player => {
            const playerSocket = Array.from(onlinePlayers.entries())
                .find(([_, data]) => data.name === player)?.[1]?.socket;
            if (playerSocket) {
                playerSocket.emit('answerResult', {
                    questionIndex,
                    isCorrect: matchData.answers[player].find(a => a.questionIndex === questionIndex).isCorrect,
                    scores: matchData.scores
                });
            }
        });
        
        // waiting
        if (questionIndex === questions.length - 1) {
            matchData.gameComplete = true;
            matchData.resultsSubmitted = new Set();
        }
    } else {
        socket.emit('answerConfirmed', {
            questionIndex,
            isCorrect
        });
    }
  });

  socket.on('submitGameResult', (data) => {
    const { match_id, playerName, answers, finalScore } = data;
    console.log(`[GAME] Received game result - match_id: ${match_id}, player: ${playerName}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData) {
        console.log(`[ERROR] Match ${match_id} not found or expired`);
        socket.emit('gameResult', {
            scores: { [playerName]: finalScore },
            winner: null,
            error: 'Match not found or expired'
        });
        return;
    }
    
    // check
    if (!matchData.players.includes(playerName)) {
        console.log(`[ERROR] Player ${playerName} not part of match ${match_id}`);
        socket.emit('gameResult', {
            scores: { [playerName]: finalScore },
            winner: null,
            error: 'Player not part of match'
        });
        return;
    }
    
    // recoed result
    matchData.resultsSubmitted = matchData.resultsSubmitted || new Set();
    matchData.resultsSubmitted.add(playerName);
    
    console.log(`[DEBUG] Current match data:`, {
        players: matchData.players,
        scores: matchData.scores,
        resultsSubmitted: Array.from(matchData.resultsSubmitted)
    });
    
    // calculate results
    const results = calculateMatchResults(matchData);
    socket.emit('gameResult', results);
    
    // clear
    if (matchData.resultsSubmitted.size === matchData.players.length) {
        console.log(`[GAME] All players submitted results, cleaning up match ${match_id}`);
        setTimeout(() => {
            matchResults.delete(match_id);
        }, 10000);
    }
  });

  function calculateMatchResults(matchData) {
    const { players, scores, answers } = matchData;
    
    // Validate scores
    const validScores = {};
    players.forEach(player => {
        if (typeof scores[player] === 'number') {
            validScores[player] = scores[player];
        } else {
            validScores[player] = 0;
        }
    });
    
    // Determine winner
    let winner = null;
    if (Object.keys(validScores).length === 2) {
        const [player1, player2] = players;
        const score1 = validScores[player1] || 0;
        const score2 = validScores[player2] || 0;
        
        if (score1 > score2) {
            winner = player1;
        } else if (score2 > score1) {
            winner = player2;
        } else {
            winner = 'tie';
        }
    }
    
    return {
        scores: validScores,
        winner,
        allAnswers: answers,
        complete: Object.keys(answers).length === players.length
    };
  }

  function updateMatchScores(matchData) {
    const { players, answers } = matchData;
    const scores = {};
    
    // Initialize scores
    players.forEach(player => {
        scores[player] = 0;
    });
    
    // Calculate scores for each question
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
        const questionAnswers = players
            .map(player => {
                const playerAnswers = answers[player] || [];
                return {
                    player,
                    answer: playerAnswers.find(a => a.questionIndex === questionIndex)
                };
            })
            .filter(item => item.answer);
        
        if (questionAnswers.length === 2) {
            const [answer1, answer2] = questionAnswers;
            
            if (answer1.answer.isCorrect) {
                scores[answer1.player] += 2;
                scores[answer2.player] += 0;
            } else if (answer2.answer.isCorrect) {
                scores[answer2.player] += 2;
                scores[answer1.player] += 0;
            } else {
                scores[answer1.player] += 0;
                scores[answer2.player] += 0;
            }
        }
    }
    
    matchData.scores = scores;
  }

  socket.on('readyToStart', (data) => {
    const { match_id } = data;
    console.log(`[GAME] Received readyToStart - match_id: ${match_id}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData) {
      socket.emit('error', 'Match not found or has expired');
      return;
    }
    
    // record ready
    matchData.readyPlayers = matchData.readyPlayers || new Set();
    matchData.readyPlayers.add(socket.id);
    
    console.log(`[GAME] Player ready count: ${matchData.readyPlayers.size}/${matchData.players.length}`);
    
    // timer
    if (matchData.readyPlayers.size === matchData.players.length) {
      console.log(`[GAME] All players ready, starting countdown for match ${match_id}`);
      
      matchData.players.forEach(playerName => {
        const playerSocket = Array.from(onlinePlayers.entries())
          .find(([_, data]) => data.name === playerName)?.[1]?.socket;
        if (playerSocket) {
          playerSocket.emit('startCountdown');
        }
      });
      
      setTimeout(() => {
        console.log(`[GAME] Countdown complete, confirming game start for match ${match_id}`);
        matchData.players.forEach(playerName => {
          const playerSocket = Array.from(onlinePlayers.entries())
            .find(([_, data]) => data.name === playerName)?.[1]?.socket;
          if (playerSocket) {
            playerSocket.emit('startConfirmed');
          }
        });
        
        matchData.gameStarted = true;
        matchResults.set(match_id, matchData);

        setTimeout(() => {
          console.log(`[GAME] Sending first question for match ${match_id}`);
          matchData.players.forEach(playerName => {
            const playerSocket = Array.from(onlinePlayers.entries())
              .find(([_, data]) => data.name === playerName)?.[1]?.socket;
            if (playerSocket) {
              playerSocket.emit('loadQuestion', {
                questionIndex: 0,
                question: questions[0]
              });
            }
          });
        }, 1000);
      }, 6000); 
    }
  });

  socket.on('requestQuestion', (data) => {
    const { match_id, questionIndex } = data;
    console.log(`[GAME] Question requested - match_id: ${match_id}, index: ${questionIndex}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData || !matchData.gameStarted) {
      socket.emit('error', 'Match not found or game not started');
      return;
    }

    if (questionIndex >= 0 && questionIndex < questions.length) {
      socket.emit('loadQuestion', {
        questionIndex,
        question: questions[questionIndex]
      });
    }
  });

  socket.on('leaveGame', (data) => {
    const { match_id, playerName } = data;
    console.log(`[GAME] Player ${playerName} leaving match ${match_id}`);
    
    const matchData = matchResults.get(match_id);
    if (!matchData) {
      console.log(`[ERROR] Match ${match_id} not found for player leaving`);
      return;
    }
    
    // gain info
    const opponentName = matchData.players.find(p => p !== playerName);
    if (opponentName) {
      // opp socket
      const opponentSocket = Array.from(onlinePlayers.entries())
        .find(([_, data]) => data.name === opponentName)?.[1]?.socket;
      
      if (opponentSocket) {
        console.log(`[GAME] Notifying opponent ${opponentName} about player ${playerName} leaving`);
        opponentSocket.emit('opponentLeft', {
          playerName,
          reason: 'left_game'
        });
      }
    }
    
    // mark match complete
    matchData.gameComplete = true;
    matchData.endReason = 'player_left';
    matchResults.set(match_id, matchData);
    
    if (socket.id) {
      onlinePlayers.delete(socket.id);
    }
    
    setTimeout(() => {
      if (matchResults.has(match_id)) {
        console.log(`[GAME] Cleaning up match ${match_id} after player left`);
        matchResults.delete(match_id);
      }
    }, 10000);
  });

  socket.on('disconnect', (reason) => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData) return;
    
    console.log(`[DISCONNECT] Player ${playerData.name} disconnected. Reason: ${reason}`);
    
    // find match and notify opponent
    for (const [mid, match] of matchResults.entries()) {
      if (match.players.includes(playerData.name)) {
        const opponentName = match.players.find(p => p !== playerData.name);
        if (opponentName) {
          const opponentSocket = Array.from(onlinePlayers.entries())
            .find(([_, data]) => data.name === opponentName)?.[1]?.socket;
          
          if (opponentSocket) {
            console.log(`[GAME] Notifying opponent ${opponentName} about disconnect`);
            opponentSocket.emit('opponentLeft', {
              playerName: playerData.name,
              reason: 'disconnected'
            });
          }
        }
        
        // mark end
        match.gameComplete = true;
        match.endReason = 'player_disconnected';
        matchResults.set(mid, match);
        
        setTimeout(() => {
          if (matchResults.has(mid)) {
            console.log(`[GAME] Cleaning up match ${mid} after disconnect`);
            matchResults.delete(mid);
          }
        }, 10000);
      }
    }
    
    onlinePlayers.delete(socket.id);
  });
});

function generateUniqueRoomId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function startGame(roomId) {
  const room = activeRooms.get(roomId);
  if (!room) return;
  
  // timer
  const countdownSeconds = 5;
  let countdown = countdownSeconds;
  
  const countdownInterval = setInterval(() => {
    countdown--;
    
    room.players.forEach(playerName => {
      const socketId = Array.from(onlinePlayers.entries())
        .find(([id, data]) => data.name === playerName)?.[0];
      if (socketId) {
        io.to(socketId).emit('gameCountdown', {
          seconds: countdown
        });
      }
    });
    
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      
      room.gameStarted = true;
      activeRooms.set(roomId, room);
      setRoomExpirationCheck(roomId, room);
      
      // game start
      room.players.forEach(playerName => {
        const socketId = Array.from(onlinePlayers.entries())
          .find(([id, data]) => data.name === playerName)?.[0];
        if (socketId) {
          const opponentName = room.players.find(p => p !== playerName);
          io.to(socketId).emit('gameStart', {
            roomId,
            opponentName,
            gameStarted: true,
            currentQuestion: room.currentQuestion,
            scores: room.scores
          });
        }
      });
      
      // start question
      setTimeout(() => {
        room.players.forEach(playerName => {
          const socketId = Array.from(onlinePlayers.entries())
            .find(([id, data]) => data.name === playerName)?.[0];
          if (socketId) {
            io.to(socketId).emit('nextQuestion', {
              questionIndex: 0
            });
          }
        });
      }, 1000);
    }
  }, 1000);
}

function setRoomExpirationCheck(roomId, room) {
  setTimeout(() => {
    if (activeRooms.has(roomId)) {
      activeRooms.delete(roomId);
    }
  }, 10 * 60 * 1000);
}

function calculateScores(room) {
  const { players, answers } = room;
  const [player1, player2] = players;
  
  console.log('[Server] Calculating final scores for players:', players);
  console.log('[Server] Answers:', answers);
  
  players.forEach(player => {
    if (!answers[player]) answers[player] = [];
    for (let i = 0; i < 5; i++) {
      if (!answers[player].some(a => a.questionIndex === i)) {
        answers[player].push({
          questionIndex: i,
          answer: null,
          time: Infinity,
          isCorrect: false
        });
      }
    }
  });
  
  room.scores = players.reduce((acc, player) => ({ ...acc, [player]: 0 }), {});
  
  for (let i = 0; i < 5; i++) {
    const question = questions[i];
    const player1Answer = answers[player1].find(a => a.questionIndex === i);
    const player2Answer = answers[player2].find(a => a.questionIndex === i);
    
    console.log(`[Server] Question ${i+1}:`, question.text);
    console.log(`${player1}'s answer:`, player1Answer);
    console.log(`${player2}'s answer:`, player2Answer);
    
    if (player1Answer && player2Answer) {
      const isAnswer1Correct = player1Answer.isCorrect;
      const isAnswer2Correct = player2Answer.isCorrect;
      
      if (player1Answer.time < player2Answer.time) {
        if (isAnswer1Correct) {
          room.scores[player1] += 2;
          console.log(`${player1} gets 2 points for question ${i+1}`);
        } else if (isAnswer2Correct) {
          room.scores[player2] += 1;
          console.log(`${player2} gets 1 point for question ${i+1}`);
        }
      } else {
        if (isAnswer2Correct) {
          room.scores[player2] += 2;
          console.log(`${player2} gets 2 points for question ${i+1}`);
        } else if (isAnswer1Correct) {
          room.scores[player1] += 1;
          console.log(`${player1} gets 1 point for question ${i+1}`);
        }
      }
    }
  }
  
  console.log('[Server] Final scores calculated:', room.scores);
  return room.scores;
}

const questions = [
  {
    text: 'What is the capital of France?',
    options: ['London', 'Paris', 'Berlin'],
    answer: 'Paris',
    image: 'img/questionImage/1.jpg'
  },
  {
    text: 'Which planet is known as the Red Planet?',
    options: ['Venus', 'Mars', 'Jupiter'],
    answer: 'Mars',
    image: 'img/questionImage/2.jpg'
  },
  {
    text: 'What is the largest ocean on Earth?',
    options: ['Atlantic Ocean', 'Pacific Ocean', 'Indian Ocean'],
    answer: 'Pacific Ocean',
    image: 'img/questionImage/3.jpg'
  },
  {
    text: 'Among A, B, and C, one is a pastor, one is a liar, and one is a gambler. The pastor never lies, the liar always lies, and the gambler sometimes tells the truth and sometimes lies.\nA says: "I am not a pastor."\nB says: "I am not a liar."\nC says: "I am not a gambler."\nQuestion: Who is the gambler?',
    options: ['A', 'B', 'C'],
    answer: 'A',
    image: 'img/questionImage/4.jpg'
  },
  {
    text: 'How many triangles are there in the picture?',
    options: ['16', '17', '18'],
    answer: '17',
    image: 'img/questionImage/5.jpg'
  }
];

app.get('/roomId', (req, res) => {
  const socketId = req.socket.id;
  const roomId = getRoomIdBySocketId(socketId);
  if (roomId) {
    res.json({ roomId });
  } else {
    res.status(404).json({ error: 'Room ID not found' });
  }
});

function getRoomIdBySocketId(socketId) {
  return socketRoomMap.get(socketId);
}

app.get('/questions/:index', (req, res) => {
  const index = parseInt(req.params.index);
  if (index >= 0 && index < questions.length) {
    const question = { ...questions[index], correctAnswer: questions[index].answer };
    res.json(question);
  } else {
    res.status(404).json({ error: 'Question not found' });
  }
});