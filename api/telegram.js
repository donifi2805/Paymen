import admin from 'firebase-admin';

// --- KONFIGURASI HARDCODED (Sesuai Request) ---
// PERINGATAN: Jangan upload file ini ke repo publik jika token masih menempel!
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

// --- INISIALISASI FIREBASE ADMIN ---
// Kita gunakan try-catch agar bot tidak crash total jika firebase belum disetting
try {
    if (!admin.apps.length) {
        // OPSI 1: Cara Paling Aman (Disarankan pakai Env Var di Vercel)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log("Firebase initialized via Env Var");
        } 
        // OPSI 2: Jika Anda ingin hardcode JSON Firebase juga (Hanya untuk test lokal/dev)
        // Uncomment bagian bawah ini dan paste isi file JSON service account Anda
        /*
        else {
            const serviceAccount = {
                "type": "service_account",
                "project_id": "...",
                "private_key_id": "...",
                "private_key": "-----BEGIN PRIVATE KEY-----...",
                "client_email": "...",
                "client_id": "...",
                "auth_uri": "...",
                "token_uri": "...",
                "auth_provider_x509_cert_url": "...",
                "client_x509_cert_url": "..."
            };
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        */
    }
} catch (e) {
    console.error("Gagal init Firebase:", e);
    // Kita lanjut saja agar fitur reply bot tetap jalan meski tanpa database
}

// --- LOGIC UTAMA ---
export default async function handler(req, res) {
    // 1. Cek Method (Hanya POST dari Telegram yang diterima)
    if (req.method !== 'POST') {
        return res.status(200).json({ 
            status: 'Active', 
            message: 'Bot is running. Please use POST method from Telegram Webhook.' 
        });
    }

    try {
        const body = req.body;

        // 2. Validasi apakah ada pesan masuk
        if (body.message) {
            const chatId = body.message.chat.id;
            const text = body.message.text || ''; // Bisa jadi user kirim stiker/foto
            const username = body.message.chat.username || 'User';
            const firstName = body.message.chat.first_name || 'Kawan';

            console.log(`Pesan dari ${firstName} (${chatId}): ${text}`);

            // --- AREA CUSTOM LOGIC ANDA ---
            
            if (text === '/start') {
                const welcomeMsg = `Halo <b>${firstName}</b>! 👋\n` +
                                   `Selamat datang di Bot Pengembangan Paymen.\n` +
                                   `ID Telegram kamu: <code>${chatId}</code>\n\n` +
                                   `Ketik /help untuk bantuan.`;
                
                await sendMessage(chatId, welcomeMsg);
                
                // Lapor ke Admin (Anda) jika yang chat BUKAN Anda
                if (chatId.toString() !== ADMIN_ID) {
                    await sendMessage(ADMIN_ID, `🔔 <b>User Baru Masuk!</b>\nNama: ${firstName}\nUser: @${username}\nID: <code>${chatId}</code>`);
                }

            } else if (text === '/help') {
                await sendMessage(chatId, "🛠 <b>Menu Bantuan:</b>\n/start - Mulai bot\n/id - Cek ID Telegram\n/status - Cek status server (dummy)");

            } else if (text === '/id') {
                await sendMessage(chatId, `ID Anda: <code>${chatId}</code>`);

            } else {
                // Echo (Balas apa adanya) atau Logic Default
                // Bisa dihapus jika ingin bot diam saja kalau command tidak dikenal
                await sendMessage(chatId, `Anda berkata: "${text}"\n\n<i>Pesan ini dibalas otomatis oleh Vercel.</i>`);
            }
        }

        // 3. Wajib Return 200 OK ke Telegram
        return res.status(200).send('OK');

    } catch (error) {
        console.error('Error di handler bot:', error);
        // Tetap kirim 200 agar Telegram tidak mengulang kirim pesan (retry loop)
        return res.status(200).send('Error handled');
    }
}

// --- FUNGSI KIRIM PESAN (Helper) ---
async function sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML' // Bisa pakai <b>bold</b>, <i>italic</i>, <code>code</code>
            })
        });
        const result = await response.json();
        if(!result.ok) {
            console.error("Gagal kirim ke Telegram:", result);
        }
    } catch (err) {
        console.error("Fetch Error:", err);
    }
}