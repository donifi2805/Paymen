// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Notif API Active');

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { message, sender, userId, type } = body;

        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_GROUP_ID = "-1003673877701"; 

        // Fungsi pembersih karakter HTML agar tidak error 400 Bad Request
        const escapeHTML = (str) => str.toString().replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));

        const safeMsg = escapeHTML(message || "");
        const safeSender = escapeHTML(sender || "User");

        let text = "";
        let replyMarkup = null;

        if (type === 'TOPUP_MANUAL') {
            text = `💰 <b>TOP UP MANUAL BARU</b>\n\n` +
                   `👤 User: ${safeSender}\n` +
                   `🆔 UID: <code>${userId}</code>\n` +
                   `💵 Nominal: <b>${safeMsg}</b>\n\n` +
                   `Konfirmasi sekarang?`;
            
            replyMarkup = {
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
                   `👉 <i>Swipe untuk balas ke user website</i>`;
        }

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_GROUP_ID,
                text: text,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            })
        });

        const resData = await response.json();
        if (!resData.ok) throw new Error(resData.description);

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Vercel Error:", e.message);
        return res.status(500).json({ error: e.message });
    }
}