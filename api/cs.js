// File: api/cs.js
// KHUSUS UNTUK BOT CUSTOMER SERVICE (Chat ke User)
import admin from 'firebase-admin';

// Token Bot CS (Bot Baru)
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda untuk menerima laporan chat

// Init Firebase (Cek agar tidak bentrok dengan telegram.js)
// Kita gunakan try-catch agar aman
try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    }
} catch (e) {
    console.log("Firebase init skipped/handled in cs.js");
}

export default async function handler(req, res) {
    // Hanya terima POST dari Telegram
    if (req.method !== 'POST') {
        return res.status(200).send('Bot CS Active');
    }

    try {
        const body = req.body;
        
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || '';
            const name = body.message.chat.first_name || 'Kak';
            const username = body.message.chat.username || 'No Username';

            // --- LOGIKA BALASAN CS ---
            
            if (text === '/start') {
                // Balasan saat user pertama kali klik Start
                await sendMessage(chatId, `Halo <b>${name}</b>! 👋\n\nSelamat datang di Layanan Pelanggan Pandawa Store.\nSilakan tulis pesan Anda, Admin kami akan segera membalas.`);
            } else {
                // Balasan Otomatis untuk pesan biasa
                await sendMessage(chatId, "✅ Pesan diterima. Mohon tunggu respon dari Admin.");

                // TERUSKAN PESAN KE ANDA (ADMIN)
                // Agar Anda tahu ada user yang chat ke bot CS
                if (chatId.toString() !== ADMIN_ID) {
                    const laporMsg = `📩 <b>Pesan Baru (CS Bot)</b>\n\nDari: ${name} (@${username})\nID: <code>${chatId}</code>\n\nPesan:\n"${text}"`;
                    await sendMessage(ADMIN_ID, laporMsg);
                }
            }
        }
    } catch (e) {
        console.error("Error CS Bot:", e);
    }
    
    // Wajib return 200 OK
    return res.status(200).send('OK');
}

// Fungsi Kirim Pesan
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}