import admin from 'firebase-admin';

// ==========================================
// 1. KONFIGURASI BOT & ADMIN
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda

// ==========================================
// 2. INISIALISASI FIREBASE (SAFE MODE)
// ==========================================
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (e) {
        console.error("Firebase Init Error:", e);
    }
}
const db = admin.firestore();

// ==========================================
// 3. LOGIC UTAMA (WEBHOOK HANDLER)
// ==========================================
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(200).send('Bot CS Swipe Reply Ready');
    }

    try {
        const body = req.body;
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString();
            const text = msg.text || '';
            const name = msg.chat.first_name || 'User';
            const username = msg.chat.username ? `@${msg.chat.username}` : '-';

            // -----------------------------------------------------------
            // SKENARIO A: ADMIN MEMBALAS (VIA SWIPE/REPLY)
            // -----------------------------------------------------------
            if (chatId === ADMIN_ID && msg.reply_to_message) {
                const replyToText = msg.reply_to_message.text || '';
                
                // Cari ID User di dalam pesan laporan menggunakan Regex
                // Mendukung format: 🆔 ID: 12345 atau 🆔 ID: <code>12345</code>
                const match = replyToText.match(/🆔 ID: (\d+)/) || replyToText.match(/🆔 ID: <code>(\d+)<\/code>/);
                
                if (match && match[1]) {
                    const targetUserId = match[1];
                    const replyMsg = text;

                    // 1. Kirim pesan ke User via Telegram
                    await sendTelegram(targetUserId, `👨‍💻 <b>Admin CS:</b>\n${replyMsg}`);
                    
                    // 2. Simpan balasan ke Firebase (Agar muncul di history website)
                    if (db) {
                        await db.collection('chats').add({
                            userId: targetUserId,
                            sender: 'admin',
                            message: replyMsg,
                            name: 'Admin Support',
                            timestamp: new Date().toISOString(),
                            read: true,
                            source: 'telegram_swipe'
                        });
                    }

                    // 3. Notifikasi Sukses ke Admin
                    await sendTelegram(ADMIN_ID, `✅ Terkirim ke <code>${targetUserId}</code>`);
                    return res.status(200).send('OK');
                }
            }

            // -----------------------------------------------------------
            // SKENARIO B: ADMIN MENGETIK /START ATAU MANUAL BALAS
            // -----------------------------------------------------------
            if (chatId === ADMIN_ID) {
                if (text === '/start') {
                    await sendTelegram(ADMIN_ID, `👮‍♂️ <b>Halo Bos!</b>\n\nBot CS Aktif.\n\n<b>Cara Balas:</b>\nCukup <b>Swipe ke Kiri</b> (Reply) pada pesan laporan user yang masuk, lalu ketik balasan Anda.`);
                } else if (text.startsWith('/balas ')) {
                    const args = text.split(' ');
                    const targetId = args[1];
                    const replyMsg = args.slice(2).join(' ');
                    if (targetId && replyMsg) {
                        await sendTelegram(targetId, `👨‍💻 <b>Admin CS:</b>\n${replyMsg}`);
                        await sendTelegram(ADMIN_ID, `✅ Terkirim manual.`);
                    }
                }
                return res.status(200).send('OK');
            }

            // -----------------------------------------------------------
            // SKENARIO C: USER TELEGRAM CHAT KE BOT
            // -----------------------------------------------------------
            if (chatId !== ADMIN_ID) {
                // 1. Simpan ke Database Firebase
                if (db) {
                    await db.collection('chats').add({
                        userId: chatId,
                        sender: 'user',
                        message: text,
                        name: `${name} (Telegram)`,
                        username: username,
                        timestamp: new Date().toISOString(),
                        read: false,
                        source: 'telegram'
                    });
                }

                // 2. Kirim Laporan ke Admin (PENTING: Format ID jangan diubah agar Swipe Reply jalan)
                const reportMsg = `📩 <b>PESAN BARU (CS)</b>\n\n` +
                                  `👤 <b>User:</b> ${name} (${username})\n` +
                                  `🆔 <b>ID:</b> <code>${chatId}</code>\n\n` +
                                  `💬 <b>Pesan:</b>\n"${text}"\n\n` +
                                  `👉 <i>Swipe ke kiri pesan ini untuk membalas...</i>`;
                
                await sendTelegram(ADMIN_ID, reportMsg);

                // 3. Respon ke User jika klik /start
                if (text === '/start') {
                    await sendTelegram(chatId, `Halo <b>${name}</b>! 👋\nAda yang bisa kami bantu? Silakan tulis pesan Anda di sini.`);
                }
            }
        }
    } catch (error) {
        console.error("Critical Error:", error);
    }

    return res.status(200).send('OK');
}

// ==========================================
// HELPER: SEND TELEGRAM MESSAGE
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
    } catch (e) {
        console.error("Fetch Error:", e);
    }
}