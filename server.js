import express from "express";
import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import axios from "axios";
import P from "pino";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const clients = {};
const qrStore = {};
const webhookStore = {};
const statusStore = {}; // 🔥 NEW

/* 🔐 AUTH */
function auth(req, res, next) {
    const key = req.query.key || req.headers["x-api-key"];
    if (key !== process.env.ADMIN_KEY) {
        return res.status(403).send("Unauthorized");
    }
    next();
}

/* =========================
   START CLIENT
========================= */
app.post("/start", auth, async (req, res) => {
    const { clientId, webhook } = req.body;

    if (!clientId) {
        return res.status(400).json({ error: "clientId required" });
    }

    webhookStore[clientId] = webhook || webhookStore[clientId];

    if (clients[clientId]) {
        return res.json({ message: "Already running" });
    }

    startClient(clientId);

    res.json({ message: "Starting..." });
});

/* =========================
   UPDATE WEBHOOK
========================= */
app.post("/webhook", auth, (req, res) => {
    const { clientId, webhook } = req.body;

    webhookStore[clientId] = webhook;
    res.json({ success: true });
});

/* =========================
   GET QR
========================= */
app.get("/qr/:clientId", auth, async (req, res) => {
    const qr = qrStore[req.params.clientId];

    if (!qr) return res.json({ qr: null });

    const img = await QRCode.toDataURL(qr);
    res.json({ qr: img });
});

/* =========================
   LIST CLIENTS
========================= */
app.get("/clients", auth, (req, res) => {
    const list = Object.keys(webhookStore).map(id => ({
        clientId: id,
        webhook: webhookStore[id] || "",
        status: statusStore[id] || "not_started"
    }));

    res.json(list);
});

/* =========================
   CORE CLIENT
========================= */
async function startClient(clientId) {

    const { state, saveCreds } = await useMultiFileAuthState(`sessions/${clientId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" })
    });

    clients[clientId] = sock;
    statusStore[clientId] = "initializing";

    sock.ev.on("connection.update", (update) => {
        const { qr, connection } = update;

        if (qr) {
            qrStore[clientId] = qr;
            statusStore[clientId] = "qr";
        }

        if (connection === "open") {
            qrStore[clientId] = null;
            statusStore[clientId] = "connected";
            console.log(clientId, "connected");
        }

        if (connection === "close") {
            delete clients[clientId];
            statusStore[clientId] = "disconnected";
            console.log(clientId, "disconnected");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    /* 🔥 MESSAGE HANDLER */
    sock.ev.on("messages.upsert", async ({ messages }) => {

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;

        if (from.endsWith("@g.us")) return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

        const payload = {
            clientId, // 🔥 important
            from,
            message: text,
            fromMe,
            source: fromMe ? "human" : "user"
        };

        console.log("Webhook:", payload);

        try {
            const webhook = webhookStore[clientId];
            if (webhook) {
                await axios.post(webhook, payload);
            }
        } catch (err) {
            console.log("Webhook error:", err.message);
        }
    });
}

app.listen(process.env.PORT, () => {
    console.log("Server running on", process.env.PORT);
});