import admin from 'firebase-admin';

// 1. KONFIGURASI
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// 2. INIT FIREBASE (Wajib agar bisa masuk Panel Admin)
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
    } catch (e) { console.error("Firebase Error:", e); }
}
const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('CS Bot Ready');

    try {
        const body = req.body;
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id;
            const text = msg.text || '(Gambar/Stiker)';
            const name = msg.chat.first_name || 'User';
            
            // --- SKENARIO 1: ADMIN MEMBALAS (/balas ID PESAN) ---
            if (chatId.toString() === ADMIN_ID && text.startsWith('/balas ')) {
                const args = text.split(' ');
                const targetId = args[1];
                const replyMsg = args.slice(2).join(' ');

                if (targetId && replyMsg) {
                    // 1. Kirim ke Telegram User
                    await sendTelegram(targetId, `👨‍💻 <b>Admin:</b> ${replyMsg}`);
                    
                    // 2. Simpan ke Firebase (Agar terekam di Panel Admin sebagai balasan)
                    // Asumsi collection di panel admin adalah 'chats'
                    await db.collection('chats').add({
                        from: 'Admin',
                        to: targetId,
                        message: replyMsg,
                        timestamp: new Date().toISOString(),
                        read: true
                    });

                    await sendTelegram(ADMIN_ID, `✅ Terkirim & Disimpan.`);
                }
            } 
            
            // --- SKENARIO 2: USER BIASA CHAT ---
            else if (chatId.toString() !== ADMIN_ID) {
                // 1. Simpan ke Firebase (Agar muncul di Panel Admin)
                await db.collection('chats').add({
                    from: 'TelegramUser', // Penanda sumber
                    userId: chatId.toString(),
                    name: name,
                    message: text,
                    timestamp: new Date().toISOString(),
                    read: false
                });

                // 2. Notifikasi ke Telegram Admin
                const lapor = `📩 <b>Pesan Baru</b>\nOleh: ${name}\nMsg: "${text}"\n\nJawab: <code>/balas ${chatId} pesan</code>`;
                await sendTelegram(ADMIN_ID, lapor);

                // 3. Auto-reply ke User
                if (text === '/start') {
                    await sendTelegram(chatId, `Halo ${name}! Selamat datang di Pandawa Store.`);
                } else {
                    await sendTelegram(chatId, "✅ Pesan diterima admin.");
                }
            }
        }
    } catch (e) {
        console.error("Handler Error:", e);
    }
    return res.status(200).send('OK');
}

async function sendTelegram(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}