import admin from 'firebase-admin';

// ==========================================
// 1. KONFIGURASI
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda

// ==========================================
// 2. INISIALISASI FIREBASE
// ==========================================
// Bot butuh akses database untuk sinkron dengan Website/Panel Admin
let db; // Variabel global untuk database
try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log("🔥 Firebase Connected!");
        } else {
            console.log("⚠️ FIREBASE_SERVICE_ACCOUNT tidak ditemukan di Vercel Env!");
        }
    }
    db = admin.firestore();
} catch (e) {
    console.error("Firebase Init Error:", e);
    // Kita biarkan db undefined jika error, nanti kita cek di bawah
}

// ==========================================
// 3. LOGIC UTAMA
// ==========================================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('CS Bot Ready');

    try {
        const body = req.body;
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id.toString(); // Pastikan string agar aman bandingkan
            const text = msg.text || '(Stiker/Gambar)';
            const name = msg.chat.first_name || 'User';

            // -----------------------------------------------------------
            // A. JIKA YANG CHAT ADALAH ANDA (ADMIN)
            // -----------------------------------------------------------
            if (chatId === ADMIN_ID) {
                // Skenario 1: Admin klik /start
                if (text === '/start') {
                    await sendMessage(chatId, `👮‍♂️ <b>Halo Bos!</b>\n\nBot CS Siap & Terkoneksi Database.\nTunggu pesan dari user, lalu gunakan perintah:\n<code>/balas ID PESAN</code> untuk membalas.`);
                }
                // Skenario 2: Admin membalas pesan user
                else if (text.startsWith('/balas ')) {
                    const args = text.split(' ');
                    const targetId = args[1];
                    const replyMsg = args.slice(2).join(' ');

                    if (targetId && replyMsg) {
                        // 1. Kirim ke User di Telegram
                        await sendMessage(targetId, `👨‍💻 <b>CS Admin:</b>\n${replyMsg}`);
                        
                        // 2. Simpan ke Firebase (Agar muncul di Website/Panel)
                        if (db) {
                            await db.collection('chats').add({
                                userId: targetId,
                                sender: 'admin',
                                message: replyMsg,
                                name: 'Admin Support',
                                timestamp: new Date().toISOString(),
                                read: true,
                                source: 'telegram_bot'
                            });
                        }

                        await sendMessage(ADMIN_ID, `✅ Terkirim ke User & Database.`);
                    } else {
                        await sendMessage(ADMIN_ID, "⚠️ Format Salah. Gunakan: <code>/balas [ID] [PESAN]</code>");
                    }
                }
                // Skenario 3: Admin chat iseng / salah format
                else {
                    await sendMessage(ADMIN_ID, "🤖 Saya hanya mengerti perintah <code>/start</code> dan <code>/balas</code>.");
                }
            } 

            // -----------------------------------------------------------
            // B. JIKA YANG CHAT ADALAH USER (PELANGGAN)
            // -----------------------------------------------------------
            else {
                // 1. Simpan ke Firebase (Agar masuk Panel Admin)
                if (db) {
                    await db.collection('chats').add({
                        userId: chatId,
                        sender: 'user',
                        message: text,
                        name: `${name} (Telegram)`,
                        timestamp: new Date().toISOString(),
                        read: false,
                        source: 'telegram'
                    });
                }

                // 2. Notif ke Admin
                const lapor = `📩 <b>CHAT BARU</b>\nUser: ${name}\nMsg: "${text}"\n\n👉 <code>/balas ${chatId} pesan...</code>`;
                await sendMessage(ADMIN_ID, lapor);

                // 3. Respon ke User
                if (text === '/start') {
                    await sendMessage(chatId, `Halo ${name}! 👋\nSelamat datang di Pandawa Store.\nAdmin kami akan segera membalas pesan Anda.`);
                } else {
                    // Feedback agar user tau pesan terkirim (Opsional)
                    // await sendMessage(chatId, "✅ Pesan masuk antrian admin.");
                }
            }
        }
    } catch (error) {
        console.error("Handler Error:", error);
    }

    return res.status(200).send('OK');
}

// Helper Function
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
    } catch (e) {
        console.error("Telegram Send Error:", e);
    }
}