import admin from 'firebase-admin';

// ==========================================
// 1. KONFIGURASI (TOKEN & ADMIN ID)
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// ==========================================
// 2. INISIALISASI FIREBASE
// ==========================================
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log("🔥 Firebase Connected in cs.js");
        }
    } catch (e) { console.error("Firebase Init Error:", e); }
}
const db = admin.firestore();

// ==========================================
// 3. LOGIC UTAMA (HANDLER)
// ==========================================
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(200).send('Bot CS Swipe-Reply Ready');
    }

    try {
        const body = req.body;
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';

            // -----------------------------------------------------------
            // A. LOGIKA BALAS (ADMIN ONLY) -> Swipe atau Manual
            // -----------------------------------------------------------
            let targetUserId = null;
            let replyMsg = text;

            // 1. Deteksi Swipe Reply
            if (chatId === ADMIN_ID && msg.reply_to_message) {
                const replyToText = msg.reply_to_message.text || '';
                // Regex: Mencari ID setelah kata "ID:" (bisa berupa angka atau kode unik website)
                const match = replyToText.match(/ID:\s*([A-Za-z0-9_-]+)/);
                if (match) targetUserId = match[1];
            } 
            // 2. Deteksi Manual /balas [ID] [PESAN]
            else if (chatId === ADMIN_ID && text.startsWith('/balas ')) {
                const args = text.split(' ');
                targetUserId = args[1];
                replyMsg = args.slice(2).join(' ');
            }

            // EKSEKUSI PENGIRIMAN BALASAN
            if (targetUserId && chatId === ADMIN_ID) {
                try {
                    // --- SINKRONISASI KE DATABASE WEBSITE ---
                    // Sesuai index.html: chats > UID > messages > autoID
                    await db.collection('chats').doc(targetUserId).collection('messages').add({
                        text: replyMsg,
                        sender: 'admin',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: true
                    });

                    // Update metadata di level dokumen user (agar admin panel tau ada update)
                    await db.collection('chats').doc(targetUserId).set({
                        lastMessage: replyMsg,
                        lastTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                        lastSender: 'admin',
                        isRead: true
                    }, { merge: true });

                    // --- JIKA TARGET ADALAH USER TELEGRAM (ID ANGKA) ---
                    if (/^\d+$/.test(targetUserId)) {
                        await sendTelegram(targetUserId, `👨‍💻 <b>CS Pandawa:</b>\n${replyMsg}`);
                    }

                    await sendTelegram(ADMIN_ID, `✅ Terkirim ke Website & Telegram (ID: <code>${targetUserId}</code>)`);
                } catch (dbErr) {
                    await sendTelegram(ADMIN_ID, `❌ Gagal simpan ke database: ${dbErr.message}`);
                }
                return res.status(200).send('OK');
            }

            // -----------------------------------------------------------
            // B. LOGIKA USER CHAT KE BOT
            // -----------------------------------------------------------
            if (chatId !== ADMIN_ID) {
                const name = msg.chat.first_name || 'User';
                const username = msg.chat.username ? `@${msg.chat.username}` : '-';

                // 1. Laporkan ke Admin (PENTING: Jangan ubah format ID: agar Swipe jalan)
                const report = `📩 <b>CHAT BARU (TG)</b>\n\n` +
                               `👤 Nama: ${name} (${username})\n` +
                               `🆔 ID: <code>${chatId}</code>\n\n` +
                               `💬 Pesan: "${text}"\n\n` +
                               `👉 <i>Swipe untuk membalas...</i>`;
                
                await sendTelegram(ADMIN_ID, report);

                // 2. Simpan Chat User ke Firestore (Opsional)
                await db.collection('chats').doc(chatId).collection('messages').add({
                    text: text,
                    sender: 'user',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    isRead: false
                });

                // 3. Sambutan Otomatis
                if (text === '/start') {
                    await sendTelegram(chatId, `Halo ${name}! 👋 Ada yang bisa kami bantu?`);
                }
            }
        }
    } catch (error) {
        console.error("CS Handler Error:", error);
    }

    return res.status(200).send('OK');
}

// ==========================================
// HELPER: KIRIM PESAN TELEGRAM
// ==========================================
async function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        });
    } catch (e) { console.error("Fetch Error:", e); }
}