// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('API Aktif');

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { message, sender, userId, type } = body;

        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_ID = "7348139166";

        let text = "";
        let payload = {
            chat_id: ADMIN_ID,
            parse_mode: 'HTML' // Kita aktifkan kembali tapi dengan proteksi karakter
        };

        // Fungsi pembersih karakter HTML agar tidak error 400
        const escapeHTML = (str) => str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));

        const safeMsg = escapeHTML(message || "");
        const safeSender = escapeHTML(sender || "User");

        if (type === 'TOPUP_MANUAL') {
            text = `💰 <b>TOP UP MANUAL BARU</b>\n\n` +
                   `👤 User: ${safeSender}\n` +
                   `🆔 UID: <code>${userId}</code>\n` +
                   `💵 Nominal: ${safeMsg}\n\n` +
                   `Konfirmasi di Panel Admin.`;
            
            // Format Objek Reply Markup yang benar
            payload.reply_markup = {
                inline_keyboard: [[
                    { text: "✅ Terima", callback_data: `approve_${userId}` },
                    { text: "❌ Tolak", callback_data: `reject_${userId}` }
                ]]
            };
        } else {
            text = `📩 <b>PESAN BARU DARI WEB</b>\n\n` +
                   `👤 Nama: ${safeSender}\n` +
                   `🆔 ID: <code>${userId}</code>\n` +
                   `💬 Pesan: "${safeMsg}"\n\n` +
                   `👉 Swipe pesan ini untuk membalas.`;
        }

        payload.text = text;

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resData = await response.json();
        
        if (!resData.ok) {
            console.error("Telegram Rejection:", resData.description);
            return res.status(400).json({ error: resData.description });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Vercel Error:", e.message);
        return res.status(500).json({ error: e.message });
    }
}