import express from "express";
import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import axios from "axios";
import P from "pino";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const WEBHOOK_FILE = "./webhooks.json";
const clients = {};
const qrStore = {};
const statusStore = {};
const messageLogs = {}; // In-memory store for recent logs

/* 💾 PERSISTENCE INITIALIZATION */
let webhookStore = {};
if (fs.existsSync(WEBHOOK_FILE)) {
    try {
        webhookStore = JSON.parse(fs.readFileSync(WEBHOOK_FILE, "utf-8"));
    } catch (e) {
        console.error("Error reading webhooks.json, starting fresh.");
        webhookStore = {};
    }
}

const saveWebhooksToFile = () => {
    fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(webhookStore, null, 2));
};

/* 🔐 AUTH MIDDLEWARE */
function auth(req, res, next) {
    const key = req.query.key || req.headers["x-api-key"];
    if (key !== process.env.ADMIN_KEY) {
        return res.status(403).send("Unauthorized");
    }
    next();
}

/* =========================
   CORE CLIENT LOGIC
========================= */
async function startClient(clientId) {
    const { state, saveCreds } = await useMultiFileAuthState(`sessions/${clientId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false
    });

    clients[clientId] = sock;
    statusStore[clientId] = "initializing";

    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            qrStore[clientId] = qr;
            statusStore[clientId] = "qr";
        }

        if (connection === "open") {
            qrStore[clientId] = null;
            statusStore[clientId] = "connected";
            console.log(`✅ [${clientId}] Connected successfully`);
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log(`🔄 [${clientId}] Connection lost. Reconnecting...`);
                startClient(clientId);
            } else {
                console.log(`❌ [${clientId}] Logged out. Cleaning up session.`);
                delete clients[clientId];
                statusStore[clientId] = "logged_out";
                qrStore[clientId] = null;
                if (fs.existsSync(`sessions/${clientId}`)) {
                    fs.rmSync(`sessions/${clientId}`, { recursive: true, force: true });
                }
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    /* 📩 MESSAGE & LOG HANDLER */
    /* 📩 MESSAGE & LOG HANDLER */
sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message) return;

    // 1. Get the Raw ID
    const rawJid = msg.key.remoteJid;
    
    // 2. Extract the Phone Number (Cleans @s.whatsapp.net or @lid)
    // This regex takes the numbers before the '@' sign
    const phoneNumber = rawJid.split('@')[0].split(':')[0]; 

    const isMe = msg.key.fromMe;
    const pushName = msg.pushName || (isMe ? "Me" : "Customer");
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "Non-text message";

    // 3. Prepare the Log Entry
    const logEntry = {
        timestamp: new Date().toLocaleString(),
        direction: isMe ? "OUTGOING" : "INCOMING",
        from: rawJid,       // Keep full JID for system use
        phone: phoneNumber, // Clean phone number for your HTTP requests
        sender: pushName,
        message: text
    };

    // Console Logging for debugging
    const color = isMe ? "\x1b[36m" : "\x1b[32m"; 
    console.log(`${color}[${logEntry.direction}] ${clientId} | Phone: ${phoneNumber} | ${pushName}: ${text}\x1b[0m`);

    // 4. Trigger Webhook with the "phone" field
    const webhook = webhookStore[clientId];
    if (webhook) {
        try {
            await axios.post(webhook, {
                clientId,
                from: rawJid,
                phone: phoneNumber, // 👈 Now you have the number for your n8n/HTTP requests
                pushName,
                message: text,
                isMe: isMe,
                direction: logEntry.direction,
                timestamp: logEntry.timestamp
            });
        } catch (err) {
            console.error(`⚠️ [${clientId}] Webhook Error:`, err.message);
        }
    }
});
}

/* =========================
   API ENDPOINTS
========================= */

// Start a client and optionally set/update webhook
app.post("/start", auth, async (req, res) => {
    const { clientId, webhook } = req.body;
    if (!clientId) return res.status(400).json({ error: "clientId required" });

    // NEW LOGIC (Always saves the client so it shows up in the list)
if (!webhookStore[clientId]) {
    webhookStore[clientId] = webhook || ""; // Save blank if no webhook provided
    saveWebhooksToFile();
} else if (webhook) {
    webhookStore[clientId] = webhook; // Update webhook if a new one is sent
    saveWebhooksToFile();
}

    if (clients[clientId] && statusStore[clientId] === "connected") {
        return res.json({ message: "Already connected", status: statusStore[clientId] });
    }

    startClient(clientId);
    res.json({ message: "Initialization started", clientId });
});

// Update webhook for a specific client
app.post("/webhook", auth, (req, res) => {
    const { clientId, webhook } = req.body;
    if (!clientId || !webhook) return res.status(400).json({ error: "Missing data" });

    webhookStore[clientId] = webhook;
    saveWebhooksToFile();
    res.json({ success: true, message: `Webhook updated for ${clientId}` });
});

// Get QR Code
app.get("/qr/:clientId", auth, async (req, res) => {
    const qr = qrStore[req.params.clientId];
    if (!qr) return res.json({ qr: null, status: statusStore[req.params.clientId] });

    const img = await QRCode.toDataURL(qr);
    res.json({ qr: img });
});

// List all clients and their current status
app.get("/clients", auth, (req, res) => {
    const list = Object.keys(webhookStore).map(id => ({
        clientId: id,
        webhook: webhookStore[id],
        status: statusStore[id] || "idle"
    }));
    res.json(list);
});

// View message logs for a client
app.get("/logs/:clientId", auth, (req, res) => {
    const logs = messageLogs[req.params.clientId] || [];
    res.json({
        clientId: req.params.clientId,
        count: logs.length,
        history: [...logs].reverse()
    });
});


// Send message (supports JID or phone)
app.post("/send", auth, async (req, res) => {
    const { clientId, to, message } = req.body;

    if (!clientId || !to || !message) {
        return res.status(400).json({ error: "clientId, to, message required" });
    }

    const sock = clients[clientId];

    if (!sock) {
        return res.status(400).json({ error: "Client not connected" });
    }

    try {
        // If user sends only number, auto convert
        let jid = to;

        if (!to.includes("@")) {
            jid = to + "@s.whatsapp.net";
        }

        await sock.sendMessage(jid, { text: message });

        res.json({
            success: true,
            to: jid,
            message: "Message sent successfully"
        });

    } catch (err) {
        console.error(`❌ Send Error [${clientId}]`, err.message);
        res.status(500).json({ error: err.message });
    }
});


/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Multi-Client Server running on port ${PORT}`);
    
    // Auto-restart existing sessions on server boot
    Object.keys(webhookStore).forEach(id => {
        console.log(`♻️ Auto-restarting session for: ${id}`);
        startClient(id);
    });
});