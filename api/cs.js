// api/cs.js
import admin from 'firebase-admin';

const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_GROUP_ID = "-1003673877701"; 

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');
    const body = req.body;

    try {
        if (body.callback_query) {
            const cb = body.callback_query;
            const [action, targetUid] = cb.data.split('_');
            const chatId = cb.message.chat.id.toString();
            const messageId = cb.message.message_id;

            if (chatId !== ADMIN_GROUP_ID) return res.status(200).send('Unauthorized');

            // --- PERBAIKAN 1: HAPUS TOMBOL SEGERA (INSTAN) ---
            await editMessageReplyMarkup(chatId, messageId);

            if (action === 'approve') {
                const msgText = cb.message.text || "";
                const nominalMatch = msgText.match(/Nominal:\s*(?:Rp\s*)?([0-9.]+)/i);
                
                if (!nominalMatch) {
                    await sendTelegram(ADMIN_GROUP_ID, "❌ Gagal: Angka nominal tidak ditemukan!");
                    return res.status(200).send('OK');
                }

                const amount = parseInt(nominalMatch[1].replace(/\./g, ''));

                try {
                    const statusResult = await db.runTransaction(async (t) => {
                        const userRef = db.collection('users').doc(targetUid);
                        const userSnap = await t.get(userRef);
                        
                        if (!userSnap.exists) throw "User tidak ditemukan";

                        // --- PERBAIKAN 2: CEK STATUS TRANSAKSI (ANTI-DOUBLE) ---
                        const historyRef = userRef.collection('history');
                        const q = await historyRef.where('status', '==', 'Pending').limit(1).get();
                        
                        if (q.empty) {
                            return "ALREADY_PROCESSED"; // Transaksi sudah diproses Admin lain
                        }

                        const currentBal = userSnap.data().balance || 0;
                        const newBal = currentBal + amount;

                        // Eksekusi Update
                        t.update(userRef, { balance: newBal });
                        t.update(q.docs[0].ref, { 
                            status: 'Sukses', 
                            api_msg: 'Diterima via Bot Telegram',
                            balance_after: newBal 
                        });
                        
                        return "SUCCESS";
                    });

                    if (statusResult === "SUCCESS") {
                        await sendTelegram(ADMIN_GROUP_ID, `✅ <b>BERHASIL!</b>\nSaldo Rp ${amount.toLocaleString()} telah ditambahkan ke UID <code>${targetUid}</code>.`);
                    } else {
                        await sendTelegram(ADMIN_GROUP_ID, `⚠️ <b>PERINGATAN!</b>\nTransaksi untuk UID <code>${targetUid}</code> sudah diproses sebelumnya. Saldo tidak ditambahkan dua kali.`);
                    }

                } catch (err) {
                    await sendTelegram(ADMIN_GROUP_ID, `❌ <b>DATABASE ERROR:</b> ${err}`);
                }
            } 
            
            else if (action === 'reject') {
                const historyRef = db.collection('users').doc(targetUid).collection('history');
                const q = await historyRef.where('status', '==', 'Pending').limit(1).get();
                if (!q.empty) {
                    await q.docs[0].ref.update({ status: 'Gagal', api_msg: 'Ditolak via Telegram' });
                    await sendTelegram(ADMIN_GROUP_ID, `❌ Top Up UID <code>${targetUid}</code> telah DITOLAK.`);
                }
            }

            return res.status(200).send('OK');
        }

        // --- LOGIKA BALAS CHAT (REPLY) ---
        if (body.message && body.message.reply_to_message && body.message.chat.id.toString() === ADMIN_GROUP_ID) {
            const match = body.message.reply_to_message.text.match(/ID:\s*([A-Za-z0-9_-]+)/);
            if (match) {
                const uid = match[1];
                const replyText = body.message.text;
                await db.collection('chats').doc(uid).collection('messages').add({
                    text: replyText, sender: 'admin', timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                await db.collection('chats').doc(uid).set({
                    lastMessage: replyText, lastTimestamp: admin.firestore.FieldValue.serverTimestamp(), lastSender: 'admin'
                }, { merge: true });
                await sendTelegram(ADMIN_GROUP_ID, `✅ Balasan terkirim.`);
            }
        }
    } catch (e) { console.error("Global Error:", e); }
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
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: chatId, 
                message_id: messageId, 
                reply_markup: { inline_keyboard: [] } 
            })
        });
    } catch (e) { console.error("Gagal hapus tombol:", e); }
}