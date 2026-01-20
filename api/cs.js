import admin from 'firebase-admin';

// ==========================================
// KONFIGURASI BOT (CS / CUSTOMER SERVICE)
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda

// ==========================================
// INISIALISASI FIREBASE (SAFE MODE)
// ==========================================
// Kita bungkus try-catch agar bot TIDAK MATI meskipun Firebase error/belum disetting
try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    }
} catch (e) {
    console.log("Firebase init dilewati (Bot tetap berjalan mode chat saja)");
}

// ==========================================
// LOGIC UTAMA
// ==========================================
export default async function handler(req, res) {
    // 1. Cek Method (Hanya terima POST dari Telegram)
    if (req.method !== 'POST') {
        return res.status(200).send('Bot CS Berjalan Aman. Gunakan Webhook.');
    }

    try {
        const body = req.body;

        // 2. Pastikan ada pesan masuk
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || ''; // Menghindari error jika user kirim stiker
            const name = body.message.chat.first_name || 'Kak';
            const username = body.message.chat.username ? `@${body.message.chat.username}` : 'No Username';

            // -----------------------------------------------------------
            // A. AREA KHUSUS ADMIN (FITUR BALAS PESAN)
            // -----------------------------------------------------------
            if (chatId.toString() === ADMIN_ID) {
                // Format: /balas [ID_USER] [PESAN]
                if (text.startsWith('/balas ')) {
                    const args = text.split(' ');
                    const targetId = args[1]; // ID User
                    const replyMsg = args.slice(2).join(' '); // Isi Pesan

                    if (targetId && replyMsg) {
                        // Kirim ke User
                        await sendMessage(targetId, `👨‍💻 <b>Admin CS:</b>\n${replyMsg}`);
                        // Konfirmasi ke Admin
                        await sendMessage(ADMIN_ID, `✅ <b>Terkirim ke ${targetId}:</b>\n"${replyMsg}"`);
                    } else {
                        await sendMessage(ADMIN_ID, "⚠️ <b>Format Salah!</b>\nContoh: <code>/balas 123456 Halo kak</code>");
                    }
                } else if (text === '/start') {
                    await sendMessage(ADMIN_ID, "Halo Bos! 👋\nIni bot CS. Tunggu pesan dari user, lalu gunakan <code>/balas ID pesan</code> untuk menjawab.");
                }
            } 

            // -----------------------------------------------------------
            // B. AREA USER (CUSTOMER)
            // -----------------------------------------------------------
            else {
                // Jika User baru klik START
                if (text === '/start') {
                    const welcomeMsg = `Halo <b>${name}</b>! 👋\n\n` +
                                     `Selamat datang di Layanan Pelanggan <b>Pandawa Store</b>.\n` +
                                     `Silakan tulis kendala atau pertanyaan Anda di sini. Admin kami akan segera membalas.`;
                    await sendMessage(chatId, welcomeMsg);
                } 
                // Jika User mengirim pesan chat
                else {
                    // 1. Beritahu user pesan diterima
                    await sendMessage(chatId, "✅ Pesan diterima. Mohon tunggu, Admin sedang merespon.");

                    // 2. Teruskan pesan ke Admin (Anda)
                    const reportMsg = `📩 <b>PESAN BARU (CS)</b>\n\n` +
                                      `👤 <b>Dari:</b> ${name} (${username})\n` +
                                      `🆔 <b>ID:</b> <code>${chatId}</code>\n\n` +
                                      `📝 <b>Isi Pesan:</b>\n"${text}"\n\n` +
                                      `👇 <b>Klik ID dibawah untuk copy, lalu balas:</b>\n` +
                                      `/balas ${chatId} (ketik jawaban disini)`;
                    
                    await sendMessage(ADMIN_ID, reportMsg);
                }
            }
        }
    } catch (error) {
        console.error("Error di Handler:", error);
    }

    // Wajib return 200 OK agar Telegram tidak spam retry
    return res.status(200).send('OK');
}

// ==========================================
// FUNGSI HELPER KIRIM PESAN
// ==========================================
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML' // Agar bisa pakai bold/code
            })
        });
    } catch (e) {
        console.error("Gagal kirim pesan:", e);
    }
}
