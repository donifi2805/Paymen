// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Notif API Active');

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { message, sender, userId, type } = body;

        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_ID = "7348139166";

        let text = "";
        let replyMarkup = null;

        if (type === 'TOPUP_MANUAL') {
            text = `💰 <b>TOP UP MANUAL BARU</b>\n\n👤 User: ${sender}\n🆔 UID: <code>${userId}</code>\n💵 Nominal: ${message}\n\nKonfirmasi sekarang?`;
            replyMarkup = {
                inline_keyboard: [[
                    { text: "✅ Terima", callback_data: `approve_${userId}` },
                    { text: "❌ Tolak", callback_data: `reject_${userId}` }
                ]]
            };
        } else {
            // FORMAT PENTING: Jangan ubah baris "🆔 ID:" karena cs.js membacanya untuk membalas
            text = `📩 <b>PESAN BARU DARI WEB</b>\n\n👤 Nama: ${sender}\n🆔 ID: <code>${userId}</code>\n💬 Pesan: "${message}"\n\n👉 Swipe untuk balas`;
        }

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            })
        });

        const resData = await response.json();
        if (!resData.ok) throw new Error(resData.description);

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Error sending to Telegram:", e.message);
        return res.status(500).json({ error: e.message });
    }
}