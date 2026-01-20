// File: api/cs.js
// Bot untuk Chat User & Info Umum
import admin from 'firebase-admin';

const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// Init Firebase (Cek agar tidak bentrok dengan admin.js)
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot CS Active');

    try {
        const body = req.body;
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || '';
            const name = body.message.chat.first_name || 'Kak';

            // --- LOGIKA BALASAN CS ---
            if (text === '/start') {
                await sendMessage(chatId, `Halo ${name}! 👋\nAda yang bisa kami bantu terkait layanan Pandawa Store?`);
            } else {
                // Auto reply sederhana
                await sendMessage(chatId, "Pesan diterima. Admin akan segera merespon.");
                // Teruskan ke Telegram Pribadi Anda
                if (chatId.toString() !== ADMIN_ID) {
                    await sendMessage(ADMIN_ID, `📩 <b>Chat Masuk:</b>\nDari: ${name} (@${body.message.chat.username})\nPesan: ${text}`);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
    return res.status(200).send('OK');
}

async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}