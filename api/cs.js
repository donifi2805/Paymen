import admin from 'firebase-admin';

// ==========================================
// 1. KONFIGURASI
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda

// ==========================================
// 2. INISIALISASI FIREBASE (WAJIB)
// ==========================================
// Bot harus login ke Database agar bisa simpan chat
if (!admin.apps.length) {
    try {
        // Pastikan Anda sudah set FIREBASE_SERVICE_ACCOUNT di Vercel Environment Variables
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log("🔥 Firebase Admin Connected!");
        } else {
            console.error("❌ FIREBASE_SERVICE_ACCOUNT belum disetting di Vercel!");
        }
    } catch (e) {
        console.error("Firebase Init Error:", e);
    }
}

// Inisialisasi Database
const db = admin.firestore();

// ==========================================
// 3. LOGIC UTAMA (HANDLER)
// ==========================================
export default async function handler(req, res) {
    // Cek Method
    if (req.method !== 'POST') return res.status(200).send('CS Bot Ready & Connected to DB');

    try {
        const body = req.body;
        
        if (body.message) {
            const msg = body.message;
            const chatId = msg.chat.id;
            const text = msg.text || '(Stiker/Gambar)';
            const name = msg.chat.first_name || 'User';
            const username = msg.chat.username ? `@${msg.chat.username}` : '-';

            // -----------------------------------------------------------
            // A. JIKA ADMIN MEMBALAS (/balas ID PESAN)
            // -----------------------------------------------------------
            if (chatId.toString() === ADMIN_ID && text.startsWith('/balas ')) {
                const args = text.split(' ');
                const targetId = args[1]; // ID User Tujuan
                const replyMsg = args.slice(2).join(' '); // Isi Pesan

                if (targetId && replyMsg) {
                    // 1. Kirim ke Telegram User
                    await sendMessage(targetId, `👨‍💻 <b>CS Admin:</b>\n${replyMsg}`);
                    
                    // 2. SIMPAN KE FIREBASE (Agar muncul di Website/Panel)
                    // Kita simpan di collection 'chats' (Sesuaikan jika nama tabel di index.html beda)
                    await db.collection('chats').add({
                        userId: targetId.toString(),  // ID Telegram sebagai User ID
                        sender: 'admin',              // Penanda bahwa ini dari Admin
                        message: replyMsg,
                        name: 'Admin Support',
                        timestamp: new Date().toISOString(), // Waktu Server
                        read: true,
                        source: 'telegram_bot'        // Info tambahan
                    });

                    // 3. Konfirmasi ke Admin
                    await sendMessage(ADMIN_ID, `✅ Terkirim ke ${targetId} & Database.`);
                } else {
                    await sendMessage(ADMIN_ID, "⚠️ Format Salah. Gunakan: <code>/balas [ID] [PESAN]</code>");
                }
            } 
            
            // -----------------------------------------------------------
            // B. JIKA USER BIASA CHAT (DARI TELEGRAM)
            // -----------------------------------------------------------
            else if (chatId.toString() !== ADMIN_ID) {
                
                // 1. SIMPAN KE FIREBASE (Agar masuk ke Panel Admin Anda)
                // Ini membuat chat dari Telegram terlihat seperti chat dari Website
                await db.collection('chats').add({
                    userId: chatId.toString(),
                    sender: 'user',           // Penanda dari User
                    message: text,
                    name: `${name} (Telegram)`, // Tambahkan info Telegram agar admin tau
                    username: username,
                    timestamp: new Date().toISOString(),
                    read: false,              // Tandai belum dibaca admin
                    source: 'telegram'
                });

                // 2. Auto Reply ke Telegram User
                if (text === '/start') {
                    await sendMessage(chatId, `Halo ${name}! 👋\nSelamat datang di Support Center.\nSilakan ketik pesan Anda, Admin kami akan membalas secepatnya.`);
                } else {
                    // Feedback bahwa pesan masuk
                    // await sendMessage(chatId, "✅ Pesan diterima sistem."); 
                    // (Opsional: dimatikan agar tidak spamming, nyalakan jika perlu)
                }

                // 3. Notifikasi ke Telegram Admin (Supaya HP Anda bunyi)
                const laporMsg = `📩 <b>CHAT BARU (VIA TELEGRAM)</b>\n\n` +
                                 `👤 <b>Nama:</b> ${name}\n` +
                                 `🆔 <b>ID:</b> <code>${chatId}</code>\n` +
                                 `💬 <b>Pesan:</b> "${text}"\n\n` +
                                 `👉 <b>Jawab:</b> <code>/balas ${chatId} pesan...</code>`;
                
                await sendMessage(ADMIN_ID, laporMsg);
            }
        }
    } catch (error) {
        console.error("Handler Error:", error);
    }

    return res.status(200).send('OK');
}

// Helper Kirim Pesan
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
    } catch (e) {
        console.error("Send Telegram Error:", e);
    }
}