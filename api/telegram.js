// api/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

// --- KONFIGURASI ---
// 1. TOKEN BOT (Hardcoded sesuai permintaan)
const token = '8576099469:AAHxURiNMnVhWdLqHLlAoX7ayAVX6HsCSiY';

// 2. CONFIG CLIENT (Untuk Login Password) - Dari paneladmin.html
const firebaseConfig = {
    apiKey: "AIzaSyBnVxgxkS8InH1PQCMGe3cY8IvPqSN6dLo",
    authDomain: "ppob-3ea96.firebaseapp.com",
    projectId: "ppob-3ea96"
};

// 3. SERVICE ACCOUNT (Wajib untuk Admin Database)
// Ambil dari Vercel Environment Variable: FIREBASE_SERVICE_ACCOUNT
// Jika belum disetting di Vercel, bot akan error saat baca DB.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;

const ALLOWED_ADMINS = ['doni888855519@gmail.com', 'suwarno8797@gmail.com'];

// --- INISIALISASI ---

// Init Firebase Admin (Database Access)
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

// Init Firebase Client (Auth Access)
const clientApp = initializeApp(firebaseConfig, 'clientBotApp');
const clientAuth = getAuth(clientApp);

// Helper Format Rupiah
const formatRp = (n) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);

// --- HANDLER UTAMA VERCEL ---
export default async function handler(req, res) {
    // Hanya terima method POST dari Telegram
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    // Pastikan Service Account ada
    if (!serviceAccount) {
        return res.status(500).send('Server Error: Firebase Service Account missing.');
    }

    const bot = new TelegramBot(token);
    const body = req.body;

    // A. HANDLE TOMBOL (CALLBACK QUERY)
    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data; // ACC_uid_trxid_amount
        
        // Cek Sesi Login
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
                // Hapus tombol agar tidak diklik 2x
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

    // Ambil Session
    const sessionRef = db.collection('bot_sessions').doc(String(chatId));
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : { isLoggedIn: false };

    try {
        // 1. COMMAND /start
        if (text === '/start') {
            if (session.isLoggedIn) {
                await bot.sendMessage(chatId, `Halo ${session.email}! Bot aktif.\nKetik /menu untuk opsi.`);
            } else {
                await bot.sendMessage(chatId, `🔐 *PANEL ADMIN BOT*\n\nSilakan login:\nFormat: \`/login email password\`\nContoh: \`/login admin@gmail.com 123456\``, { parse_mode: 'Markdown' });
            }
        }

        // 2. COMMAND /login
        else if (text.startsWith('/login')) {
            const parts = text.split(' ');
            if (parts.length !== 3) {
                await bot.sendMessage(chatId, "❌ Format salah. Gunakan: `/login email password`");
            } else {
                const email = parts[1];
                const password = parts[2];

                // Hapus pesan password secepatnya
                try { await bot.deleteMessage(chatId, msgId); } catch(e){}

                if (!ALLOWED_ADMINS.includes(email)) {
                    await bot.sendMessage(chatId, "⛔ Email tidak terdaftar sebagai Admin.");
                    return res.status(200).send('OK');
                }

                try {
                    // Verifikasi ke Firebase Auth
                    await signInWithEmailAndPassword(clientAuth, email, password);
                    
                    // Simpan sesi ke Firestore
                    await sessionRef.set({
                        isLoggedIn: true,
                        email: email,
                        loginAt: new Date().toISOString()
                    });

                    await bot.sendMessage(chatId, `✅ *Login Berhasil!*\nSelamat datang ${email}.\nKetik /menu`, { parse_mode: 'Markdown' });
                } catch (error) {
                    await bot.sendMessage(chatId, `❌ Gagal Login: Password salah atau user tidak ditemukan.`);
                }
            }
        }

        // 3. COMMAND /logout
        else if (text === '/logout') {
            await sessionRef.delete();
            await bot.sendMessage(chatId, "👋 Logout berhasil.");
        }

        // --- FILTER: Harus Login untuk perintah di bawah ini ---
        else if (!session.isLoggedIn) {
            await bot.sendMessage(chatId, "🔒 Akses ditolak. Silakan /login dulu.");
        }

        // 4. COMMAND /menu atau /dashboard
        else if (text === '/menu' || text === '/dashboard') {
            const usersSnap = await db.collection('users').count().get();
            const pendingSnap = await db.collectionGroup('history').where('status', 'in', ['Pending', 'Proses']).count().get();
            
            // Hitung Saldo Total
            let totalSaldo = 0;
            const allUsers = await db.collection('users').get();
            allUsers.forEach(d => totalSaldo += (d.data().balance || 0));

            const msg = `📊 *DASHBOARD*\n` +
                        `-------------------\n` +
                        `👥 Total User: ${usersSnap.data().count}\n` +
                        `💰 Total Saldo: ${formatRp(totalSaldo)}\n` +
                        `⏳ Pending Trx: ${pendingSnap.data().count}\n` +
                        `-------------------\n` +
                        `Ketik /pending untuk cek antrian.`;
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }

        // 5. COMMAND /pending
        else if (text === '/pending') {
            const snapshot = await db.collectionGroup('history')
                .where('status', 'in', ['Pending', 'Proses'])
                .orderBy('date', 'desc')
                .limit(5)
                .get();

            if (snapshot.empty) {
                await bot.sendMessage(chatId, "✅ Tidak ada transaksi pending.");
            } else {
                for (const doc of snapshot.docs) {
                    const d = doc.data();
                    const trxId = doc.id;
                    const uid = doc.ref.parent.parent.id;
                    const isTopup = d.type === 'in';
                    const icon = isTopup ? '📥 TOPUP' : '🛒 TRX';

                    const msg = `<b>${icon}</b>\nUser: <code>${uid}</code>\nItem: ${d.title}\nNominal: <b>${formatRp(d.amount)}</b>\nStatus: ${d.status}`;
                    
                    const buttons = [];
                    // Jika Topup, tampilkan tombol ACC
                    if (isTopup) {
                        buttons.push([{ text: "✅ ACC Topup", callback_data: `ACC_${uid}_${trxId}_${d.amount}` }]);
                    }
                    // Tombol Tolak selalu ada
                    buttons.push([{ text: "❌ Tolak / Refund", callback_data: `REJ_${uid}_${trxId}_0` }]);

                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: buttons }
                    });
                }
            }
        }

    } catch (error) {
        console.error("Bot Error:", error);
        await bot.sendMessage(chatId, "⚠️ Error System: " + error.message);
    }

    return res.status(200).send('OK');
}