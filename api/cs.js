import admin from 'firebase-admin';

const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166";

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (e) { console.error("Firebase Error:", e); }
}
const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot CS Active');

    try {
        const body = req.body;
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';
            const name = msg.chat.first_name || 'User';

            // --- LOGIKA 1: ADMIN MEMBALAS (VIA REPLY/SWIPE) ---
            if (chatId === ADMIN_ID && msg.reply_to_message) {
                // Ambil ID User dari pesan yang direply
                // Kita akan mencari ID di dalam teks laporan (menggunakan Regex)
                const replyText = msg.reply_to_message.text || '';
                const match = replyText.match(/🆔 ID: (\d+)/) || replyText.match(/🆔 ID: <code>(\d+)<\/code>/);
                
                if (match && match[1]) {
                    const targetId = match[1];
                    const replyMsg = text; // Isi chat admin

                    // 1. Kirim ke User
                    await sendMessage(targetId, `👨‍💻 <b>Admin CS:</b>\n${replyMsg}`);
                    
                    // 2. Simpan ke Firebase
                    await db.collection('chats').add({
                        userId: targetId,
                        sender: 'admin',
                        message: replyMsg,
                        name: 'Admin Support',
                        timestamp: new Date().toISOString(),
                        read: true,
                        source: 'telegram_reply'
                    });

                    await sendMessage(ADMIN_ID, `✅ Terbalas ke ID <code>${targetId}</code>`);
                    return res.status(200).send('OK');
                }
            }

            // --- LOGIKA 2: PERINTAH MANUAL /BALAS (TETAP DIADAKAN) ---
            if (chatId === ADMIN_ID && text.startsWith('/balas ')) {
                const args = text.split(' ');
                const targetId = args[1];
                const replyMsg = args.slice(2).join(' ');
                if (targetId && replyMsg) {
                    await sendMessage(targetId, `👨‍💻 <b>Admin CS:</b>\n${replyMsg}`);
                    await db.collection('chats').add({
                        userId: targetId, sender: 'admin', message: replyMsg,
                        timestamp: new Date().toISOString(), source: 'telegram_manual'
                    });
                    await sendMessage(ADMIN_ID, `✅ Terkirim.`);
                }
                return res.status(200).send('OK');
            }

            // --- LOGIKA 3: USER CHAT ---
            if (chatId !== ADMIN_ID) {
                // Simpan ke DB
                await db.collection('chats').add({
                    userId: chatId,
                    sender: 'user',
                    message: text,
                    name: `${name} (TG)`,
                    timestamp: new Date().toISOString(),
                    read: false,
                    source: 'telegram'
                });

                // Notif ke Admin (Penting: Format 🆔 ID: harus tepat agar regex swipe reply jalan)
                const report = `📩 <b>CHAT BARU</b>\n` +
                               `👤 Nama: ${name}\n` +
                               `🆔 ID: <code>${chatId}</code>\n\n` +
                               `💬 Pesan:\n"${text}"\n\n` +
                               `👉 <i>Swipe ke kiri untuk membalas...</i>`;
                
                await sendMessage(ADMIN_ID, report);
                
                if (text === '/start') {
                    await sendMessage(chatId, `Halo ${name}, ada yang bisa dibantu?`);
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