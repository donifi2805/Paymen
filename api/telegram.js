// api/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

// --- KONFIGURASI ---
const token = '8576099469:AAHxURiNMnVhWdLqHLlAoX7ayAVX6HsCSiY';

const firebaseConfig = {
    apiKey: "AIzaSyBnVxgxkS8InH1PQCMGe3cY8IvPqSN6dLo",
    authDomain: "ppob-3ea96.firebaseapp.com",
    projectId: "ppob-3ea96"
};

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;

const ALLOWED_ADMINS = ['doni888855519@gmail.com', 'suwarno8797@gmail.com'];

// --- LAYOUT TOMBOL MENU UTAMA ---
const mainMenu = {
    resize_keyboard: true,
    one_time_keyboard: false,
    keyboard: [
        [{ text: "📊 Dashboard" }, { text: "⏳ Pending Trx" }],
        [{ text: "🔍 Cari User" }, { text: "ℹ️ Status Bot" }],
        [{ text: "🚪 Logout" }]
    ]
};

// --- INISIALISASI ---
if (!admin.apps.length) {
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        console.error("CRITICAL: Service Account belum disetting di Vercel!");
    }
}
const db = admin.firestore();
const clientApp = initializeApp(firebaseConfig, 'clientBotApp');
const clientAuth = getAuth(clientApp);

const formatRp = (n) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);

// --- HANDLER UTAMA ---
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!serviceAccount) return res.status(500).send('Service Account Missing');

    const bot = new TelegramBot(token);
    const body = req.body;

    // A. HANDLE TOMBOL INLINE (ACC/TOLAK TRANSAKSI)
    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data; // Format: ACC_uid_trxid_amount
        
        // Cek Sesi
        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists || !sessionSnap.data().isLoggedIn) {
            await bot.answerCallbackQuery(query.id, { text: "Sesi habis. Login lagi." });
            return res.status(200).send('OK');
        }

        const [action, uid, trxId, amountStr] = data.split('_');

        try {
            if (action === 'ACC') {
                const amount = parseInt(amountStr);
                await db.runTransaction(async (t) => {
                    const userRef = db.collection('users').doc(uid);
                    const trxRef = userRef.collection('history').doc(trxId);
                    const uDoc = await t.get(userRef);
                    if (!uDoc.exists) throw "User hilang";

                    const newBal = (uDoc.data().balance || 0) + amount;
                    t.update(userRef, { balance: newBal });
                    t.update(trxRef, { 
                        status: 'Sukses', 
                        api_msg: 'Approved via Telegram Bot',
                        balance_after: newBal,
                        date_updated: new Date().toISOString()
                    });
                });
                await bot.sendMessage(chatId, `✅ Topup Rp ${formatRp(amountStr)} BERHASIL di-ACC.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } 
            else if (action === 'REJ') {
                await db.collection('users').doc(uid).collection('history').doc(trxId).update({
                    status: 'Gagal',
                    api_msg: 'Ditolak via Telegram Bot',
                    date_updated: new Date().toISOString()
                });
                await bot.sendMessage(chatId, `❌ Transaksi DITOLAK.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            }
            await bot.answerCallbackQuery(query.id);
        } catch (e) {
            await bot.sendMessage(chatId, `⚠️ Gagal: ${e.message}`);
        }
        return res.status(200).send('OK');
    }

    // B. HANDLE PESAN TEKS
    if (!body.message || !body.message.text) return res.status(200).send('OK');

    const chatId = body.message.chat.id;
    const text = body.message.text;
    const msgId = body.message.message_id;

    const sessionRef = db.collection('bot_sessions').doc(String(chatId));
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : { isLoggedIn: false };

    try {
        // --- LOGIC LOGOUT ---
        if (text === '/logout' || text === '🚪 Logout') {
            await sessionRef.delete();
            // Hapus keyboard saat logout
            await bot.sendMessage(chatId, "👋 Logout berhasil. Sampai jumpa!", {
                reply_markup: { remove_keyboard: true }
            });
            return res.status(200).send('OK');
        }

        // --- LOGIC START & LOGIN ---
        if (text === '/start') {
            if (session.isLoggedIn) {
                await bot.sendMessage(chatId, `Halo Admin! Menu siap digunakan.`, { reply_markup: mainMenu });
            } else {
                await bot.sendMessage(chatId, `🔐 *ADMIN LOGIN*\n\nSilakan login dengan format:\n\`/login email password\``, { parse_mode: 'Markdown' });
            }
        }
        else if (text.startsWith('/login')) {
            const parts = text.split(' ');
            if (parts.length !== 3) {
                await bot.sendMessage(chatId, "❌ Format salah. Gunakan: `/login email password`");
            } else {
                const email = parts[1];
                const password = parts[2];
                try { await bot.deleteMessage(chatId, msgId); } catch(e){}

                if (!ALLOWED_ADMINS.includes(email)) {
                    await bot.sendMessage(chatId, "⛔ Email tidak terdaftar.");
                    return res.status(200).send('OK');
                }

                try {
                    await signInWithEmailAndPassword(clientAuth, email, password);
                    await sessionRef.set({ isLoggedIn: true, email: email, loginAt: new Date().toISOString() });
                    
                    // TAMPILKAN KEYBOARD MENU UTAMA SETELAH LOGIN SUKSES
                    await bot.sendMessage(chatId, `✅ *Login Berhasil!*\nSelamat datang ${email}.`, { 
                        parse_mode: 'Markdown',
                        reply_markup: mainMenu 
                    });
                } catch (error) {
                    await bot.sendMessage(chatId, `❌ Password salah.`);
                }
            }
        }

        // --- PROTEKSI: HARUS LOGIN ---
        else if (!session.isLoggedIn) {
            await bot.sendMessage(chatId, "🔒 Akses ditolak. Ketik /start lalu login.");
        }

        // --- MENU: DASHBOARD ---
        else if (text === '/menu' || text === '/dashboard' || text === '📊 Dashboard') {
            const usersSnap = await db.collection('users').count().get();
            const pendingSnap = await db.collectionGroup('history').where('status', 'in', ['Pending', 'Proses']).count().get();
            
            let totalSaldo = 0;
            const allUsers = await db.collection('users').get();
            allUsers.forEach(d => totalSaldo += (d.data().balance || 0));

            const msg = `📊 *DASHBOARD REALTIME*\n` +
                        `-------------------\n` +
                        `👥 Total User: ${usersSnap.data().count}\n` +
                        `💰 Total Saldo: ${formatRp(totalSaldo)}\n` +
                        `⏳ Pending Trx: ${pendingSnap.data().count}\n` +
                        `-------------------`;
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: mainMenu });
        }

        // --- MENU: PENDING TRX ---
        else if (text === '/pending' || text === '⏳ Pending Trx') {
            const snapshot = await db.collectionGroup('history')
                .where('status', 'in', ['Pending', 'Proses'])
                .orderBy('date', 'desc')
                .limit(5)
                .get();

            if (snapshot.empty) {
                await bot.sendMessage(chatId, "✅ Tidak ada transaksi pending saat ini.", { reply_markup: mainMenu });
            } else {
                for (const doc of snapshot.docs) {
                    const d = doc.data();
                    const trxId = doc.id;
                    const uid = doc.ref.parent.parent.id;
                    const isTopup = d.type === 'in';
                    const icon = isTopup ? '📥 TOPUP' : '🛒 TRX';

                    const msg = `<b>${icon}</b>\nUser: <code>${uid}</code>\nItem: ${d.title}\nNominal: <b>${formatRp(d.amount)}</b>\nStatus: ${d.status}`;
                    
                    const buttons = [];
                    if (isTopup) buttons.push([{ text: "✅ ACC Topup", callback_data: `ACC_${uid}_${trxId}_${d.amount}` }]);
                    buttons.push([{ text: "❌ Tolak / Refund", callback_data: `REJ_${uid}_${trxId}_0` }]);

                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: buttons }
                    });
                }
                // Kirim pesan penutup agar keyboard tidak hilang
                await bot.sendMessage(chatId, "👆 Silakan proses transaksi di atas.", { reply_markup: mainMenu });
            }
        }
        
        // --- MENU: CARI USER ---
        else if (text === '🔍 Cari User') {
            await bot.sendMessage(chatId, "Untuk mencari user, ketik:\n\n`/cari [nama_atau_email]`\n\nContoh: `/cari doni`", { parse_mode: 'Markdown' });
        }
        else if (text.startsWith('/cari')) {
            const keyword = text.split(' ')[1];
            if (!keyword) {
                await bot.sendMessage(chatId, "Masukkan kata kunci. Contoh: `/cari doni`", { parse_mode: 'Markdown' });
            } else {
                const users = await db.collection('users').get();
                let found = "❌ User tidak ditemukan.";
                
                users.forEach(doc => {
                    const d = doc.data();
                    if ((d.email && d.email.includes(keyword)) || (d.username && d.username.includes(keyword))) {
                        found = `👤 <b>USER DITEMUKAN</b>\n\nNama: ${d.username}\nEmail: ${d.email}\nSaldo: ${formatRp(d.balance)}\nUID: <code>${doc.id}</code>`;
                    }
                });
                await bot.sendMessage(chatId, found, { parse_mode: 'HTML', reply_markup: mainMenu });
            }
        }

        // --- MENU: STATUS ---
        else if (text === 'ℹ️ Status Bot') {
            await bot.sendMessage(chatId, `🤖 Bot Aktif\nLogin sebagai: ${session.email}\nWaktu Server: ${new Date().toLocaleTimeString('id-ID')}`, { reply_markup: mainMenu });
        }

    } catch (error) {
        console.error("Bot Error:", error);
        await bot.sendMessage(chatId, "⚠️ Error System: " + error.message);
    }

    return res.status(200).send('OK');
}