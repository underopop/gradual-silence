const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const PORT = 3000;

const rooms = {};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/room/:roomId', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    console.log('★ 新しいプレイヤーが画面を開きました！');

    socket.on('create-room', (config) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = { config: config, players: [], gameStarted: false, gameData: null };
        socket.emit('room-created', roomId);
    });

    socket.on('join-room', (data) => {
        const { roomId, playerName, playerIcon } = data;
        const room = rooms[roomId];
        if (!room) { socket.emit('error-msg', 'その部屋は存在しません。'); return; }
        
        // ① 人数制限チェック
        if (room.players.length >= Number(room.config.players)) { 
            socket.emit('error-msg', 'この部屋は満員です。'); return; 
        }
        if (room.gameStarted) { socket.emit('error-msg', 'このゲームは既に開始されています。'); return; }

        const isHost = room.players.length === 0;
        const newPlayer = { id: socket.id, name: playerName, icon: playerIcon, isHost: isHost, role: null, isAlive: true };
        room.players.push(newPlayer);
        socket.join(roomId);
        io.to(roomId).emit('room-info', { config: room.config, players: room.players });
    });

    // ② 退出処理
    socket.on('leave-room', (roomId) => {
        handleLeaveRoom(socket, roomId);
    });

    // ③ ホストによる追い出し処理
    socket.on('kick-player', (data) => {
        const { roomId, targetSocketId } = data;
        const room = rooms[roomId];
        if (!room) return;
        const host = room.players.find(p => p.id === socket.id);
        if (!host || !host.isHost) return;

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('kicked', 'ホストに追い出されました。');
            handleLeaveRoom(targetSocket, roomId);
        }
    });

    socket.on('start-game', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        room.gameStarted = true;
        room.gameData = { phase: 'roulette', confirmedPlayers: [], day: 1, currentRound: 1, turnIndex: 0, logs: [], votes: {}, nightTargetId: null, nightSeerTargetId: null, nightKnightTargetId: null, nightRooms: {}, roomLogs: {}, lastExecuted: null, confirmedDaybreakUsers: [], nightTimer: null };

        let rolesArray = [];
        for (let i = 0; i < room.config.werewolf; i++) { rolesArray.push('人狼'); }
        for (let i = 0; i < room.config.seer; i++) { rolesArray.push('占い師'); }
        for (let i = 0; i < room.config.doctor; i++) { rolesArray.push('医師'); }
        for (let i = 0; i < room.config.knight; i++) { rolesArray.push('騎士'); } 
        for (let i = 0; i < room.config.madman; i++) { rolesArray.push('狂人'); }
        for (let i = 0; i < room.config.alien; i++) { rolesArray.push('宇宙人'); }
        const extraCount = room.config.players - rolesArray.length;
        for (let i = 0; i < extraCount; i++) { rolesArray.push('村人'); }

        for (let i = rolesArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rolesArray[i], rolesArray[j]] = [rolesArray[j], rolesArray[i]];
        }
        room.players.forEach((player, index) => { player.role = rolesArray[index]; });
        room.players.forEach((player) => {
            let teammates = [];
            if (player.role === '人狼') { teammates = room.players.filter(p => p.role === '人狼' && p.id !== player.id).map(p => p.name); }
            io.to(player.id).emit('your-role', { role: player.role, teammates: teammates });
        });
    });

    socket.on('confirm-role', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        if (!room.gameData.confirmedPlayers.includes(socket.id)) { room.gameData.confirmedPlayers.push(socket.id); }
        if (room.gameData.confirmedPlayers.length === Number(room.config.players)) { room.gameData.phase = 'day'; sendNextTurn(roomId); }
    });

    socket.on('submit-action', (data) => {
        const { roomId, message } = data;
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        const player = room.players.find(p => p.id === socket.id);
        room.gameData.logs.push(`👤 ${player.name}: ${message}`);
        room.gameData.turnIndex++;
        sendNextTurn(roomId);
    });

    socket.on('submit-vote', (data) => {
        const { roomId, targetId } = data;
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        if (room.gameData.votes[socket.id]) return;
        room.gameData.votes[socket.id] = targetId;
        const voteCount = Object.keys(room.gameData.votes).length;
        const aliveCount = room.players.filter(p => p.isAlive).length;
        if (voteCount === aliveCount) {
            const tally = {}; room.players.forEach(p => tally[p.id] = 0);
            Object.values(room.gameData.votes).forEach(tId => { tally[tId]++; });
            let maxVotes = -1; let executedId = null;
            room.players.forEach(p => { if (p.isAlive && tally[p.id] > maxVotes) { maxVotes = tally[p.id]; executedId = p.id; } });
            const executedPlayer = room.players.find(p => p.id === executedId);
            executedPlayer.isAlive = false; 
            room.gameData.lastExecuted = { name: executedPlayer.name, role: executedPlayer.role, day: room.gameData.day };
            const winner = checkVictory(room);
            if (winner) { io.to(roomId).emit('game-event', { type: 'game-over', winner: winner, executedName: executedPlayer.name, executedRole: executedPlayer.role, players: room.players }); }
            else { io.to(roomId).emit('game-event', { type: 'vote-result', executedName: executedPlayer.name, executedRole: '???' }); }
        }
    });

    socket.on('to-night-phase', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        room.gameData.phase = 'night-part1'; room.gameData.nightRooms = {}; room.gameData.roomLogs = {}; room.gameData.nightTargetId = null; room.gameData.nightSeerTargetId = null; room.gameData.nightKnightTargetId = null;
        room.players.forEach(p => { room.gameData.roomLogs[p.id] = []; });
        io.to(roomId).emit('game-event', { type: 'go-to-night-part1', players: room.players, nightTime: room.config.nightTime });
        if (room.gameData.nightTimer) { clearInterval(room.gameData.nightTimer); }
        let timeLeft = Number(room.config.nightTime);
        io.to(roomId).emit('night-timer-tick', timeLeft);
        room.gameData.nightTimer = setInterval(() => {
            timeLeft--; io.to(roomId).emit('night-timer-tick', timeLeft);
            if (timeLeft <= 0) { clearInterval(room.gameData.nightTimer); room.gameData.nightTimer = null; room.gameData.phase = 'night-part2'; io.to(roomId).emit('game-event', { type: 'go-to-night-part2', players: room.players }); }
        }, 1000);
    });

    socket.on('submit-divine', (data) => {
        const { roomId, targetId } = data;
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        room.gameData.nightSeerTargetId = targetId;
        const target = room.players.find(p => p.id === targetId);
        let roleResult = (target.role === '宇宙人') ? '人間ではない' : target.role;
        socket.emit('divine-result', { day: room.gameData.day, targetName: target.name, targetRole: roleResult });
        checkNightActionsComplete(room, roomId);
    });

    socket.on('progress-to-daybreak', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameData) return;
        let killedName = 'なし'; let alienDisappeared = false;
        const victim = room.players.find(p => p.id === room.gameData.nightTargetId);
        const protectedPlayer = room.players.find(p => p.id === room.gameData.nightKnightTargetId);
        if (victim) { if (!(protectedPlayer && victim.id === protectedPlayer.id) && victim.role !== '宇宙人') { victim.isAlive = false; killedName = victim.name; } }
        const seerTarget = room.players.find(p => p.id === room.gameData.nightSeerTargetId);
        if (seerTarget && seerTarget.isAlive && seerTarget.role === '宇宙人') { seerTarget.isAlive = false; alienDisappeared = true; }
        room.gameData.phase = 'daybreak'; room.gameData.confirmedDaybreakUsers = [];
        const winner = checkVictory(room);
        room.players.forEach(p => { io.to(p.id).emit('game-event', { type: 'go-to-daybreak', victimName: killedName, alienDisappeared: alienDisappeared, isGameOver: winner !== null, winner: winner, players: room.players, lastExecuted: room.gameData.lastExecuted, myRoomLog: room.gameData.roomLogs[p.id] || [] }); });
    });

    socket.on('disconnect', () => { handleLeaveRoom(socket); });
});

function handleLeaveRoom(socket, roomId = null) {
    // どの部屋にいるか探す（roomId指定がない場合）
    const targetRoomId = roomId || Object.keys(rooms).find(id => rooms[id].players.some(p => p.id === socket.id));
    if (!targetRoomId) return;
    const room = rooms[targetRoomId];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    if (player.isHost) {
        io.to(targetRoomId).emit('room-closed', 'ホスト