// File: api/notif.js
const BOT_TOKEN = "8242866746:AAHdexZf8hZgM80AHY4tICn6gzevCgEquPw"; 
const ADMIN_ID = "7348139166"; 

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { message, sender, userId } = JSON.parse(req.body);

        // Format pesan agar mendukung Swipe Reply (Ada ID User)
        const text = `📩 <b>PESAN DARI WEBSITE</b>\n\n` +
                     `👤 <b>Nama:</b> ${sender || 'Pelanggan'}\n` +
                     `🆔 <b>ID:</b> <code>${userId || 'WEB_USER'}</code>\n\n` +
                     `💬 <b>Pesan:</b> "${message}"\n\n` +
                     `👉 <i>Swipe ke kiri untuk membalas ke website...</i>`;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                parse_mode: 'HTML'
            })
        });

        return res.status(200).json({ status: 'Sent' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}