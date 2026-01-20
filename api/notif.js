// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('API Aktif');

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { message, sender, userId, type } = body;

        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_ID = "7348139166";

        let text = "";
        let replyMarkup = null;

        if (type === 'TOPUP_MANUAL') {
            // Menggunakan teks polos tanpa tag HTML yang berisiko
            text = "💰 TOP UP MANUAL BARU\n\n" +
                   "User: " + (sender || 'User') + "\n" +
                   "UID: " + userId + "\n" +
                   "Nominal: " + message + "\n\n" +
                   "Konfirmasi di Panel Admin.";
            
            replyMarkup = {
                inline_keyboard: [[
                    { text: "✅ Terima", callback_data: `approve_${userId}` },
                    { text: "❌ Tolak", callback_data: `reject_${userId}` }
                ]]
            };
        } else {
            // Format teks polos agar tidak error parsing
            text = "📩 PESAN BARU DARI WEB\n\n" +
                   "Nama: " + (sender || 'Pelanggan') + "\n" +
                   "ID: " + userId + "\n" +
                   "Pesan: " + message + "\n\n" +
                   "Swipe pesan ini untuk membalas.";
        }

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                reply_markup: replyMarkup
                // Parse_mode sengaja dihapus agar Telegram tidak mencoba membaca tag HTML
            })
        });

        const resData = await response.json();
        
        if (!resData.ok) {
            console.error("Telegram Error Detail:", resData.description);
            return res.status(400).json({ error: resData.description });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Vercel Internal Error:", e.message);
        return res.status(500).json({ error: e.message });
    }
}