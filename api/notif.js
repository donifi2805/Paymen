// api/notif.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Notif API Active');

    try {
        const { message, sender, userId, type } = JSON.parse(req.body);
        const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw";
        const ADMIN_ID = "7348139166";

        let text = "";
        let replyMarkup = null;

        // SKENARIO A: Notifikasi Top Up Manual
        if (type === 'TOPUP_MANUAL') {
            text = `💰 <b>TOP UP MANUAL BARU</b>\n\n` +
                   `👤 <b>User:</b> ${sender}\n` +
                   `🆔 <b>UID:</b> <code>${userId}</code>\n` +
                   `💵 <b>Nominal:</b> ${message}\n\n` +
                   `Silakan cek mutasi Seabank Anda.\nKonfirmasi transaksi ini?`;
            
            replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "✅ Terima (Proses)", callback_data: `approve_${userId}` },
                        { text: "❌ Tolak", callback_data: `reject_${userId}` }
                    ],
                    [{ text: "🖥️ Buka Panel Admin", url: "https://www.pandawa-digital.store/paneladmin" }]
                ]
            };
        } 
        // SKENARIO B: Notifikasi Chat CS Biasa
        else {
            text = `📩 <b>PESAN DARI WEBSITE</b>\n\n` +
                   `👤 <b>Nama:</b> ${sender}\n` +
                   `🆔 <b>ID:</b> <code>${userId}</code>\n\n` +
                   `💬 <b>Pesan:</b> "${message}"\n\n` +
                   `👉 <i>Swipe ke kiri untuk membalas...</i>`;
        }

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            })
        });

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Notif Error:", e);
        return res.status(500).json({ error: e.message });
    }
}