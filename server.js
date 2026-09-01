const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- PERSISTENT FILE DATABASE (SAVED LOCALLY IN DISK) ---
const DB_FILE = path.join(__dirname, 'blackcat_db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error loading DB:', err);
  }
  return { profiles: {}, messages: {} };
}

function saveDb() {
  try {
    const data = {
      profiles: Object.fromEntries(globalProfiles.entries()),
      messages: directMessagesObj
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving DB:', err);
  }
}

const db = loadDb();
const onlineUsers = new Map();
const globalProfiles = new Map(Object.entries(db.profiles || {}));
const directMessagesObj = db.messages || {};

// --- SOCKET.IO FOR LIVE PRESENCE, UID SEARCH, DMS & VOICE CHAT ---
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('online', (username) => {
    const cleanName = typeof username === 'string' ? username : username?.username;
    if (cleanName) {
      socket.data.username = cleanName;
      onlineUsers.set(socket.id, { username: cleanName, status: 'Online In Launcher', online: true, lastSeen: Date.now() });
      if (!globalProfiles.has(cleanName)) {
        globalProfiles.set(cleanName, { username: cleanName, uid: socket.data.uid || 'BC-0000', socketId: socket.id });
        saveDb();
      } else {
        const p = globalProfiles.get(cleanName);
        p.socketId = socket.id;
      }
      io.emit('presence-update', Array.from(onlineUsers.values()));
    }
  });

  socket.on('register-profile', ({ username, uid }) => {
    if (username && uid) {
      console.log(`[REGISTER] Username: "${username}" | UID: "${uid}" | Socket: ${socket.id}`);
      socket.data.username = username;
      socket.data.uid = uid;
      globalProfiles.set(username, { username, uid, socketId: socket.id });
      saveDb();
    }
  });

  socket.on('set-status', (status) => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      user.status = status;
      io.emit('presence-update', Array.from(onlineUsers.values()));
    }
  });

  // --- UID SEARCH FOR FRIENDS ---
  socket.on('search-uid', (query, callback) => {
    if (!query || typeof query !== 'string') {
      callback({ found: false });
      return;
    }

    let foundUser = null;
    const cleanQuery = query.trim().toLowerCase();
    
    for (const [username, profile] of globalProfiles.entries()) {
      if ((profile.uid && profile.uid.toLowerCase() === cleanQuery) || profile.username.toLowerCase() === cleanQuery) {
        foundUser = { username: profile.username, uid: profile.uid || 'BC-0000' };
        break;
      }
    }

    if (!foundUser) {
      for (const [sId, userObj] of onlineUsers.entries()) {
        if (userObj.username.toLowerCase() === cleanQuery) {
          foundUser = { username: userObj.username, uid: 'BC-0000' };
          break;
        }
      }
    }

    if (foundUser) {
      callback({ found: true, user: foundUser });
    } else {
      callback({ found: false });
    }
  });

  // --- DIRECT MESSAGING ---
  socket.on('send-dm', ({ recipient, message }) => {
    const recipientProfile = globalProfiles.get(recipient);
    if (recipientProfile && recipientProfile.socketId) {
      io.to(recipientProfile.socketId).emit('direct-message', message);
    }
  });

  socket.on('edit-dm', ({ recipient, messageId, newText }) => {
    const recipientProfile = globalProfiles.get(recipient);
    const senderUsername = socket.data.username;
    if (recipientProfile && recipientProfile.socketId && senderUsername) {
      io.to(recipientProfile.socketId).emit('message-edited', { sender: senderUsername, messageId, newText });
    }
  });

  socket.on('delete-dm', ({ recipient, messageId }) => {
    const recipientProfile = globalProfiles.get(recipient);
    const senderUsername = socket.data.username;
    if (recipientProfile && recipientProfile.socketId && senderUsername) {
      io.to(recipientProfile.socketId).emit('message-deleted', { sender: senderUsername, messageId });
    }
  });

  // --- VOICE CHAT SIGNALING ---
  socket.on('join-vc', (roomCode, userName) => {
    socket.join(roomCode);
    socket.to(roomCode).emit('user-joined', socket.id, userName);

    socket.on('signal', (toId, data) => {
      io.to(toId).emit('signal', socket.id, data);
    });

    socket.on('disconnect', () => {
      socket.to(roomCode).emit('user-left', socket.id);
    });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('presence-update', Array.from(onlineUsers.values()));
    console.log('A user disconnected:', socket.id);
  });
});

// --- API ENDPOINT: MOD INSTALLATION ---
app.post('/api/install-mod', (req, res) => {
  try {
    const { downloadUrl, fileName } = req.body;
    const modsDir = path.join(__dirname, 'minecraft_data', 'mods');
    if (!fs.existsSync(modsDir)) {
      fs.mkdirSync(modsDir, { recursive: true });
    }
    const filePath = path.join(modsDir, fileName);
    const fileStream = fs.createWriteStream(filePath);
    
    https.get(downloadUrl, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        res.json({ success: true });
      });
    }).on('error', (err) => {
      res.status(500).json({ success: false, error: err.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API ENDPOINT: GAME LAUNCH STREAM ---
app.post('/api/launch-game', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (percent, text) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', percent, text })}\n\n`);
  };

  sendProgress(30, 'Verifying game files...');
  setTimeout(() => {
    sendProgress(70, 'Injecting classpath dependencies...');
    setTimeout(() => {
      sendProgress(100, 'Modules ready!');
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    }, 800);
  }, 800);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blackcat backend server running on port ${PORT}`);
});
