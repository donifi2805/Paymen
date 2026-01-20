import admin from 'firebase-admin';

// ==========================================
// 1. KONFIGURASI (JANGAN SAMPAI SALAH)
// ==========================================
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; // ID Telegram Anda (Penerima Laporan)

// ==========================================
// 2. INISIALISASI FIREBASE (SAFE MODE)
// ==========================================
// Kita bungkus try-catch agar bot TIDAK MATI meskipun Firebase error
try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    }
} catch (e) {
    console.log("Info: Firebase init dilewati (Mode Chat Only)");
}

// ==========================================
// 3. LOGIC UTAMA BOT
// ==========================================
export default async function handler(req, res) {
    // A. Cek Method (Hanya terima POST dari Telegram)
    if (req.method !== 'POST') {
        return res.status(200).send('Bot CS Berjalan Aman. Gunakan Webhook.');
    }

    try {
        const body = req.body;

        // B. Pastikan ada pesan masuk
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || ''; // Handle jika user kirim stiker/gambar
            const name = body.message.chat.first_name || 'Kak';
            const username = body.message.chat.username ? `@${body.message.chat.username}` : 'Tanpa Username';

            // -----------------------------------------------------------
            // SKENARIO 1: ADMIN YANG CHAT (FITUR BALAS)
            // -----------------------------------------------------------
            if (chatId.toString() === ADMIN_ID) {
                // Cara pakai: /balas [ID_USER] [PESAN]
                if (text.startsWith('/balas ')) {
                    const args = text.split(' ');
                    const targetId = args[1]; // ID User tujuan
                    const replyMsg = args.slice(2).join(' '); // Isi Pesan

                    if (targetId && replyMsg) {
                        // 1. Kirim ke User
                        await sendMessage(targetId, `👨‍💻 <b>CS Pandawa:</b>\n${replyMsg}`);
                        
                        // 2. Konfirmasi ke Admin
                        await sendMessage(ADMIN_ID, `✅ <b>Terkirim ke user!</b>\nIsi: "${replyMsg}"`);
                    } else {
                        await sendMessage(ADMIN_ID, "⚠️ <b>Format Salah!</b>\nContoh: <code>/balas 123456 Halo kak</code>");
                    }
                } 
                // Jika Admin klik /start
                else if (text === '/start') {
                    await sendMessage(ADMIN_ID, "Halo Bos! 👋\nBot CS Siap. Tunggu pesan masuk dari user ya.");
                }
                // Jika Admin chat biasa (bukan command)
                else {
                    await sendMessage(ADMIN_ID, "Gunakan format <code>/balas ID PESAN</code> untuk membalas user.");
                }
            } 

            // -----------------------------------------------------------
            // SKENARIO 2: USER BIASA YANG CHAT (CUSTOMER)
            // -----------------------------------------------------------
            else {
                // Jika User baru klik START
                if (text === '/start') {
                    const welcomeMsg = `Halo <b>${name}</b>! 👋\n\n` +
                                     `Selamat datang di Layanan Pelanggan <b>Pandawa Store</b>.\n` +
                                     `Silakan tulis kendala atau pertanyaan Anda di sini. Admin kami akan segera membalas.`;
                    await sendMessage(chatId, welcomeMsg);
                    
                    // Notif ke Admin ada user baru
                    await sendMessage(ADMIN_ID, `🔔 <b>User Baru Klik Start</b>\nNama: ${name} (${username})`);
                } 
                // Jika User mengirim pesan chat/keluhan
                else {
                    // 1. Beritahu user pesan diterima
                    await sendMessage(chatId, "✅ Pesan diterima. Mohon tunggu, Admin sedang merespon.");

                    // 2. Teruskan pesan ke Admin (Anda)
                    // Kita buat formatnya mudah dicopy
                    const reportMsg = `📩 <b>PESAN DARI USER</b>\n\n` +
                                      `👤 <b>Nama:</b> ${name} (${username})\n` +
                                      `🆔 <b>ID:</b> <code>${chatId}</code>\n\n` +
                                      `📝 <b>Isi Pesan:</b>\n"${text}"\n\n` +
                                      `👇 <b>Klik ID dibawah untuk copy, lalu ketik:</b>\n` +
                                      `/balas ${chatId} (jawaban anda)`;
                    
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
// 4. FUNGSI KIRIM PESAN (Native Fetch)
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