// File: api/cs.js
import admin from 'firebase-admin';

const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda

// Init Firebase (Opsional, untuk jaga-jaga)
try {
    if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
    }
} catch (e) { console.log("Firebase handled"); }

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('CS Bot Active');

    try {
        const body = req.body;
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || '';
            const name = body.message.chat.first_name || 'Kak';
            const username = body.message.chat.username || 'No Username';

            // --- 1. FITUR BALAS PESAN (KHUSUS ADMIN) ---
            // Cara pakai: /balas [ID_USER] [PESAN ANDA]
            // Contoh: /balas 12345678 Halo kak, sudah diproses ya
            if (chatId.toString() === ADMIN_ID && text.startsWith('/balas ')) {
                const args = text.split(' ');
                const targetId = args[1]; // ID User tujuan
                const replyMsg = args.slice(2).join(' '); // Pesan balasan

                if (targetId && replyMsg) {
                    // Kirim ke User
                    await sendMessage(targetId, `👨‍💻 <b>Admin:</b>\n${replyMsg}`);
                    // Konfirmasi ke Admin
                    await sendMessage(ADMIN_ID, `✅ Terkirim ke ${targetId}:\n"${replyMsg}"`);
                } else {
                    await sendMessage(ADMIN_ID, "⚠️ Format salah.\nGunakan: <code>/balas [ID_USER] [PESAN]</code>");
                }
                return res.status(200).send('OK');
            }

            // --- 2. FITUR USER KIRIM PESAN ---
            if (chatId.toString() !== ADMIN_ID) {
                if (text === '/start') {
                    await sendMessage(chatId, `Halo <b>${name}</b>! 👋\n\nSelamat datang di Layanan Pelanggan Pandawa Store.\nSilakan tulis pesan Anda, Admin kami akan segera membalas.`);
                } else {
                    // Beritahu user pesan sudah masuk
                    await sendMessage(chatId, "✅ Pesan diterima. Mohon tunggu respon Admin.");

                    // Lapor ke Admin
                    const laporMsg = `📩 <b>Pesan Baru User</b>\n` +
                                     `Nama: ${name} (@${username})\n` +
                                     `ID: <code>${chatId}</code>\n\n` +
                                     `Pesan:\n"${text}"\n\n` +
                                     `👉 <b>Cara Balas:</b>\nCopy ID diatas, lalu ketik:\n` +
                                     `/balas ${chatId} Isi pesan anda`;
                    
                    await sendMessage(ADMIN_ID, laporMsg);
                }
            }
        }
    } catch (e) { console.error(e); }
    
    return res.status(200).send('OK');
}

async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}