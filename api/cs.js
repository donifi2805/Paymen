import admin from 'firebase-admin';

// 1. KONFIGURASI
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// 2. INISIALISASI FIREBASE (SERVER-SIDE)
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
    } catch (e) {
        console.error("Firebase Init Error:", e);
    }
}
const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot CS Active');

    try {
        const body = req.body;

        // --- BAGIAN 1: LOGIKA TOMBOL (TOP UP MANUAL) ---
        if (body.callback_query) {
            const cb = body.callback_query;
            const chatId = cb.message.chat.id;
            const messageId = cb.message.message_id;
            const [action, targetUid] = cb.data.split('_');

            // Ambil nominal dari teks pesan notifikasi
            const msgText = cb.message.text || "";
            const nominalMatch = msgText.match(/Nominal:\s*Rp\s*([0-9.]+)/i);
            const nominalStr = nominalMatch ? nominalMatch[1].replace(/\./g, '') : "0";
            const amount = parseInt(nominalStr);

            if (action === 'approve') {
                try {
                    await db.runTransaction(async (t) => {
                        const userRef = db.collection('users').doc(targetUid);
                        const userSnap = await t.get(userRef);
                        if (!userSnap.exists) throw "User tidak ditemukan";
                        
                        const currentBal = userSnap.data().balance || 0;
                        const newBal = currentBal + amount;
                        
                        t.update(userRef, { balance: newBal });
                        
                        const historyRef = userRef.collection('history');
                        const q = await historyRef.where('status', '==', 'Pending')
                                                  .where('provider_id', '==', 'MANUAL_SEABANK')
                                                  .limit(1).get();
                        
                        if (!q.empty) {
                            t.update(q.docs[0].ref, { 
                                status: 'Sukses', 
                                api_msg: 'Diterima via Bot Telegram',
                                balance_after: newBal
                            });
                        }
                    });
                    await sendTelegram(chatId, `✅ <b>TOP UP BERHASIL</b>\nUID: <code>${targetUid}</code>\nSaldo ditambahkan: Rp ${amount.toLocaleString()}`);
                } catch (err) {
                    await sendTelegram(chatId, `❌ <b>Gagal:</b> ${err}`);
                }
            } 
            else if (action === 'reject') {
                const userRef = db.collection('users').doc(targetUid);
                const q = await userRef.collection('history').where('status', '==', 'Pending')
                                      .where('provider_id', '==', 'MANUAL_SEABANK')
                                      .limit(1).get();
                if (!q.empty) {
                    await q.docs[0].ref.update({ status: 'Gagal', api_msg: 'Ditolak via Telegram' });
                }
                await sendTelegram(chatId, `❌ Top Up UID <code>${targetUid}</code> telah <b>DITOLAK</b>.`);
            }
            
            await editMessageReplyMarkup(chatId, messageId);
            return res.status(200).send('OK');
        }

        // --- BAGIAN 2: LOGIKA PESAN (START / CHAT WEB / REPLY) ---
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';
            const name = msg.from ? msg.from.first_name : 'User';

            // A. PERINTAH /START
            if (text === '/start') {
                const welcomeMsg = chatId === ADMIN_ID 
                    ? "👨‍✈️ <b>Halo Admin!</b>\nBot siap menerima notifikasi chat & topup manual." 
                    : "👋 <b>Halo!</b>\nAda yang bisa kami bantu? Kirim pesan di sini untuk chat dengan Admin.";
                await sendTelegram(chatId, welcomeMsg);
                return res.status(200).send('OK');
            }

            // B. ADMIN MEMBALAS CHAT (SWIPE / REPLY)
            if (chatId === ADMIN_ID && msg.reply_to_message) {
                const replyToText = msg.reply_to_message.text || '';
                // Deteksi ID dari baris "🆔 ID: UID"
                const match = replyToText.match(/ID:\s*([A-Za-z0-9_-]+)/);
                
                if (match && match[1]) {
                    const targetUserId = match[1];
                    
                    // Simpan balasan ke Firestore agar muncul di Website User
                    await db.collection('chats').doc(targetUserId).collection('messages').add({
                        text: text,
                        sender: 'admin',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isRead: true
                    });

                    await db.collection('chats').doc(targetUserId).set({
                        lastMessage: text,
                        lastTimestamp: admin.firestore.FieldValue.serverTimestamp(),
                        lastSender: 'admin',
                        isRead: true
                    }, { merge: true });

                    await sendTelegram(ADMIN_ID, `✅ Balasan terkirim ke User.`);
                }
                return res.status(200).send('OK');
            }

            // C. USER BIASA CHAT LANGSUNG KE BOT (BUKAN DARI WEB)
            if (chatId !== ADMIN_ID) {
                const report = `📩 <b>CHAT DARI TELEGRAM</b>\n👤 Nama: ${name}\n🆔 ID: <code>${chatId}</code>\n💬 Pesan: "${text}"\n\n👉 Swipe untuk balas`;
                await sendTelegram(ADMIN_ID, report);
            }
        }
    } catch (error) {
        console.error("Critical Bot Error:", error);
    }

    return res.status(200).send('OK');
}

// FUNGSI HELPER
async function sendTelegram(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}

async function editMessageReplyMarkup(chatId, messageId) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    });
}