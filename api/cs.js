import admin from 'firebase-admin';

const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_GROUP_ID = "-1003673877701"; 

if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
    } catch (e) { console.error("Firebase Init Error:", e); }
}
const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot Active');

    const body = req.body;
    console.log("Incoming Telegram Body:", JSON.stringify(body)); // CEK DI VERCEL LOGS

    try {
        // --- HANDLER CALLBACK (TOMBOL) ---
        if (body.callback_query) {
            const cb = body.callback_query;
            const [action, targetUid] = cb.data.split('_');
            
            // Ambil nominal dari teks pesan
            const msgText = cb.message.text || "";
            const nominalMatch = msgText.match(/Nominal:\s*Rp\s*([0-9.]+)/i);
            const amount = nominalMatch ? parseInt(nominalMatch[1].replace(/\./g, '')) : 0;

            if (action === 'approve') {
                await db.runTransaction(async (t) => {
                    const userRef = db.collection('users').doc(targetUid);
                    const userSnap = await t.get(userRef);
                    if (!userSnap.exists) throw "User tidak ditemukan";
                    const newBal = (userSnap.data().balance || 0) + amount;
                    t.update(userRef, { balance: newBal });
                    const historyRef = userRef.collection('history');
                    const q = await historyRef.where('status', '==', 'Pending').limit(1).get();
                    if (!q.empty) t.update(q.docs[0].ref, { status: 'Sukses', api_msg: 'Diterima via Bot', balance_after: newBal });
                });
                await sendTelegram(ADMIN_GROUP_ID, `✅ Berhasil Tambah Saldo ke <code>${targetUid}</code>`);
            } else {
                await sendTelegram(ADMIN_GROUP_ID, `❌ Transaksi UID <code>${targetUid}</code> Ditolak.`);
            }
            return res.status(200).send('OK');
        }

        // --- HANDLER MESSAGE (CHAT/REPLY) ---
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';

            // Respon wajib untuk tes awal
            if (text === '/cek') {
                await sendTelegram(chatId, `Bot Aktif! ID Chat ini: <code>${chatId}</code>`);
                return res.status(200).send('OK');
            }

            // Logika Balas Pesan (Swipe)
            if (chatId === ADMIN_GROUP_ID && msg.reply_to_message) {
                const match = msg.reply_to_message.text.match(/ID:\s*([A-Za-z0-9_-]+)/);
                if (match && match[1]) {
                    const uid = match[1];
                    await db.collection('chats').doc(uid).collection('messages').add({
                        text: text, sender: 'admin', timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                    await db.collection('chats').doc(uid).set({
                        lastMessage: text, lastTimestamp: admin.firestore.FieldValue.serverTimestamp(), lastSender: 'admin'
                    }, { merge: true });
                    await sendTelegram(ADMIN_GROUP_ID, `✅ Pesan terkirim ke Web User.`);
                }
            }
        }
    } catch (err) {
        console.error("Handler Error:", err);
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