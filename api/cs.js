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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot CS Active');

    try {
        const body = req.body;

        // --- FITUR A: LOGIKA TOMBOL TERIMA/TOLAK (CALLBACK QUERY) ---
        if (body.callback_query) {
            const cb = body.callback_query;
            const chatId = cb.message.chat.id;
            const messageId = cb.message.message_id;
            const [action, targetUid] = cb.data.split('_');

            // Ambil data nominal dari teks pesan Telegram (mencari angka di baris Nominal)
            const msgText = cb.message.text || "";
            const nominalMatch = msgText.match(/Nominal:\s*Rp\s*([0-9.]+)/i);
            const nominalStr = nominalMatch ? nominalMatch[1].replace(/\./g, '') : "0";
            const amount = parseInt(nominalStr);

            if (action === 'approve') {
                try {
                    // Jalankan Transaksi Database (Atomic)
                    await db.runTransaction(async (t) => {
                        const userRef = db.collection('users').doc(targetUid);
                        const userSnap = await t.get(userRef);
                        
                        if (!userSnap.exists) throw "User tidak ditemukan";
                        
                        const currentBal = userSnap.data().balance || 0;
                        const newBal = currentBal + amount;
                        
                        // 1. Tambah Saldo
                        t.update(userRef, { balance: newBal });

                        // 2. Cari transaksi pending terakhir di history user dan ubah jadi Sukses
                        const historyRef = userRef.collection('history');
                        const q = await historyRef.where('status', '==', 'Pending').where('provider_id', '==', 'MANUAL_SEABANK').limit(1).get();
                        
                        if (!q.empty) {
                            t.update(q.docs[0].ref, { 
                                status: 'Sukses', 
                                api_msg: 'Diterima via Telegram Bot',
                                balance_after: newBal
                            });
                        }
                    });

                    await sendTelegram(chatId, `✅ <b>TOP UP BERHASIL</b>\nUID: <code>${targetUid}</code>\nSaldo ditambahkan: Rp ${amount.toLocaleString()}\n\n<i>Status database telah diupdate ke Sukses.</i>`);
                } catch (err) {
                    await sendTelegram(chatId, `❌ <b>Gagal Proses:</b> ${err}`);
                }
            } 
            
            else if (action === 'reject') {
                try {
                    const userRef = db.collection('users').doc(targetUid);
                    const historyRef = userRef.collection('history');
                    const q = await historyRef.where('status', '==', 'Pending').where('provider_id', '==', 'MANUAL_SEABANK').limit(1).get();

                    if (!q.empty) {
                        await q.docs[0].ref.update({ 
                            status: 'Gagal', 
                            api_msg: 'Ditolak oleh Admin via Telegram' 
                        });
                        await sendTelegram(chatId, `❌ Permintaan UID <code>${targetUid}</code> telah <b>DITOLAK</b> dan status diubah ke Gagal.`);
                    } else {
                        await sendTelegram(chatId, `⚠️ Transaksi tidak ditemukan atau sudah diproses.`);
                    }
                } catch (err) {
                    await sendTelegram(chatId, `❌ Error: ${err.message}`);
                }
            }
            
            // Hapus tombol agar tidak diklik dua kali
            await editMessageReplyMarkup(chatId, messageId);
            return res.status(200).send('OK');
        }

        // --- FITUR B: LOGIKA PESAN CHAT (Sama seperti sebelumnya) ---
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';

            if (chatId === ADMIN_ID && msg.reply_to_message) {
                const replyToText = msg.reply_to_message.text || '';
                const match = replyToText.match(/ID:\s*([A-Za-z0-9_-]+)/);
                if (match && match[1]) {
                    const targetUserId = match[1];
                    await db.collection('chats').doc(targetUserId).collection('messages').add({
                        text: text, sender: 'admin', timestamp: admin.firestore.FieldValue.serverTimestamp(), isRead: true
                    });
                    await db.collection('chats').doc(targetUserId).set({
                        lastMessage: text, lastTimestamp: admin.firestore.FieldValue.serverTimestamp(), lastSender: 'admin', isRead: true
                    }, { merge: true });
                    await sendTelegram(ADMIN_ID, `✅ Balasan terkirim.`);
                }
            } else if (chatId !== ADMIN_ID) {
                const report = `📩 <b>CHAT BARU</b>\n👤 Nama: ${msg.chat.first_name}\n🆔 ID: <code>${chatId}</code>\n💬 Pesan: "${text}"\n\n👉 Swipe untuk balas`;
                await sendTelegram(ADMIN_ID, report);
            }
        }
    } catch (error) { console.error(error); }
    return res.status(200).send('OK');
}

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