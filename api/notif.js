// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(200).send('Notif API is Active. Use POST to send notifications.');
    }

    try {
        // Logika pembacaan body yang lebih aman
        let data;
        if (typeof req.body === 'string') {
            data = JSON.parse(req.body);
        } else {
            data = req.body;
        }

        const { message, sender, userId, type } = data;

        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_ID = "7348139166";

        let text = "";
        let replyMarkup = null;

        if (type === 'TOPUP_MANUAL') {
            text = `💰 <b>TOP UP MANUAL BARU</b>\n\n` +
                   `👤 User: <b>${sender || 'User'}</b>\n` +
                   `🆔 UID: <code>${userId}</code>\n` +
                   `💵 Nominal: <b>${message}</b>\n\n` +
                   `Konfirmasi transaksi ini?`;
            
            replyMarkup = {
                inline_keyboard: [[
                    { text: "✅ Terima", callback_data: `approve_${userId}` },
                    { text: "❌ Tolak", callback_data: `reject_${userId}` }
                ]]
            };
        } else {
            // FORMAT PESAN CHAT BIASA
            text = `📩 <b>PESAN BARU DARI WEB</b>\n\n` +
                   `👤 Nama: ${sender || 'Pelanggan'}\n` +
                   `🆔 ID: <code>${userId}</code>\n` +
                   `💬 Pesan: "${message}"\n\n` +
                   `👉 <i>Swipe untuk balas...</i>`;
        }

        // Kirim ke Telegram menggunakan fetch bawaan node
        const telegramRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            })
        });

        const telegramData = await telegramRes.json();

        if (!telegramData.ok) {
            console.error("Telegram API Error:", telegramData);
            return res.status(500).json({ error: telegramData.description });
        }

        return res.status(200).json({ ok: true });

    } catch (e) {
        console.error("Internal Server Error (api/notif):", e.message);
        return res.status(500).json({ error: e.message });
    }
}