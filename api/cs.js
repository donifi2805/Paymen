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
        // --- LOGIKA TOMBOL ---
        if (body.callback_query) {
            const cb = body.callback_query;
            const [action, targetUid] = cb.data.split('_');
            const chatId = cb.message.chat.id.toString();

            if (chatId !== ADMIN_GROUP_ID) return res.status(200).send('Unauthorized');

            if (action === 'approve') {
                // Logika Approve (Saldo)
                const msgText = cb.message.text || "";
                const nominalMatch = msgText.match(/Nominal:\s*([0-9.]+)/i);
                const amount = nominalMatch ? parseInt(nominalMatch[1].replace(/\./g, '')) : 0;

                await db.runTransaction(async (t) => {
                    const userRef = db.collection('users').doc(targetUid);
                    const userSnap = await t.get(userRef);
                    const newBal = (userSnap.data().balance || 0) + amount;
                    t.update(userRef, { balance: newBal });
                    
                    const historyRef = userRef.collection('history');
                    const q = await historyRef.where('status', '==', 'Pending').limit(1).get();
                    if (!q.empty) t.update(q.docs[0].ref, { status: 'Sukses', balance_after: newBal });
                });
                await sendTelegram(ADMIN_GROUP_ID, `✅ Berhasil Disetujui untuk UID: <code>${targetUid}</code>`);
            } 
            
            else if (action === 'reject') {
                // FIX: LOGIKA TOLAK
                const historyRef = db.collection('users').doc(targetUid).collection('history');
                const q = await historyRef.where('status', '==', 'Pending').limit(1).get();
                
                if (!q.empty) {
                    await q.docs[0].ref.update({ 
                        status: 'Gagal', 
                        api_msg: 'Ditolak oleh Admin via Telegram' 
                    });
                    await sendTelegram(ADMIN_GROUP_ID, `❌ Top Up UID <code>${targetUid}</code> telah <b>DITOLAK</b>.`);
                } else {
                    await sendTelegram(ADMIN_GROUP_ID, `⚠️ Gagal menolak: Tidak ditemukan transaksi Pending untuk UID <code>${targetUid}</code>.`);
                }
            }

            // Hapus tombol setelah diklik
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: ADMIN_GROUP_ID, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } })
            });
            return res.status(200).send('OK');
        }

        // --- LOGIKA PESAN (REPLY) ---
        if (body.message && body.message.reply_to_message && body.message.chat.id.toString() === ADMIN_GROUP_ID) {
            const match = body.message.reply_to_message.text.match(/ID:\s*([A-Za-z0-9_-]+)/);
            if (match) {
                const uid = match[1];
                await db.collection('chats').doc(uid).collection('messages').add({
                    text: body.message.text, sender: 'admin', timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                await sendTelegram(ADMIN_GROUP_ID, `✅ Balasan terkirim.`);
            }
        }
    } catch (e) { console.error(e); }
    return res.status(200).send('OK');
}

async function sendTelegram(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}