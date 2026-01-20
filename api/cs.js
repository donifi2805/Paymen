import admin from 'firebase-admin';

// 1. KONFIGURASI
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// 2. INISIALISASI FIREBASE
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (e) { console.error("Firebase Init Error:", e); }
}
const db = admin.firestore();

// 3. HANDLER UTAMA
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot CS Active');

    try {
        const body = req.body;

        // --- FITUR A: TOMBOL TERIMA/TOLAK (Callback Query) ---
        if (body.callback_query) {
            const cb = body.callback_query;
            const [action, targetUid] = cb.data.split('_');
            const chatId = cb.message.chat.id;

            if (action === 'approve') {
                await sendTelegram(chatId, `⏳ <b>Proses Verifikasi...</b>\nUID: <code>${targetUid}</code>\n\nSedang mengecek data di database.`);
                // Disini bot memberikan instruksi, eksekusi saldo tetap disarankan di Panel Admin untuk keamanan.
            } else if (action === 'reject') {
                await sendTelegram(chatId, `❌ Permintaan Top Up untuk UID <code>${targetUid}</code> telah Anda abaikan/tolak.`);
            }
            return res.status(200).send('OK');
        }

        // --- FITUR B: PESAN MASUK ---
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';

            // 1. ADMIN MEMBALAS VIA SWIPE/REPLY
            if (chatId === ADMIN_ID && msg.reply_to_message) {
                const replyToText = msg.reply_to_message.text || '';
                const match = replyToText.match(/ID:\s*([A-Za-z0-9_-]+)/);
                
                if (match && match[1]) {
                    const targetUserId = match[1];
                    const replyMsg = text;

                    // Simpan ke Firestore (chats > UID > messages) agar muncul di Web
                    await db.collection('chats').doc(targetUserId).collection('messages').add({
                        text: replyMsg,
                        sender: 'admin',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: true
                    });

                    // Update metadata header
                    await db.collection('chats').doc(targetUserId).set({
                        lastMessage: replyMsg,
                        lastTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                        lastSender: 'admin',
                        isRead: true
                    }, { merge: true });

                    await sendTelegram(ADMIN_ID, `✅ Balasan terkirim ke website (ID: <code>${targetUserId}</code>)`);
                    return res.status(200).send('OK');
                }
            }

            // 2. USER TELEGRAM CHAT KE BOT
            if (chatId !== ADMIN_ID) {
                const name = msg.chat.first_name || 'User';
                // Kirim laporan ke admin agar admin bisa swipe
                const report = `📩 <b>CHAT DARI TELEGRAM</b>\n\n👤 Nama: ${name}\n🆔 ID: <code>${chatId}</code>\n\n💬 Pesan: "${text}"\n\n👉 <i>Swipe untuk membalas ke Telegram user...</i>`;
                await sendTelegram(ADMIN_ID, report);
            }
        }
    } catch (error) {
        console.error("CS Handler Error:", error);
    }
    return res.status(200).send('OK');
}

// HELPER: KIRIM PESAN TELEGRAM
async function sendTelegram(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}